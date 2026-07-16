import { Request, Response } from "express";
import supabase from "../database";
import { logError } from "../utils/logError";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

class AuditoriaController {

    constructor() {
        this.listar = this.listar.bind(this);
    }

    /**
     * GET /api/auditoria
     * Lista los registros de auditoría, de más reciente a más antiguo,
     * con paginación tipo "cargar más" y filtros opcionales:
     * id_usuario, correo_electronico, accion.
     */
    public async listar(req: Request, res: Response) {
        try {
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));

            const idUsuarioParam = req.query.id_usuario ? Number(req.query.id_usuario) : null;
            const correoParam = typeof req.query.correo_electronico === 'string'
                ? req.query.correo_electronico.trim().toLowerCase()
                : null;
            const accionParam = typeof req.query.accion === 'string'
                ? req.query.accion.trim()
                : null;

            if (req.query.id_usuario && Number.isNaN(idUsuarioParam)) {
                return res.status(400).json({ message: "id_usuario debe ser numérico" });
            }

            let idUsuarioFiltro: number | null = idUsuarioParam;

            // Si buscan por correo, primero resolvemos a qué id_usuario corresponde
            if (correoParam) {
                const { data: usuarioEncontrado, error: usuarioError } = await supabase
                    .schema('usuario')
                    .from('tUsuario')
                    .select('id_usuario')
                    .eq('correo_electronico', correoParam)
                    .maybeSingle();

                if (usuarioError) {
                    await logError(req, usuarioError, 'AuditoriaController', 'listar_buscar_usuario', 'sistema', 'lSistema');
                    return res.status(500).json({ message: "Error al buscar el usuario por correo" });
                }

                if (!usuarioEncontrado) {
                    return res.status(200).json({ data: [], total: 0, offset, limit, hasMore: false });
                }

                // Si además mandaron id_usuario y no coincide con el correo, no puede haber resultados.
                if (idUsuarioFiltro !== null && idUsuarioFiltro !== usuarioEncontrado.id_usuario) {
                    return res.status(200).json({ data: [], total: 0, offset, limit, hasMore: false });
                }

                idUsuarioFiltro = usuarioEncontrado.id_usuario;
            }

            let query = supabase
                .schema('sistema')
                .from('tAuditoria')
                .select(
                    'id_auditoria, id_usuario, accion, entidad, entidad_id, detalles, ip_address, user_agent, fecha',
                    { count: 'exact' }
                )
                .order('fecha', { ascending: false })
                .range(offset, offset + limit - 1);

            if (idUsuarioFiltro !== null) {
                query = query.eq('id_usuario', idUsuarioFiltro);
            }

            if (accionParam) {
                query = query.ilike('accion', `%${accionParam}%`);
            }

            const { data: registros, error: auditoriaError, count } = await query;

            if (auditoriaError) {
                await logError(req, auditoriaError, 'AuditoriaController', 'listar', 'sistema', 'lSistema');
                return res.status(500).json({ message: "Error al consultar la auditoría" });
            }

            const idsUsuarios = Array.from(
                new Set((registros ?? []).map((r) => r.id_usuario).filter((id): id is number => id !== null))
            );

            let usuariosPorId = new Map<number, { nombre_usuario: string; correo_electronico: string }>();

            if (idsUsuarios.length > 0) {
                const { data: usuariosData, error: usuariosError } = await supabase
                    .schema('usuario')
                    .from('tUsuario')
                    .select('id_usuario, nombre_usuario, correo_electronico')
                    .in('id_usuario', idsUsuarios);

                if (usuariosError) {
                    await logError(req, usuariosError, 'AuditoriaController', 'listar_usuarios', 'sistema', 'lSistema');
                } else if (usuariosData) {
                    usuariosPorId = new Map(
                        usuariosData.map((u) => [u.id_usuario, { nombre_usuario: u.nombre_usuario, correo_electronico: u.correo_electronico }])
                    );
                }
            }

            const data = (registros ?? []).map((r) => ({
                id_auditoria: r.id_auditoria,
                id_usuario: r.id_usuario,
                nombre_usuario: r.id_usuario ? usuariosPorId.get(r.id_usuario)?.nombre_usuario ?? null : null,
                correo_electronico: r.id_usuario ? usuariosPorId.get(r.id_usuario)?.correo_electronico ?? null : null,
                accion: r.accion,
                entidad: r.entidad,
                entidad_id: r.entidad_id,
                detalles: r.detalles,
                ip_address: r.ip_address,
                user_agent: r.user_agent,
                fecha: r.fecha
            }));

            const total = count ?? 0;
            const hasMore = offset + data.length < total;

            res.status(200).json({ data, total, offset, limit, hasMore });

        } catch (err: any) {
            await logError(req, err, 'AuditoriaController', 'listar', 'sistema', 'lSistema');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }
}

export const auditoriaController = new AuditoriaController();