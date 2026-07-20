import { Request, Response } from "express";
import "multer";
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
    return /^[A-Za-zÁÉÍÓÚáéíóúÀÈÌÒÙàèìòùÜüÑñ'\-\\. ]+$/.test(limpio);
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

function excelSerialToDateString(serial: number): string | null {
    if (isNaN(serial) || serial < 1) return null;
    // Excel cuenta desde 1/1/1900; se ajusta restando 25569 (días entre 1/1/1900 y 1/1/1970)
    const date = new Date((serial - 25569) * 86400 * 1000);
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const a = date.getFullYear();
    return `${d}/${m}/${a}`;
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

// Convierte un nombre de dependencia en un slug seguro para nombre de archivo
// (sin acentos, sin espacios, en minúsculas), ej. "Desarrollo Social" -> "desarrollo-social"
function slugify(texto: string): string {
    return texto
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'sin-dependencia';
}

// Concatena nombres + apellidos en un solo string para mostrar,
// omitiendo apellidos que vengan en null (persona con un solo apellido).
function nombreCompleto(
    nombres: string | null,
    apellidoPaterno: string | null,
    apellidoMaterno: string | null
): string {
    return [nombres, apellidoPaterno, apellidoMaterno]
        .filter((parte): parte is string => !!parte)
        .join(' ');
}

class ApoyoController {

    constructor() {
        this.listar = this.listar.bind(this);
        this.listarPendientes = this.listarPendientes.bind(this);
        this.importarExcel = this.importarExcel.bind(this);
        this.importarExcelPendientes = this.importarExcelPendientes.bind(this);
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

            if (!puedeVerTodasLasDependencias) {
                query = query.eq('id_dependencia', idDependenciaUsuario);
            }

            if (curpParam) {
                query = query.like('curp_beneficiario', `${curpParam}%`);
            }

            const { data: registros, error: apoyoError, count } = await query;

            if (apoyoError) {
                await logError(req, apoyoError, 'ApoyoController', 'listar', 'apoyo', 'lApoyo');
                return res.status(500).json({ message: "Error al consultar los apoyos" });
            }

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
                nombre_completo: nombreCompleto(r.nombres, r.apellido_paterno, r.apellido_materno),
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
     * GET /api/apoyos/pendientes
     * Lista los apoyos PENDIENTES (otorgado = false), de más reciente a
     * más antiguo, con la misma paginación tipo "cargar más" y el mismo
     * control de acceso por dependencia que /api/apoyos.
     *
     * No se seleccionan localidad, calle, número exterior, cantidad, monto
     * ni fecha de apoyo porque en un pendiente esos campos siempre están
     * vacíos (aún no se ha entregado nada) — el frontend no necesita
     * recibirlos ni renderizarlos para esta vista.
     */
    public async listarPendientes(req: Request, res: Response) {
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

            if (!puedeVerTodasLasDependencias && !idDependenciaUsuario) {
                return res.status(403).json({ message: "No tiene una dependencia asignada" });
            }

            let query = supabase
                .schema('apoyo')
                .from('tApoyo')
                .select(
                    `id_apoyo, curp_beneficiario, nombres, apellido_paterno, apellido_materno,
                     id_dependencia, id_programa, nombre_concepto,
                     id_usuario_captura, created_at`,
                    { count: 'exact' }
                )
                .eq('otorgado', false)
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);

            if (!puedeVerTodasLasDependencias) {
                query = query.eq('id_dependencia', idDependenciaUsuario);
            }

            if (curpParam) {
                query = query.like('curp_beneficiario', `${curpParam}%`);
            }

            const { data: registros, error: apoyoError, count } = await query;

            if (apoyoError) {
                await logError(req, apoyoError, 'ApoyoController', 'listarPendientes', 'apoyo', 'lApoyo');
                return res.status(500).json({ message: "Error al consultar los apoyos pendientes" });
            }

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
                nombre_completo: nombreCompleto(r.nombres, r.apellido_paterno, r.apellido_materno),
                dependencia: dependenciasPorId.get(r.id_dependencia) ?? null,
                programa: programasPorId.get(r.id_programa) ?? null,
                nombre_concepto: r.nombre_concepto,
                capturado_por: usuariosPorId.get(r.id_usuario_captura) ?? null,
                created_at: r.created_at
            }));

            const total = count ?? 0;
            const hasMore = offset + data.length < total;

            res.status(200).json({ data, total, offset, limit, hasMore });

        } catch (err: any) {
            await logError(req, err, 'ApoyoController', 'listarPendientes', 'apoyo', 'lApoyo');
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

            const rawRows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

            const HEADER_ROW_INDEX = 3;
            if (rawRows.length <= HEADER_ROW_INDEX) {
                return res.status(400).json({ message: "El archivo Excel no tiene suficientes filas (se espera encabezados en la fila 4)" });
            }

            const headers = rawRows[HEADER_ROW_INDEX] as string[];
            if (!headers || headers.every(h => !h)) {
                return res.status(400).json({ message: "No se encontraron encabezados en la fila 4" });
            }

            const filas: Record<string, string>[] = [];
            for (let i = HEADER_ROW_INDEX + 1; i < rawRows.length; i++) {
                const row = rawRows[i];
                if (!row || row.every(cell => cell === undefined || cell === '' || cell === null)) continue;

                const obj: Record<string, string> = {};
                headers.forEach((header, idx) => {
                    const rawValue = row[idx] ?? '';
                    const headerTrimmed = String(header).trim();

                    let finalValue: string;
                    if (headerTrimmed === 'FECHA DE APOYO' && typeof rawValue === 'number') {
                        const fechaConvertida = excelSerialToDateString(rawValue);
                        finalValue = fechaConvertida !== null ? fechaConvertida : String(rawValue);
                    } else {
                        finalValue = String(rawValue);
                    }

                    obj[headerTrimmed] = finalValue;
                });
                (obj as any).__rowIndex = i;
                filas.push(obj);
            }

            if (filas.length === 0) {
                return res.status(400).json({ message: "El archivo Excel está vacío" });
            }

            const rowDataByIndex = new Map<number, Record<string, string>>();
            for (const f of filas) {
                const idx = (f as any).__rowIndex as number;
                const { __rowIndex, ...cleanData } = f as any;
                rowDataByIndex.set(idx, cleanData);
            }

            // Precargar catálogos
            const { data: dependencias } = await supabase
                .schema('usuario').from('tDependencia')
                .select('id_dependencia, nombre_dependencia')
                .eq('estatus_dependencia', true);

            const { data: programas } = await supabase
                .schema('apoyo').from('tPrograma')
                .select('id_programa, nombre_programa, id_dependencia')
                .eq('estatus_programa', true);

            const dependenciaMap = new Map<string, number>();
            const dependenciaNombrePorId = new Map<number, string>();
            (dependencias ?? []).forEach(d => {
                if (d.nombre_dependencia) {
                    dependenciaMap.set(d.nombre_dependencia.trim().toLowerCase(), d.id_dependencia);
                    dependenciaNombrePorId.set(d.id_dependencia, d.nombre_dependencia.trim());
                }
            });

            const programaMap = new Map<string, number>();
            (programas ?? []).forEach(p => {
                if (p.nombre_programa && p.id_dependencia) {
                    const clave = `${p.id_dependencia}||${p.nombre_programa.trim().toLowerCase()}`;
                    programaMap.set(clave, p.id_programa);
                }
            });

            // --- NUEVO: precarga acotada de apoyos existentes por CURP ---
            const curpsUnicos = Array.from(new Set(
                filas
                    .map(f => (f['CURP'] ?? '').trim().toUpperCase())
                    .filter(c => validarCURP(c))
            ));

            const { data: existentes, error: existentesError } = curpsUnicos.length > 0
                ? await supabase
                    .schema('apoyo').from('tApoyo')
                    .select(`id_apoyo, curp_beneficiario, nombres, apellido_paterno, apellido_materno,
                             nombre_localidad, calle, numero_exterior, id_dependencia, id_programa,
                             nombre_concepto, cantidad, monto, fecha_apoyo, otorgado, created_at`)
                    .in('curp_beneficiario', curpsUnicos)
                    .order('created_at', { ascending: true })
                : { data: [], error: null };

            if (existentesError) {
                await logError(req, existentesError, 'ApoyoController', 'importarExcel', 'apoyo', 'lApoyo');
                return res.status(500).json({ message: "Error al consultar los apoyos existentes" });
            }

            // Clave de identidad para "pendiente" (mismos campos que antes: curp+nombres+apellidos+dep+programa+concepto)
            const clavePendiente = (o: {
                curp: string; nombres: string; paterno: string | null; materno: string | null;
                dep: number; prog: number; concepto: string | null;
            }) => JSON.stringify([o.curp, o.nombres, o.paterno, o.materno, o.dep, o.prog, o.concepto]);

            // Clave de identidad para "duplicado exacto" (mismos campos que existe_apoyo_duplicado)
            const claveDuplicado = (o: {
                curp: string; nombres: string; paterno: string | null; materno: string | null;
                localidad: string | null; calle: string | null; numExt: string | null;
                dep: number; prog: number; concepto: string | null; cantidad: number;
                monto: number | null; fecha: string | null;
            }) => JSON.stringify([o.curp, o.nombres, o.paterno, o.materno, o.localidad, o.calle, o.numExt,
                                    o.dep, o.prog, o.concepto, o.cantidad, o.monto, o.fecha]);

            // Colas de pendientes disponibles por clave (FIFO, igual que el ORDER BY created_at ASC + LIMIT 1 original)
            const pendientesPorClave = new Map<string, number[]>();
            // Set de "otorgados" existentes, para chequeo de duplicado exacto
            const otorgadosExistentes = new Set<string>();

            (existentes ?? []).forEach((r: any) => {
                if (r.otorgado === false) {
                    const key = clavePendiente({
                        curp: r.curp_beneficiario, nombres: r.nombres,
                        paterno: r.apellido_paterno, materno: r.apellido_materno,
                        dep: r.id_dependencia, prog: r.id_programa, concepto: r.nombre_concepto
                    });
                    const cola = pendientesPorClave.get(key) ?? [];
                    cola.push(r.id_apoyo);
                    pendientesPorClave.set(key, cola);
                } else {
                    const key = claveDuplicado({
                        curp: r.curp_beneficiario, nombres: r.nombres,
                        paterno: r.apellido_paterno, materno: r.apellido_materno,
                        localidad: r.nombre_localidad, calle: r.calle, numExt: r.numero_exterior,
                        dep: r.id_dependencia, prog: r.id_programa, concepto: r.nombre_concepto,
                        cantidad: r.cantidad, monto: r.monto, fecha: r.fecha_apoyo
                    });
                    otorgadosExistentes.add(key);
                }
            });
            // --- fin precarga ---

            let nombreDependenciaDetectado: string | null = null;

            const registrosAInsertar: any[] = [];
            const updatesAAplicar: { id_apoyo: number; datos: any }[] = [];
            const errorRows: { rowIndex: number; observaciones: string }[] = [];
            let insertados = 0;
            let actualizados = 0;
            let ignorados = 0;

            for (const fila of filas) {
                const observaciones: string[] = [];
                const registro: any = {};

                // Nombres
                const nombres = limpiarNombre(fila['NOMBRE(S)'] ?? '');
                if (!esNombreValido(nombres)) {
                    observaciones.push('Nombres inválidos (solo letras, espacios, apóstrofe, guion, punto; entre 2 y 100 caracteres)');
                } else {
                    registro.nombres = nombres;
                }

                // Apellidos
                const paterno = limpiarNombre(fila['APELLIDO PATERNO'] ?? '');
                const materno = limpiarNombre(fila['APELLIDO MATERNO'] ?? '');

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
                const curpRaw = fila['CURP'] ?? '';
                if (!validarCURP(curpRaw)) {
                    observaciones.push('CURP inválida (formato: 4 letras, 6 dígitos, H/M, 5 letras, 1 letra o dígito, 1 dígito)');
                } else {
                    registro.curp_beneficiario = curpRaw.trim().toUpperCase();
                }

                registro.nombre_localidad = limpiarTextoLibre(fila['LOCALIDAD']);
                registro.calle = limpiarTextoLibre(fila['CALLE']);

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
                    if (!nombreDependenciaDetectado) {
                        nombreDependenciaDetectado = dependenciaNombrePorId.get(depId) ?? depNombre;
                    }
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
                    fechaApoyo = fechaValida.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
                }
                registro.fecha_apoyo = fechaApoyo;

                registro.id_usuario_captura = usuarioActual.id_usuario;

                // --- Lógica de negocio en memoria (sin queries por fila) ---
                if (observaciones.length === 0) {
                    const keyPendiente = clavePendiente({
                        curp: registro.curp_beneficiario, nombres: registro.nombres,
                        paterno: registro.apellido_paterno, materno: registro.apellido_materno,
                        dep: registro.id_dependencia, prog: registro.id_programa, concepto: registro.nombre_concepto
                    });

                    const colaPendientes = pendientesPorClave.get(keyPendiente);

                    if (colaPendientes && colaPendientes.length > 0) {
                        // Completar el pendiente más antiguo disponible (misma prioridad FIFO que antes)
                        const idPendiente = colaPendientes.shift()!;

                        const datosUpdate = {
                            nombre_localidad: registro.nombre_localidad,
                            calle: registro.calle,
                            numero_exterior: registro.numero_exterior,
                            nombre_concepto: registro.nombre_concepto,
                            cantidad: registro.cantidad,
                            monto: registro.monto,
                            fecha_apoyo: registro.fecha_apoyo,
                            otorgado: true,
                            updated_at: new Date().toISOString(),
                            id_usuario_captura: usuarioActual.id_usuario
                        };
                        updatesAAplicar.push({ id_apoyo: idPendiente, datos: datosUpdate });
                        actualizados++;

                        // Este registro ahora cuenta como "otorgado" para el resto del archivo
                        otorgadosExistentes.add(claveDuplicado({
                            curp: registro.curp_beneficiario, nombres: registro.nombres,
                            paterno: registro.apellido_paterno, materno: registro.apellido_materno,
                            localidad: registro.nombre_localidad, calle: registro.calle, numExt: registro.numero_exterior,
                            dep: registro.id_dependencia, prog: registro.id_programa, concepto: registro.nombre_concepto,
                            cantidad: registro.cantidad, monto: registro.monto, fecha: registro.fecha_apoyo
                        }));
                    } else {
                        const keyDuplicado = claveDuplicado({
                            curp: registro.curp_beneficiario, nombres: registro.nombres,
                            paterno: registro.apellido_paterno, materno: registro.apellido_materno,
                            localidad: registro.nombre_localidad, calle: registro.calle, numExt: registro.numero_exterior,
                            dep: registro.id_dependencia, prog: registro.id_programa, concepto: registro.nombre_concepto,
                            cantidad: registro.cantidad, monto: registro.monto, fecha: registro.fecha_apoyo
                        });

                        if (otorgadosExistentes.has(keyDuplicado)) {
                            ignorados++;
                        } else {
                            registro.otorgado = true;
                            registrosAInsertar.push(registro);
                            otorgadosExistentes.add(keyDuplicado);
                        }
                    }
                }

                if (observaciones.length > 0) {
                    errorRows.push({
                        rowIndex: Number((fila as any).__rowIndex),
                        observaciones: observaciones.join('; ')
                    });
                }
            }

            // Inserción masiva de nuevos registros
            if (registrosAInsertar.length > 0) {
                const { error: insertError } = await supabase
                    .schema('apoyo')
                    .from('tApoyo')
                    .insert(registrosAInsertar);

                if (insertError) {
                    await logError(req, insertError, 'ApoyoController', 'importarExcel', 'apoyo', 'lApoyo');
                    return res.status(500).json({
                        message: "Error al insertar los registros nuevos. Revise el log de errores.",
                        detalle: insertError.message
                    });
                }
                insertados = registrosAInsertar.length;
            }

            // Updates de pendientes en paralelo
            if (updatesAAplicar.length > 0) {
                const resultados = await Promise.all(
                    updatesAAplicar.map(u =>
                        supabase
                            .schema('apoyo')
                            .from('tApoyo')
                            .update(u.datos)
                            .eq('id_apoyo', u.id_apoyo)
                    )
                );

                const updateConError = resultados.find(r => r.error);
                if (updateConError?.error) {
                    await logError(req, updateConError.error, 'ApoyoController', 'importarExcel', 'apoyo', 'lApoyo');
                    return res.status(500).json({
                        message: "Error al actualizar los apoyos pendientes. Revise el log de errores.",
                        detalle: updateConError.error.message
                    });
                }
            }

            // Auditoría
            const totalProcesados = insertados + actualizados;
            await logAudit(req, 'IMPORT_EXCEL', 'tApoyo', null, {
                insertados,
                actualizados,
                total: totalProcesados,
                nombre_archivo: file.originalname
            }, usuarioActual.id_usuario);

            // Si hay errores, generar Excel de errores (sin cambios respecto al original)
            if (errorRows.length > 0) {
                const headerRows = rawRows.slice(0, HEADER_ROW_INDEX + 1);
                const originalHeaders = headerRows[HEADER_ROW_INDEX] as string[];

                const atencionColIndex = originalHeaders.findIndex(h => h && h.trim().toUpperCase() === 'ATENCIÓN');
                const hasAtencion = atencionColIndex !== -1;
                const finalHeaders = hasAtencion
                    ? originalHeaders
                    : [...originalHeaders, 'Atención'];

                const newHeaderRows = headerRows.map((row, idx) => {
                    if (idx === HEADER_ROW_INDEX) {
                        return hasAtencion ? row : [...row, 'Atención'];
                    }
                    return hasAtencion ? row : [...(row || []), ''];
                });

                const errorIndexSet = new Map<number, string>();
                errorRows.forEach(e => errorIndexSet.set(e.rowIndex, e.observaciones));

                const dataRows: any[][] = [];
                for (let i = HEADER_ROW_INDEX + 1; i < rawRows.length; i++) {
                    const obs = errorIndexSet.get(i);
                    if (!obs) continue;

                    const filaData = rowDataByIndex.get(i);
                    if (!filaData) continue;

                    const newRow: any[] = [];
                    for (let colIdx = 0; colIdx < finalHeaders.length; colIdx++) {
                        const header = finalHeaders[colIdx];
                        if (header === 'Atención') {
                            newRow.push(obs);
                        } else {
                            newRow.push(filaData[header!] ?? '');
                        }
                    }
                    dataRows.push(newRow);
                }

                const finalRows = [...newHeaderRows, ...dataRows];
                const wsErr = XLSX.utils.aoa_to_sheet(finalRows);

                const columnWidths = finalHeaders.map((_, idx) => {
                    const isAtencion = (hasAtencion && idx === atencionColIndex) || (!hasAtencion && idx === finalHeaders.length - 1);
                    return { wch: isAtencion ? 80 : 35 };
                });
                wsErr['!cols'] = columnWidths;

                const wbErr = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wbErr, wsErr, 'Errores');

                const excelBuffer = XLSX.write(wbErr, { bookType: 'xlsx', type: 'buffer' });

                const slugDependencia = slugify(nombreDependenciaDetectado ?? '');
                const nombreArchivoErrores = `errores-registros-otorgados-${slugDependencia}.xlsx`;

                res.setHeader('X-Import-Result', JSON.stringify({
                    insertados,
                    actualizados,
                    ignorados,
                    errores: errorRows.length,
                    total_procesados: totalProcesados + errorRows.length
                }));

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename=${nombreArchivoErrores}`);
                res.status(200).send(excelBuffer);
                return;
            }

            res.status(200).json({
                message: `Importación exitosa. ${insertados} nuevos, ${actualizados} actualizados.`,
                insertados,
                actualizados,
                total: totalProcesados
            });

        } catch (err: any) {
            await logError(req, err, 'ApoyoController', 'importarExcel', 'apoyo', 'lApoyo');
            res.status(500).json({ error: "Error en el servidor al procesar el archivo" });
        }
    }

    /**
     * POST /api/apoyos/importar-pendientes
     * Carga masiva de apoyos PENDIENTES desde Excel.
     * Solo trae los campos básicos: nombres, apellidos, CURP, dependencia,
     * programa y concepto. El resto queda vacío y otorgado = false.
     * Solo Administrador.
     *
     * Reglas de duplicado (misma identidad = curp + nombres + apellidos +
     * dependencia + programa + concepto):
     * - Si ya existe un PENDIENTE igual → se ignora (no se duplica).
     * - Si ya existe un apoyo OTORGADO igual → se ignora (ya fue entregado,
     *   no tiene caso crear un pendiente para algo que ya se cumplió).
     * - En cualquier otro caso → se inserta como pendiente nuevo.
     */
    public async importarExcelPendientes(req: Request, res: Response) {
        try {
            const usuarioActual = (req as any).user;
            if (usuarioActual?.id_rol_usuario !== ID_ROL_ADMINISTRADOR) {
                return res.status(403).json({ message: "Solo el Administrador puede importar apoyos pendientes" });
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

            const rawRows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

            const HEADER_ROW_INDEX = 3;
            if (rawRows.length <= HEADER_ROW_INDEX) {
                return res.status(400).json({ message: "El archivo Excel no tiene suficientes filas (se espera encabezados en la fila 4)" });
            }

            const headers = rawRows[HEADER_ROW_INDEX] as string[];
            if (!headers || headers.every(h => !h)) {
                return res.status(400).json({ message: "No se encontraron encabezados en la fila 4" });
            }

            const filas: Record<string, string>[] = [];
            for (let i = HEADER_ROW_INDEX + 1; i < rawRows.length; i++) {
                const row = rawRows[i];
                if (!row || row.every(cell => cell === undefined || cell === '' || cell === null)) continue;

                const obj: Record<string, string> = {};
                headers.forEach((header, idx) => {
                    const rawValue = row[idx] ?? '';
                    const headerTrimmed = String(header).trim();
                    obj[headerTrimmed] = String(rawValue);
                });
                (obj as any).__rowIndex = i;
                filas.push(obj);
            }

            if (filas.length === 0) {
                return res.status(400).json({ message: "El archivo Excel está vacío" });
            }

            const rowDataByIndex = new Map<number, Record<string, string>>();
            for (const f of filas) {
                const idx = (f as any).__rowIndex as number;
                const { __rowIndex, ...cleanData } = f as any;
                rowDataByIndex.set(idx, cleanData);
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
            const dependenciaNombrePorId = new Map<number, string>();
            (dependencias ?? []).forEach(d => {
                if (d.nombre_dependencia) {
                    dependenciaMap.set(d.nombre_dependencia.trim().toLowerCase(), d.id_dependencia);
                    dependenciaNombrePorId.set(d.id_dependencia, d.nombre_dependencia.trim());
                }
            });

            const programaMap = new Map<string, number>();
            (programas ?? []).forEach(p => {
                if (p.nombre_programa && p.id_dependencia) {
                    const clave = `${p.id_dependencia}||${p.nombre_programa.trim().toLowerCase()}`;
                    programaMap.set(clave, p.id_programa);
                }
            });

            // --- NUEVO: precarga acotada de apoyos existentes por CURP ---
            const curpsUnicos = Array.from(new Set(
                filas
                    .map(f => (f['CURP'] ?? '').trim().toUpperCase())
                    .filter(c => validarCURP(c))
            ));

            const { data: existentes, error: existentesError } = curpsUnicos.length > 0
                ? await supabase
                    .schema('apoyo').from('tApoyo')
                    .select(`curp_beneficiario, nombres, apellido_paterno, apellido_materno,
                             id_dependencia, id_programa, nombre_concepto, otorgado`)
                    .in('curp_beneficiario', curpsUnicos)
                : { data: [], error: null };

            if (existentesError) {
                await logError(req, existentesError, 'ApoyoController', 'importarExcelPendientes', 'apoyo', 'lApoyo');
                return res.status(500).json({ message: "Error al consultar los apoyos existentes" });
            }

            // Misma clave de identidad para pendiente y para otorgado (los campos son los mismos)
            const claveIdentidad = (o: {
                curp: string; nombres: string; paterno: string | null; materno: string | null;
                dep: number; prog: number; concepto: string | null;
            }) => JSON.stringify([o.curp, o.nombres, o.paterno, o.materno, o.dep, o.prog, o.concepto]);

            const pendientesExistentes = new Set<string>();
            const otorgadosExistentes = new Set<string>();

            (existentes ?? []).forEach((r: any) => {
                const key = claveIdentidad({
                    curp: r.curp_beneficiario, nombres: r.nombres,
                    paterno: r.apellido_paterno, materno: r.apellido_materno,
                    dep: r.id_dependencia, prog: r.id_programa, concepto: r.nombre_concepto
                });
                if (r.otorgado === false) {
                    pendientesExistentes.add(key);
                } else {
                    otorgadosExistentes.add(key);
                }
            });
            // --- fin precarga ---

            let nombreDependenciaDetectado: string | null = null;

            const registrosAInsertar: any[] = [];
            const errorRows: { rowIndex: number; observaciones: string }[] = [];
            let insertados = 0;
            let ignorados = 0;

            for (const fila of filas) {
                const observaciones: string[] = [];
                const registro: any = {};

                // Nombres
                const nombres = limpiarNombre(fila['NOMBRE(S)'] ?? '');
                if (!esNombreValido(nombres)) {
                    observaciones.push('Nombres inválidos (solo letras, espacios, apóstrofe, guion, punto; entre 2 y 100 caracteres)');
                } else {
                    registro.nombres = nombres;
                }

                // Apellidos
                const paterno = limpiarNombre(fila['APELLIDO PATERNO'] ?? '');
                const materno = limpiarNombre(fila['APELLIDO MATERNO'] ?? '');

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
                const curpRaw = fila['CURP'] ?? '';
                if (!validarCURP(curpRaw)) {
                    observaciones.push('CURP inválida (formato: 4 letras, 6 dígitos, H/M, 5 letras, 1 letra o dígito, 1 dígito)');
                } else {
                    registro.curp_beneficiario = curpRaw.trim().toUpperCase();
                }

                // Dependencia
                const depNombre = limpiarNombre(fila['DEPENDENCIA'] ?? '').toLowerCase();
                const depId = dependenciaMap.get(depNombre);
                if (!depId) {
                    observaciones.push(`Dependencia "${depNombre}" no encontrada (verifique el nombre exacto)`);
                } else {
                    registro.id_dependencia = depId;
                    if (!nombreDependenciaDetectado) {
                        nombreDependenciaDetectado = dependenciaNombrePorId.get(depId) ?? depNombre;
                    }
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

                // Concepto (obligatorio)
                const concepto = limpiarTextoLibre(fila['CONCEPTO DE APOYO'] ?? '');
                if (!concepto) {
                    observaciones.push('El concepto de apoyo es obligatorio');
                } else {
                    registro.nombre_concepto = concepto;
                }

                registro.id_usuario_captura = usuarioActual.id_usuario;
                registro.otorgado = false;
                registro.cantidad = null;

                // --- Lógica de negocio en memoria (sin queries por fila) ---
                if (observaciones.length === 0) {
                    const key = claveIdentidad({
                        curp: registro.curp_beneficiario, nombres: registro.nombres,
                        paterno: registro.apellido_paterno, materno: registro.apellido_materno,
                        dep: registro.id_dependencia, prog: registro.id_programa, concepto: registro.nombre_concepto
                    });

                    if (pendientesExistentes.has(key) || otorgadosExistentes.has(key)) {
                        ignorados++;
                    } else {
                        registrosAInsertar.push(registro);
                        // Para que duplicados dentro del mismo archivo también se ignoren entre sí
                        pendientesExistentes.add(key);
                    }
                }

                if (observaciones.length > 0) {
                    errorRows.push({
                        rowIndex: Number((fila as any).__rowIndex),
                        observaciones: observaciones.join('; ')
                    });
                }
            }

            if (registrosAInsertar.length > 0) {
                const { error: insertError } = await supabase
                    .schema('apoyo')
                    .from('tApoyo')
                    .insert(registrosAInsertar);

                if (insertError) {
                    await logError(req, insertError, 'ApoyoController', 'importarExcelPendientes', 'apoyo', 'lApoyo');
                    return res.status(500).json({
                        message: "Error al insertar los pendientes. Revise el log de errores.",
                        detalle: insertError.message
                    });
                }
                insertados = registrosAInsertar.length;
            }

            await logAudit(req, 'IMPORT_EXCEL_PENDIENTES', 'tApoyo', null, {
                insertados,
                ignorados,
                errores: errorRows.length,
                nombre_archivo: file.originalname
            }, usuarioActual.id_usuario);

            if (errorRows.length > 0) {
                const headerRows = rawRows.slice(0, HEADER_ROW_INDEX + 1);
                const originalHeaders = headerRows[HEADER_ROW_INDEX] as string[];

                const atencionColIndex = originalHeaders.findIndex(h => h && h.trim().toUpperCase() === 'ATENCIÓN');
                const hasAtencion = atencionColIndex !== -1;
                const finalHeaders = hasAtencion
                    ? originalHeaders
                    : [...originalHeaders, 'Atención'];

                const newHeaderRows = headerRows.map((row, idx) => {
                    if (idx === HEADER_ROW_INDEX) {
                        return hasAtencion ? row : [...row, 'Atención'];
                    }
                    return hasAtencion ? row : [...(row || []), ''];
                });

                const errorIndexSet = new Map<number, string>();
                errorRows.forEach(e => errorIndexSet.set(e.rowIndex, e.observaciones));

                const dataRows: any[][] = [];
                for (let i = HEADER_ROW_INDEX + 1; i < rawRows.length; i++) {
                    const obs = errorIndexSet.get(i);
                    if (!obs) continue;

                    const filaData = rowDataByIndex.get(i);
                    if (!filaData) continue;

                    const newRow: any[] = [];
                    for (let colIdx = 0; colIdx < finalHeaders.length; colIdx++) {
                        const header = finalHeaders[colIdx];
                        if (header === 'Atención') {
                            newRow.push(obs);
                        } else {
                            newRow.push(filaData[header!] ?? '');
                        }
                    }
                    dataRows.push(newRow);
                }

                const finalRows = [...newHeaderRows, ...dataRows];
                const wsErr = XLSX.utils.aoa_to_sheet(finalRows);

                const columnWidths = finalHeaders.map((_, idx) => {
                    const isAtencion = (hasAtencion && idx === atencionColIndex) || (!hasAtencion && idx === finalHeaders.length - 1);
                    return { wch: isAtencion ? 80 : 35 };
                });
                wsErr['!cols'] = columnWidths;

                const wbErr = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wbErr, wsErr, 'Errores');

                const excelBuffer = XLSX.write(wbErr, { bookType: 'xlsx', type: 'buffer' });

                const slugDependencia = slugify(nombreDependenciaDetectado ?? '');
                const nombreArchivoErrores = `errores-registros-pendientes-${slugDependencia}.xlsx`;

                res.setHeader('X-Import-Result', JSON.stringify({
                    insertados,
                    ignorados,
                    errores: errorRows.length,
                    total_procesados: insertados + errorRows.length
                }));

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename=${nombreArchivoErrores}`);
                res.status(200).send(excelBuffer);
                return;
            }

            res.status(200).json({
                message: `Importación de pendientes exitosa. ${insertados} nuevos, ${ignorados} ignorados.`,
                insertados,
                ignorados,
                total: insertados
            });

        } catch (err: any) {
            await logError(req, err, 'ApoyoController', 'importarExcelPendientes', 'apoyo', 'lApoyo');
            res.status(500).json({ error: "Error en el servidor al procesar el archivo" });
        }
    }
}

export const apoyoController = new ApoyoController();