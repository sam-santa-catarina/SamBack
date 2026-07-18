import { Request, Response } from "express";
import supabase from "../database";
import { logError } from "../utils/logError";
import { logAudit } from "../utils/logAudit";
import { ID_ROL_ADMINISTRADOR, ID_ROL_SUPERVISOR } from "../constants/rolesUsuario";
import * as XLSX from "xlsx";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const CURP_MIN_CHARS_BUSQUEDA = 3;

// Helpers de limpieza y validación
function limpiarNombre(str: string): string {
    return str.trim().replace(/\s+/g, ' ');
}

function esNombreValido(nombre: string): boolean {
    if (!nombre) return false;
    const limpio = limpiarNombre(nombre);
    if (limpio.length < 2 || limpio.length > 100) return false;
    return /^[A-Za-zÁÉÍÓÚáéíóúÜüÑñ'\- ]+$/.test(limpio);
}

function validarCURP(curp: string): boolean {
    if (!curp) return false;
    const normalizado = curp.trim().toUpperCase();
    return /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(normalizado);
}

function limpiarTextoLibre(texto: string | undefined | null): string | null {
    if (texto === undefined || texto === null) return null;
    const limpio = texto.trim().replace(/\s+/g, ' ');
    return limpio === '' ? null : limpio;
}

function validarFechaDDMMYYYY(fecha: string | undefined): string | null {
    if (!fecha) return null;
    const limpio = fecha.trim();
    if (limpio === '') return null;
    const regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
    if (!regex.test(limpio)) return null;
    const [diaStr, mesStr, añoStr] = limpio.split('/');
    if (!diaStr || !mesStr || !añoStr) return null;
    const dia = parseInt(diaStr, 10);
    const mes = parseInt(mesStr, 10) - 1;
    const año = parseInt(añoStr, 10);
    const date = new Date(año, mes, dia);
    return (date.getFullYear() === año &&
            date.getMonth() === mes &&
            date.getDate() === dia) ? limpio : null;
}

class ApoyoController {

    constructor() {
        this.listar = this.listar.bind(this);
        this.importarExcel = this.importarExcel.bind(this);
    }

    /**
     * GET /api/apoyos
     * Lista los apoyos registrados, de más reciente a más antiguo,
     * con paginación tipo "cargar más".
     *
     * Control de acceso por dependencia:
     * - Administrador y Supervisor ven TODAS las dependencias.
     * - Cualquier otro rol solo ve los apoyos de SU propia dependencia,
     *   sin excepción, sin importar qué filtros mande en el query.
     *
     * Filtro dinámico: curp (búsqueda por prefijo, tipo autocompletado).
     */
    public async listar(req: Request, res: Response) {
        try {
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));

            const curpParam = typeof req.query.curp === 'string'
                ? req.query.curp.trim().toUpperCase()
                : null;

            if (curpParam && curpParam.length > 0 && curpParam.length < CURP_MIN_CHARS_BUSQUEDA) {
                return res.status(400).json({
                    message: `Ingrese al menos ${CURP_MIN_CHARS_BUSQUEDA} caracteres de la CURP para buscar`
                });
            }

            const usuarioActual = (req as any).user;
            const idRol: number = usuarioActual?.id_rol_usuario;
            const idDependenciaUsuario: number | null = usuarioActual?.id_dependencia ?? null;

            const puedeVerTodasLasDependencias = idRol === ID_ROL_ADMINISTRADOR || idRol === ID_ROL_SUPERVISOR;

            // Si el rol está restringido a su dependencia y por alguna razón
            // no trae id_dependencia, no se le muestra nada (fail-closed, no fail-open).
            if (!puedeVerTodasLasDependencias && !idDependenciaUsuario) {
                return res.status(403).json({ message: "No tiene una dependencia asignada" });
            }

            let query = supabase
                .schema('apoyo')
                .from('tApoyo')
                .select(
                    `id_apoyo, curp_beneficiario, nombres, apellido_paterno, apellido_materno,
                     nombre_localidad, calle, numero_exterior,
                     id_dependencia, id_programa, nombre_concepto,
                     cantidad, monto, fecha_apoyo,
                     id_usuario_captura, created_at`,
                    { count: 'exact' }
                )
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            // Restricción de dependencia: se aplica SIEMPRE para roles no privilegiados,
            // sin importar qué haya mandado el cliente en el query string.
            if (!puedeVerTodasLasDependencias) {
                query = query.eq('id_dependencia', idDependenciaUsuario);
            }

            // Búsqueda por prefijo de CURP (aprovecha idx_apoyo_curp_prefijo con text_pattern_ops)
            if (curpParam) {
                query = query.like('curp_beneficiario', `${curpParam}%`);
            }

            const { data: registros, error: apoyoError, count } = await query;

            if (apoyoError) {
                await logError(req, apoyoError, 'ApoyoController', 'listar', 'apoyo', 'lApoyo');
                return res.status(500).json({ message: "Error al consultar los apoyos" });
            }

            // Resolver nombre de programa, dependencia y usuario que capturó,
            // igual que en auditoría: consultas de lookup en vez de join cross-schema.
            const idsProgramas = Array.from(new Set((registros ?? []).map((r) => r.id_programa)));
            const idsDependencias = Array.from(new Set((registros ?? []).map((r) => r.id_dependencia)));
            const idsUsuariosCaptura = Array.from(new Set((registros ?? []).map((r) => r.id_usuario_captura)));

            const [programasRes, dependenciasRes, usuariosRes] = await Promise.all([
                idsProgramas.length > 0
                    ? supabase.schema('apoyo').from('tPrograma').select('id_programa, nombre_programa').in('id_programa', idsProgramas)
                    : Promise.resolve({ data: [], error: null }),
                idsDependencias.length > 0
                    ? supabase.schema('usuario').from('tDependencia').select('id_dependencia, nombre_dependencia').in('id_dependencia', idsDependencias)
                    : Promise.resolve({ data: [], error: null }),
                idsUsuariosCaptura.length > 0
                    ? supabase.schema('usuario').from('tUsuario').select('id_usuario, nombre_usuario').in('id_usuario', idsUsuariosCaptura)
                    : Promise.resolve({ data: [], error: null }),
            ]);

            const programasPorId = new Map((programasRes.data ?? []).map((p: any) => [p.id_programa, p.nombre_programa]));
            const dependenciasPorId = new Map((dependenciasRes.data ?? []).map((d: any) => [d.id_dependencia, d.nombre_dependencia]));
            const usuariosPorId = new Map((usuariosRes.data ?? []).map((u: any) => [u.id_usuario, u.nombre_usuario]));

            const data = (registros ?? []).map((r) => ({
                id_apoyo: r.id_apoyo,
                curp_beneficiario: r.curp_beneficiario,
                nombres: r.nombres,
                apellido_paterno: r.apellido_paterno,
                apellido_materno: r.apellido_materno,
                nombre_localidad: r.nombre_localidad,
                calle: r.calle,
                numero_exterior: r.numero_exterior,
                dependencia: dependenciasPorId.get(r.id_dependencia) ?? null,
                programa: programasPorId.get(r.id_programa) ?? null,
                nombre_concepto: r.nombre_concepto,
                cantidad: r.cantidad,
                monto: r.monto,
                fecha_apoyo: r.fecha_apoyo,
                capturado_por: usuariosPorId.get(r.id_usuario_captura) ?? null,
                created_at: r.created_at
            }));

            const total = count ?? 0;
            const hasMore = offset + data.length < total;

            res.status(200).json({ data, total, offset, limit, hasMore });

        } catch (err: any) {
            await logError(req, err, 'ApoyoController', 'listar', 'apoyo', 'lApoyo');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * POST /api/apoyos/importar
     * Carga masiva de apoyos desde Excel.
     * Solo Administrador.
     */
    public async importarExcel(req: Request, res: Response) {
        try {
            const usuarioActual = (req as any).user;
            if (usuarioActual?.id_rol_usuario !== ID_ROL_ADMINISTRADOR) {
                return res.status(403).json({ message: "Solo el Administrador puede importar apoyos" });
            }

            const file = (req as any).file as Express.Multer.File | undefined;
            if (!file) {
                return res.status(400).json({ message: "Debe subir un archivo Excel (.xlsx)" });
            }

            const workbook = XLSX.read(file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) {
                return res.status(400).json({ message: "El archivo Excel no contiene hojas" });
            }
            const worksheet = workbook.Sheets[sheetName];

            if (!worksheet) {
                return res.status(400).json({ message: "La hoja de Excel no existe o no se pudo leer" });
            }

            const filas = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as Record<string, string>[];

            if (filas.length === 0) {
                return res.status(400).json({ message: "El archivo Excel está vacío" });
            }

            const { data: dependencias } = await supabase
                .schema('usuario').from('tDependencia')
                .select('id_dependencia, nombre_dependencia')
                .eq('estatus_dependencia', true);

            const { data: programas } = await supabase
                .schema('apoyo').from('tPrograma')
                .select('id_programa, nombre_programa, id_dependencia')
                .eq('estatus_programa', true);

            const dependenciaMap = new Map<string, number>();
            (dependencias ?? []).forEach(d => {
                if (d.nombre_dependencia) {
                    dependenciaMap.set(d.nombre_dependencia.trim().toLowerCase(), d.id_dependencia);
                }
            });

            const programaMap = new Map<string, number>();
            (programas ?? []).forEach(p => {
                if (p.nombre_programa && p.id_dependencia) {
                    const clave = `${p.id_dependencia}||${p.nombre_programa.trim().toLowerCase()}`;
                    programaMap.set(clave, p.id_programa);
                }
            });

            const registrosValidos: any[] = [];
            const errores: any[] = [];

            for (const fila of filas) {
                const observaciones: string[] = [];
                const registro: any = {};

                // Nombres
                const nombres = limpiarNombre(fila['NOMBRE(S)'] ?? '');
                if (!esNombreValido(nombres)) {
                    observaciones.push('Nombres inválidos (solo letras, espacios, apóstrofe, guion; entre 2 y 100 caracteres)');
                } else {
                    registro.nombres = nombres;
                }

                // Apellidos
                const paterno = limpiarNombre(fila['APELLIDO_PATERNO'] ?? '');
                const materno = limpiarNombre(fila['APELLIDO_MATERNO'] ?? '');

                const paternoOk = paterno ? esNombreValido(paterno) : true;
                const maternoOk = materno ? esNombreValido(materno) : true;
                const alMenosUnApellido = paterno !== '' || materno !== '';

                if (!paternoOk) observaciones.push('Apellido paterno inválido');
                if (!maternoOk) observaciones.push('Apellido materno inválido');
                if (!alMenosUnApellido) observaciones.push('Debe ingresar al menos un apellido (paterno o materno)');
                else {
                    registro.apellido_paterno = paterno || null;
                    registro.apellido_materno = materno || null;
                }

                // CURP
                const curpRaw = fila['CURP_BENEF'] ?? '';
                if (!validarCURP(curpRaw)) {
                    observaciones.push('CURP inválida (formato: 4 letras, 6 dígitos, H/M, 5 letras, 1 letra o dígito, 1 dígito)');
                } else {
                    registro.curp_beneficiario = curpRaw.trim().toUpperCase();
                }

                // Localidad
                registro.nombre_localidad = limpiarTextoLibre(fila['NOMBRE_LOCALIDAD']);

                // Calle
                registro.calle = limpiarTextoLibre(fila['CALLE']);

                // Número exterior
                let numExt = limpiarTextoLibre(fila['NÚMERO EXTERIOR'] ?? '');
                if (!numExt) numExt = 'S/N';
                registro.numero_exterior = numExt;

                // Dependencia
                const depNombre = limpiarNombre(fila['DEPENDENCIA'] ?? '').toLowerCase();
                const depId = dependenciaMap.get(depNombre);
                if (!depId) {
                    observaciones.push(`Dependencia "${depNombre}" no encontrada (verifique el nombre exacto)`);
                } else {
                    registro.id_dependencia = depId;
                }

                // Programa
                const progNombre = limpiarNombre(fila['PROGRAMA'] ?? '').toLowerCase();
                let progId: number | undefined;
                if (depId) {
                    const keyProg = `${depId}||${progNombre}`;
                    progId = programaMap.get(keyProg);
                    if (!progId) {
                        observaciones.push(`Programa "${progNombre}" no encontrado para la dependencia "${depNombre}"`);
                    } else {
                        registro.id_programa = progId;
                    }
                } else if (progNombre) {
                    observaciones.push("No se pudo validar el programa porque la dependencia es inválida");
                }

                // Concepto
                registro.nombre_concepto = limpiarTextoLibre(fila['CONCEPTO DE APOYO'] ?? '');

                // Cantidad
                let cantidad = 1;
                const cantRaw = (fila['CANTIDAD'] ?? '').toString().trim();
                if (cantRaw !== '') {
                    const num = parseInt(cantRaw, 10);
                    if (isNaN(num) || num <= 0) {
                        observaciones.push('Cantidad debe ser un número entero positivo');
                    } else {
                        cantidad = num;
                    }
                }
                registro.cantidad = cantidad;

                // Monto
                let monto: number | null = null;
                const montoRaw = (fila['MONTO'] ?? '').toString().trim();
                if (montoRaw !== '') {
                    const num = parseFloat(montoRaw);
                    if (isNaN(num) || num < 0) {
                        observaciones.push('Monto debe ser un número positivo (puede tener decimales)');
                    } else {
                        monto = num;
                    }
                }
                registro.monto = monto;

                // Fecha de apoyo
                let fechaApoyo: string | null = null;
                const fechaRaw = fila['FECHA DE APOYO'] ?? '';
                const fechaValida = validarFechaDDMMYYYY(fechaRaw);
                if (!fechaValida && fechaRaw.trim() !== '') {
                    observaciones.push('Fecha de apoyo inválida, use el formato DD/MM/AAAA (ej. 14/05/2025)');
                } else if (fechaValida) {
                    // Convertir a YYYY-MM-DD
                    fechaApoyo = fechaValida.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
                }
                registro.fecha_apoyo = fechaApoyo;

                // Otorgado
                registro.otorgado = true;

                // Auditoría
                registro.id_usuario_captura = usuarioActual.id_usuario;

                if (observaciones.length > 0) {
                    errores.push({
                        ...fila,
                        'Atención': observaciones.join('; ')
                    });
                } else {
                    registrosValidos.push(registro);
                }
            }

            let insertados = 0;
            if (registrosValidos.length > 0) {
                const { error: insertError } = await supabase
                    .schema('apoyo')
                    .from('tApoyo')
                    .insert(registrosValidos);

                if (insertError) {
                    await logError(req, insertError, 'ApoyoController', 'importarExcel', 'apoyo', 'lApoyo');
                    return res.status(500).json({
                        message: "Error al insertar los registros válidos. Revise el log de errores.",
                        detalle: insertError.message
                    });
                }
                insertados = registrosValidos.length;

                await logAudit(req, 'IMPORT_EXCEL', 'tApoyo', null, {
                    cantidad: insertados,
                    nombre_archivo: file.originalname
                });
            }

            if (errores.length > 0) {
                const wbErr = XLSX.utils.book_new();
                const wsErr = XLSX.utils.json_to_sheet(errores);
                XLSX.utils.book_append_sheet(wbErr, wsErr, 'Errores');
                const excelBuffer = XLSX.write(wbErr, { bookType: 'xlsx', type: 'buffer' });

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', 'attachment; filename=errores_importacion.xlsx');
                res.status(200).send(excelBuffer);
                return;
            }

            res.status(200).json({
                message: `Importación exitosa. ${insertados} apoyos registrados.`,
                total: insertados
            });

        } catch (err: any) {
            await logError(req, err, 'ApoyoController', 'importarExcel', 'apoyo', 'lApoyo');
            res.status(500).json({ error: "Error en el servidor al procesar el archivo" });
        }
    }
}

export const apoyoController = new ApoyoController();