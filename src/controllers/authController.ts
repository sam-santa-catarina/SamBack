import { Request, Response } from "express";
import { generateAccessToken, generateRefreshToken, hashRefreshToken, getRefreshTokenExpiry, verifyRefreshToken } from "../utils/tokenUtil";
import { ESTATUS_USUARIO } from "../constants/estatusUsuario";
import { TokenPayload } from "../interfaces/tokenInterface";
import { RegisterUser } from "../interfaces/authInterface";
import { logError } from "../utils/logError";
import { logAudit } from "../utils/logAudit";
import supabase from "../database";
import bcrypt from "bcrypt";
import { ID_ROL_ADMINISTRADOR, ID_ROL_CAPTURISTA } from "../constants/rolesUsuario";

class AuthController {

    constructor() {
        this.register = this.register.bind(this);
        this.login = this.login.bind(this);
        this.changePassword = this.changePassword.bind(this);
        this.logout = this.logout.bind(this);
        this.resetUser = this.resetUser.bind(this);
        this.listar = this.listar.bind(this);
    }

    /**
     * POST /api/auth/register
     * Crea un nuevo usuario en el sistema.
     */
    public async register(req: Request, res: Response) {
        try {
            const user: RegisterUser = req.body;

            const { nombre_usuario, correo_electronico, id_dependencia } = user;

            // Limpieza de variables
            const nombre = nombre_usuario?.trim().replace(/\s+/g, ' ');
            const correo = correo_electronico?.trim().toLowerCase();

            const errores = [];
            const emailRegex = /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/;
            const nombreRegex = /^[A-Za-zÁÉÍÓÚáéíóúÜüÑñ]+(?:\s[A-Za-zÁÉÍÓÚáéíóúÜüÑñ]+)*$/;

            // Validaciones básicas
            if (!nombre || !correo) {
                errores.push("Los campos nombre_usuario y correo_electronico son obligatorios");
            } else {
                if (nombre.length < 3 || nombre.length > 60) {
                    errores.push("El nombre de usuario debe tener entre 3 y 60 caracteres");
                }

                if (!nombreRegex.test(nombre)) {
                    errores.push("El nombre de usuario solo puede contener letras y espacios");
                }

                if (correo.length < 10 || correo.length > 150) {
                    errores.push("El correo electrónico debe tener entre 10 y 150 caracteres");
                }

                if (!emailRegex.test(correo)) {
                    errores.push("El correo electrónico no tiene un formato válido");
                }
            }

            if (errores.length > 0) {
                return res.status(400).json({ errors: errores });
            }

            // Contraseña por defecto para usuarios nuevos
            const DEFAULT_PASSWORD = process.env.DEFAULT_USER_PASSWORD || 'password';

            // Hash de contraseña
            let contrasena_hash: string;
            try {
                const saltRounds = process.env.NODE_ENV === 'production' ? 12 : 10;
                contrasena_hash = await bcrypt.hash(DEFAULT_PASSWORD, saltRounds);
            } catch (hashError) {
                await logError(req, hashError, 'AuthController', 'register', 'usuario', 'lUsuario');
                return res.status(500).json({ message: "Error interno al procesar la contraseña" });
            }

            const defaultRole = Number(process.env.DEFAULT_ROLE_ID || ID_ROL_CAPTURISTA);
            const esAdministrador = defaultRole === ID_ROL_ADMINISTRADOR;

            // Un Administrador no lleva dependencia; cualquier otro rol la requiere.
            if (!esAdministrador && !id_dependencia) {
                return res.status(400).json({ errors: ["Debe especificar la dependencia del usuario"] });
            }

            const { data, error } = await supabase.schema('usuario')
                .rpc('registrar_usuario', {
                    _nombre_usuario: nombre,
                    _correo_electronico: correo,
                    _contrasena_hash: contrasena_hash,
                    _id_rol_usuario: defaultRole,
                    _id_dependencia: esAdministrador ? null : id_dependencia
                });

            if (error) {
                await logError(req, error, 'AuthController', 'register', 'usuario', 'lUsuario');

                if (error.message?.includes('Ya existe un usuario registrado')) {
                    return res.status(409).json({ message: "El correo ya está registrado" });
                }

                if (error.message?.includes('dependencia')) {
                    return res.status(400).json({ message: error.message });
                }
                return res.status(500).json({ message: "Error al registrar el usuario" });
            }

            const nuevoUsuario = data;
            const userId = nuevoUsuario.id;

            await logAudit(req, 'REGISTER', 'tUsuario', userId, {
                email: correo,
                nombre: nombre,
                rol: defaultRole,
                dependencia: esAdministrador ? null : id_dependencia
            });

            res.status(201).json({
                message: "Usuario registrado exitosamente",
                user: {
                    id: userId,
                    nombre_usuario: nuevoUsuario.nombre_usuario,
                    correo_electronico: nuevoUsuario.correo_electronico
                }
            });
        } catch (err: any) {
            await logError(req, err, 'AuthController', 'register', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * POST /api/auth/login
     * Inicio de sesión de usuario existente.
     */
    public async login(req: Request, res: Response) {
        try {
            const { correo, contrasena } = req.body;

            if (!correo || !contrasena) {
                return res.status(400).json({ message: "Correo y contraseña son obligatorios" });
            }

            // Sanitización y límites
            const correoNormalizado = String(correo).toLowerCase().trim();
            const emailRegex = /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/;

            if (correoNormalizado.length > 150 || !emailRegex.test(correoNormalizado)) {
                // Por seguridad, no especificamos si fue el formato o la longitud
                return res.status(400).json({ message: "Correo o contraseña no válidos" });
            }

            if (typeof contrasena !== 'string' || contrasena.length > 100) {
                return res.status(400).json({ message: "Correo o contraseña no válidos" });
            }

            const { data: user, error: userError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .select('id_usuario, nombre_usuario, correo_electronico, contrasena_hash, id_rol_usuario, id_estatus_usuario, id_dependencia')
                .eq('correo_electronico', correoNormalizado)
                .maybeSingle();

            if (userError) {
                await logError(req, userError, 'AuthController', 'login', 'usuario', 'lUsuario');
                return res.status(500).json({ message: "Error al buscar usuario" });
            }

            if (!user) {
                await this.registrarIntentoFallido(null, req);
                return res.status(401).json({ message: "Credenciales inválidas" });
            }

            if (user.id_estatus_usuario === ESTATUS_USUARIO.ELIMINADO) {
                return res.status(403).json({ message: "Esta cuenta ha sido eliminada" });
            }

            const { data: acceso, error: accesoError } = await supabase
                .schema('usuario')
                .from('tAcceso')
                .select('intentos_fallidos, bloqueado_hasta')
                .eq('id_usuario', user.id_usuario)
                .maybeSingle();

            if (accesoError) {
                await logError(req, accesoError, 'AuthController', 'login', 'usuario', 'lUsuario', user.id_usuario);
            }

            if (acceso?.bloqueado_hasta) {
                if (new Date(acceso.bloqueado_hasta) > new Date()) {
                    // Sigue bloqueado
                    const minutosRestantes = Math.ceil((new Date(acceso.bloqueado_hasta).getTime() - Date.now()) / 60000);
                    return res.status(423).json({
                        message: `Cuenta bloqueada. Intente nuevamente en ${minutosRestantes} minutos`,
                        bloqueado_hasta: acceso.bloqueado_hasta
                          ? new Date(acceso.bloqueado_hasta).toISOString()
                          : null,
                        code: 'ACCOUNT_LOCKED'
                    });
                } else {
                    // El tiempo de bloqueo ya venció: se desbloquea el usuario
                    await this.desbloquearUsuario(user.id_usuario, req);
                }
            }

            const passwordMatch = await bcrypt.compare(contrasena, user.contrasena_hash);
            if (!passwordMatch) {
                await this.registrarIntentoFallido(user.id_usuario, req);
                return res.status(401).json({ message: "Credenciales inválidas" });
            }

            // Login exitoso
            const ahora = new Date();
            const { error: updateError } = await supabase
                .schema('usuario')
                .from('tAcceso')
                .update({
                    ultimo_acceso: ahora,
                    intentos_fallidos: 0,
                    bloqueado_hasta: null,
                    updated_at: ahora
                })
                .eq('id_usuario', user.id_usuario);

            if (updateError) {
                await logError(req, updateError, 'AuthController', 'login_update_acceso', 'usuario', 'lUsuario', user.id_usuario);
            }

            // Obtener IP y user agent para la sesión
            const rawIp = (req.headers['x-forwarded-for'] as string || req.ip || req.socket.remoteAddress) as string;
            const realIp = rawIp?.split(',')[0]?.trim().replace(/^::ffff:/, '') || '0.0.0.0';
            const userAgent = req.headers['user-agent'] || 'Desconocido';

            const tokenPayload: TokenPayload = {
                id_usuario: user.id_usuario,
                nombre_usuario: user.nombre_usuario,
                correo_electronico: user.correo_electronico,
                id_rol_usuario: user.id_rol_usuario,
                id_dependencia: user.id_dependencia ?? null
            };

            const accessToken = generateAccessToken(tokenPayload);
            const refreshToken = generateRefreshToken(tokenPayload);
            const refreshTokenHash = await hashRefreshToken(refreshToken);
            const expiresAt = getRefreshTokenExpiry();

            const MAX_ACTIVE_SESSIONS = 3;

            // Contar sesiones activas actuales
            const { count, error: countError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .select('*', { count: 'exact', head: true })
                .eq('id_usuario', user.id_usuario)
                .eq('revoked', false)
                .gt('expires_at', ahora.toISOString());

            if (countError) {
                await logError(req, countError, 'AuthController', 'login_count_sessions', 'usuario', 'lUsuario', user.id_usuario);
            }

            // Si hay más de MAX_ACTIVE_SESSIONS - 1 (porque vamos a insertar una nueva), revocamos las más antiguas
            if (count && count >= MAX_ACTIVE_SESSIONS) {
                const sessionsToRevoke = count - MAX_ACTIVE_SESSIONS + 1;

                const { data: oldestSessions, error: fetchError } = await supabase
                    .schema('usuario')
                    .from('tSesion')
                    .select('id_sesion')
                    .eq('id_usuario', user.id_usuario)
                    .eq('revoked', false)
                    .gt('expires_at', ahora.toISOString())
                    .order('created_at', { ascending: true })
                    .limit(sessionsToRevoke);

                if (!fetchError && oldestSessions && oldestSessions.length > 0) {
                    const idsToRevoke = oldestSessions.map(s => s.id_sesion);
                    const { error: revokeError } = await supabase
                        .schema('usuario')
                        .from('tSesion')
                        .update({ revoked: true, revoked_at: ahora })
                        .in('id_sesion', idsToRevoke);

                    if (revokeError) {
                        await logError(req, revokeError, 'AuthController', 'login_revoke_old_sessions', 'usuario', 'lUsuario', user.id_usuario);
                    }
                }
            }

            // Insertar la nueva sesión
            const { error: sessionError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .insert({
                    id_usuario: user.id_usuario,
                    refresh_token_hash: refreshTokenHash,
                    ip_address: realIp,
                    user_agent: userAgent,
                    expires_at: expiresAt,
                    revoked: false
                });

            if (sessionError) {
                await logError(req, sessionError, 'AuthController', 'login', 'usuario', 'lUsuario', user.id_usuario);
                return res.status(500).json({ message: "Error al iniciar sesión" });
            }

            await logAudit(req, 'LOGIN', 'tUsuario', user.id_usuario, {
                email: user.correo_electronico
            });

            res.cookie('refresh_token', refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                path: '/api/auth/refresh-token',
                maxAge: 30 * 24 * 60 * 60 * 1000
            });

            res.status(200).json({
                message: "Inicio de sesión exitoso",
                user: {
                    id: user.id_usuario,
                    nombre_usuario: user.nombre_usuario,
                    correo_electronico: user.correo_electronico,
                    id_rol_usuario: user.id_rol_usuario
                },
                requiere_cambio_contrasena: user.id_estatus_usuario === ESTATUS_USUARIO.NUEVO,
                tokens: {
                    access_token: accessToken,
                    expires_in: process.env.JWT_ACCESS_EXPIRES_IN
                }
            });
        } catch (err: any) {
            await logError(req, err, 'AuthController', 'login', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * GET /api/usuarios
     * Lista todos los usuarios del sistema (nombre y correo).
     * Solo Administrador.
     */
    public async listar(req: Request, res: Response) {
        try {
            const { data, error } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .select('id_usuario, nombre_usuario, correo_electronico, id_estatus_usuario')
                .order('nombre_usuario', { ascending: true });

            if (error) {
                await logError(req, error, 'AuthController', 'listar', 'usuario', 'lUsuario');
                return res.status(500).json({ message: "Error al obtener los usuarios" });
            }

            res.status(200).json({ data });
        } catch (err: any) {
            await logError(req, err, 'AuthController', 'listar', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * POST /api/auth/refresh-token
     * Actualiza token para mantener sesión activa.
     */
    public async refreshToken(req: Request, res: Response) {
        try {
            const refresh_token = req.cookies?.refresh_token;

            if (!refresh_token) {
                return res.status(400).json({ message: "Refresh token es requerido" });
            }

            let decoded: any;
            try {
                decoded = verifyRefreshToken(refresh_token);
                if (!decoded) {
                    return res.status(401).json({ message: "Refresh token inválido o expirado" });
                }
            } catch {
                return res.status(401).json({ message: "Refresh token inválido o expirado" });
            }

            const userId = decoded.id_usuario;

            const tokenHash = await hashRefreshToken(refresh_token);

            const { data: sesion, error: sessionError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .select('id_sesion, refresh_token_hash, revoked, expires_at')
                .eq('id_usuario', userId)
                .eq('refresh_token_hash', tokenHash)
                .maybeSingle();

            if (sessionError) {
                await logError(req, sessionError, 'AuthController', 'refreshToken', 'usuario', 'lUsuario', userId);
                return res.status(500).json({ message: "Error al validar la sesión" });
            }

            if (!sesion) {
                return res.status(401).json({ message: "Refresh token no válido" });
            }

            if (sesion.revoked) {
                const ahora = new Date();
                await supabase
                    .schema('usuario')
                    .from('tSesion')
                    .update({ revoked: true, revoked_at: ahora })
                    .eq('id_usuario', userId)
                    .eq('revoked', false);

                return res.status(401).json({ message: "Sesión revocada por seguridad" });
            }

            if (new Date(sesion.expires_at) < new Date()) {
                await supabase
                    .schema('usuario')
                    .from('tSesion')
                    .update({ revoked: true, revoked_at: new Date() })
                    .eq('id_sesion', sesion.id_sesion);
                return res.status(401).json({ message: "Refresh token expirado" });
            }

            // Se agrega id_estatus_usuario para poder informar requiere_cambio_contrasena,
            // igual que en login.
            const { data: user, error: userError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .select('id_usuario, nombre_usuario, correo_electronico, id_rol_usuario, id_estatus_usuario, id_dependencia')
                .eq('id_usuario', userId)
                .single();

            if (userError || !user) {
                await logError(req, userError || new Error('Usuario no encontrado'), 'AuthController', 'refreshToken', 'usuario', 'lUsuario', userId);
                return res.status(401).json({ message: "Usuario no encontrado" });
            }

            // Si la cuenta fue bloqueada o eliminada después de emitido el refresh token, se corta aquí.
            if (user.id_estatus_usuario === ESTATUS_USUARIO.BLOQUEADO) {
                return res.status(423).json({ message: "Cuenta bloqueada" });
            }
            if (user.id_estatus_usuario === ESTATUS_USUARIO.ELIMINADO) {
                return res.status(403).json({ message: "Cuenta eliminada" });
            }

            const ahora = new Date();
            const { error: revokeError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .update({ revoked: true, revoked_at: ahora })
                .eq('id_sesion', sesion.id_sesion);

            if (revokeError) {
                await logError(req, revokeError, 'AuthController', 'refreshToken_revoke', 'usuario', 'lUsuario', userId);
            }

            const tokenPayload: TokenPayload = {
                id_usuario: user.id_usuario,
                nombre_usuario: user.nombre_usuario,
                correo_electronico: user.correo_electronico,
                id_rol_usuario: user.id_rol_usuario,
                id_dependencia: user.id_dependencia ?? null
            };

            const newAccessToken = generateAccessToken(tokenPayload);
            const newRefreshToken = generateRefreshToken(tokenPayload);
            const newRefreshTokenHash = await hashRefreshToken(newRefreshToken);
            const expiresAt = getRefreshTokenExpiry();

            const rawIp = (req.headers['x-forwarded-for'] as string || req.ip || req.socket.remoteAddress) as string;
            const realIp = rawIp?.split(',')[0]?.trim().replace(/^::ffff:/, '') || '0.0.0.0';
            const userAgent = req.headers['user-agent'] || 'Desconocido';

            const { error: insertError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .insert({
                    id_usuario: user.id_usuario,
                    refresh_token_hash: newRefreshTokenHash,
                    ip_address: realIp,
                    user_agent: userAgent,
                    expires_at: expiresAt,
                    revoked: false
                });

            if (insertError) {
                await logError(req, insertError, 'AuthController', 'refreshToken_insert', 'usuario', 'lUsuario', userId);
                return res.status(500).json({ message: "Error al crear nueva sesión" });
            }

            await logAudit(req, 'REFRESH_TOKEN', 'tUsuario', userId, {
                email: user.correo_electronico
            });

            res.cookie('refresh_token', newRefreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                path: '/api/auth/refresh-token',
                maxAge: 30 * 24 * 60 * 60 * 1000
            });

            res.status(200).json({
                message: "Token refrescado exitosamente",
                user: {
                    id: user.id_usuario,
                    nombre_usuario: user.nombre_usuario,
                    correo_electronico: user.correo_electronico,
                    id_rol_usuario: user.id_rol_usuario
                },
                requiere_cambio_contrasena: user.id_estatus_usuario === ESTATUS_USUARIO.NUEVO,
                tokens: {
                    access_token: newAccessToken,
                    expires_in: process.env.JWT_ACCESS_EXPIRES_IN
                }
            });

        } catch (err: any) {
            await logError(req, err, 'AuthController', 'refreshToken', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * POST /api/auth/change-password
     * Permite al usuario cambiar su propia contraseña.
     * Requiere autenticación (access_token).
     */
    public async changePassword(req: Request, res: Response) {
        try {
            const id_usuario = (req as any).user?.id_usuario;

            if (!id_usuario) {
                return res.status(401).json({ message: "No autorizado" });
            }

            const { contrasena_actual, contrasena_nueva } = req.body;

            if (!contrasena_actual || !contrasena_nueva) {
                return res.status(400).json({ message: "La contraseña actual y la nueva son obligatorias" });
            }

            if (typeof contrasena_nueva !== 'string' || contrasena_nueva.length < 8 || contrasena_nueva.length > 70) {
                return res.status(400).json({ message: "La nueva contraseña debe tener entre 8 y 70 caracteres" });
            }

            const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{8,70}$/;
            if (!passwordRegex.test(contrasena_nueva)) {
                return res.status(400).json({
                    message: "La nueva contraseña debe tener al menos una letra mayuscula, una letra minuscula, un número, un caracter especial y sin espacios"
                });
            }

            if (contrasena_nueva === contrasena_actual) {
                return res.status(400).json({ message: "La nueva contraseña debe ser diferente a la actual" });
            }

            // Obtener datos actuales del usuario (hash + lo necesario para reemitir tokens)
            const { data: user, error: userError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .select('id_usuario, nombre_usuario, correo_electronico, id_rol_usuario, contrasena_hash, id_dependencia')
                .eq('id_usuario', id_usuario)
                .maybeSingle();

            if (userError || !user) {
                await logError(req, userError || new Error('Usuario no encontrado'), 'AuthController', 'changePassword', 'usuario', 'lUsuario', id_usuario);
                return res.status(404).json({ message: "Usuario no encontrado" });
            }

            // Verificar que la contraseña actual sea correcta
            const passwordMatch = await bcrypt.compare(contrasena_actual, user.contrasena_hash);
            if (!passwordMatch) {
                return res.status(401).json({ message: "La contraseña actual es incorrecta" });
            }

            // Hash de la nueva contraseña
            let nuevo_hash: string;
            try {
                const saltRounds = process.env.NODE_ENV === 'production' ? 12 : 10;
                nuevo_hash = await bcrypt.hash(contrasena_nueva, saltRounds);
            } catch (hashError) {
                await logError(req, hashError, 'AuthController', 'changePassword', 'usuario', 'lUsuario', id_usuario);
                return res.status(500).json({ message: "Error interno al procesar la contraseña" });
            }

            // Actualizar contraseña y, si el usuario era Nuevo, pasarlo a Normal
            const { error: updateError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .update({
                    contrasena_hash: nuevo_hash,
                    id_estatus_usuario: ESTATUS_USUARIO.NORMAL
                })
                .eq('id_usuario', id_usuario)
                .in('id_estatus_usuario', [ESTATUS_USUARIO.NUEVO, ESTATUS_USUARIO.NORMAL]);

            if (updateError) {
                await logError(req, updateError, 'AuthController', 'changePassword', 'usuario', 'lUsuario', id_usuario);
                return res.status(500).json({ message: "Error al actualizar la contraseña" });
            }

            // Por seguridad, revocar TODAS las sesiones existentes (incluida la actual)...
            const ahora = new Date();
            const { error: revokeError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .update({ revoked: true, revoked_at: ahora })
                .eq('id_usuario', id_usuario)
                .eq('revoked', false);

            if (revokeError) {
                await logError(req, revokeError, 'AuthController', 'changePassword_revoke_sessions', 'usuario', 'lUsuario', id_usuario);
            }

            // Emitimos una sesión nueva para este dispositivo
            const tokenPayload: TokenPayload = {
                id_usuario: user.id_usuario,
                nombre_usuario: user.nombre_usuario,
                correo_electronico: user.correo_electronico,
                id_rol_usuario: user.id_rol_usuario,
                id_dependencia: user.id_dependencia ?? null
            };

            const newAccessToken = generateAccessToken(tokenPayload);
            const newRefreshToken = generateRefreshToken(tokenPayload);
            const newRefreshTokenHash = await hashRefreshToken(newRefreshToken);
            const expiresAt = getRefreshTokenExpiry();

            const rawIp = (req.headers['x-forwarded-for'] as string || req.ip || req.socket.remoteAddress) as string;
            const realIp = rawIp?.split(',')[0]?.trim().replace(/^::ffff:/, '') || '0.0.0.0';
            const userAgent = req.headers['user-agent'] || 'Desconocido';

            const { error: insertError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .insert({
                    id_usuario: user.id_usuario,
                    refresh_token_hash: newRefreshTokenHash,
                    ip_address: realIp,
                    user_agent: userAgent,
                    expires_at: expiresAt,
                    revoked: false
                });

            if (insertError) {
                await logError(req, insertError, 'AuthController', 'changePassword_insert_session', 'usuario', 'lUsuario', id_usuario);
                return res.status(500).json({ message: "Error al crear nueva sesión" });
            }

            await logAudit(req, 'CHANGE_PASSWORD', 'tUsuario', id_usuario, {});

            res.cookie('refresh_token', newRefreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                path: '/api/auth/refresh-token',
                maxAge: 30 * 24 * 60 * 60 * 1000
            });

            res.status(200).json({
                message: "Contraseña actualizada exitosamente",
                user: {
                    id: user.id_usuario,
                    nombre_usuario: user.nombre_usuario,
                    correo_electronico: user.correo_electronico,
                    id_rol_usuario: user.id_rol_usuario
                },
                requiere_cambio_contrasena: false,
                tokens: {
                    access_token: newAccessToken,
                    expires_in: process.env.JWT_ACCESS_EXPIRES_IN
                }
            });

        } catch (err: any) {
            await logError(req, err, 'AuthController', 'changePassword', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * POST /api/auth/logout
     * Revoca la sesión asociada al refresh_token de la cookie
     * y limpia la cookie. No requiere access_token porque puede
     * estar expirado al momento de cerrar sesión.
     */
    public async logout(req: Request, res: Response) {
        try {
            const refresh_token = req.cookies?.refresh_token;

            if (!refresh_token) {
                // No hay sesión que cerrar en el backend; igual limpiamos por si acaso.
                res.clearCookie('refresh_token', { path: '/api/auth/refresh-token' });
                return res.status(200).json({ message: "Sesión cerrada" });
            }

            let decoded: any;
            try {
                decoded = verifyRefreshToken(refresh_token);
            } catch {
                decoded = null;
            }

            if (decoded?.id_usuario) {
                const tokenHash = await hashRefreshToken(refresh_token);

                const { error: revokeError } = await supabase
                    .schema('usuario')
                    .from('tSesion')
                    .update({ revoked: true, revoked_at: new Date() })
                    .eq('id_usuario', decoded.id_usuario)
                    .eq('refresh_token_hash', tokenHash)
                    .eq('revoked', false);

                if (revokeError) {
                    await logError(req, revokeError, 'AuthController', 'logout', 'usuario', 'lUsuario', decoded.id_usuario);
                } else {
                    await logAudit(req, 'LOGOUT', 'tUsuario', decoded.id_usuario, {});
                }
            }

            res.clearCookie('refresh_token', { path: '/api/auth/refresh-token' });
            res.status(200).json({ message: "Sesión cerrada" });

        } catch (err: any) {
            await logError(req, err, 'AuthController', 'logout', 'usuario', 'lUsuario');
            // Aunque falle el log/DB, igual limpiamos la cookie del lado del cliente.
            res.clearCookie('refresh_token', { path: '/api/auth/refresh-token' });
            res.status(500).json({ message: "Error al cerrar sesión" });
        }
    }

    /**
     * POST /api/auth/reset-user
     * Reinicia la cuenta de un usuario que perdió acceso:
     * restablece la contraseña a la contraseña por defecto y
     * el estatus a "Nuevo" (forzará cambio de contraseña en el próximo login).
     * Solo Administrador puede llamar este endpoint.
     * Conserva el resto de los datos del usuario intactos.
     */
    public async resetUser(req: Request, res: Response) {
        try {
            const { correo_electronico, id_usuario } = req.body;

            if (!correo_electronico && !id_usuario) {
                return res.status(400).json({ message: "Debe indicar correo_electronico o id_usuario" });
            }

            let query = supabase
                .schema('usuario')
                .from('tUsuario')
                .select('id_usuario, correo_electronico, id_estatus_usuario');

            if (id_usuario) {
                query = query.eq('id_usuario', id_usuario);
            } else {
                const correoNormalizado = String(correo_electronico).toLowerCase().trim();
                query = query.eq('correo_electronico', correoNormalizado);
            }

            const { data: usuario, error: userError } = await query.maybeSingle();

            if (userError) {
                await logError(req, userError, 'AuthController', 'resetUser', 'usuario', 'lUsuario');
                return res.status(500).json({ message: "Error al buscar el usuario" });
            }

            if (!usuario) {
                return res.status(404).json({ message: "Usuario no encontrado" });
            }

            if (usuario.id_estatus_usuario === ESTATUS_USUARIO.ELIMINADO) {
                return res.status(403).json({ message: "No se puede reiniciar una cuenta eliminada" });
            }

            const DEFAULT_PASSWORD = process.env.DEFAULT_USER_PASSWORD || 'password';

            let contrasena_hash: string;
            try {
                const saltRounds = process.env.NODE_ENV === 'production' ? 12 : 10;
                contrasena_hash = await bcrypt.hash(DEFAULT_PASSWORD, saltRounds);
            } catch (hashError) {
                await logError(req, hashError, 'AuthController', 'resetUser', 'usuario', 'lUsuario', usuario.id_usuario);
                return res.status(500).json({ message: "Error interno al procesar la contraseña" });
            }

            const { error: updateError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .update({
                    contrasena_hash,
                    id_estatus_usuario: ESTATUS_USUARIO.NUEVO
                })
                .eq('id_usuario', usuario.id_usuario);

            if (updateError) {
                await logError(req, updateError, 'AuthController', 'resetUser', 'usuario', 'lUsuario', usuario.id_usuario);
                return res.status(500).json({ message: "Error al reiniciar el usuario" });
            }

            const ahora = new Date();

            const { error: accesoError } = await supabase
                .schema('usuario')
                .from('tAcceso')
                .update({
                    intentos_fallidos: 0,
                    bloqueado_hasta: null,
                    updated_at: ahora
                })
                .eq('id_usuario', usuario.id_usuario);

            if (accesoError) {
                await logError(req, accesoError, 'AuthController', 'resetUser_acceso', 'usuario', 'lUsuario', usuario.id_usuario);
            }

            const { error: revokeError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .update({ revoked: true, revoked_at: ahora })
                .eq('id_usuario', usuario.id_usuario)
                .eq('revoked', false);

            if (revokeError) {
                await logError(req, revokeError, 'AuthController', 'resetUser_sesiones', 'usuario', 'lUsuario', usuario.id_usuario);
            }

            const idAdministrador = (req as any).user?.id_usuario;
            await logAudit(req, 'RESET_USER', 'tUsuario', usuario.id_usuario, {
                realizado_por: idAdministrador,
                correo: usuario.correo_electronico
            });

            res.status(200).json({
                message: "Usuario reiniciado exitosamente. Deberá iniciar sesión con la contraseña por defecto y se le pedirá cambiarla."
            });

        } catch (err: any) {
            await logError(req, err, 'AuthController', 'resetUser', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }

    /**
     * Método auxiliar para registrar
     * intentos fallidos y posible bloqueo.
     */
    private async registrarIntentoFallido(id_usuario: number | null, req: Request) {
        if (!id_usuario) {
            await logError(req, new Error("Intento de login con usuario inexistente"), 'AuthController', 'login_intento_fallido', 'usuario', 'lUsuario');
            return;
        }

        const { data: acceso, error: fetchError } = await supabase
            .schema('usuario')
            .from('tAcceso')
            .select('intentos_fallidos, bloqueado_hasta')
            .eq('id_usuario', id_usuario)
            .maybeSingle();

        if (fetchError) {
            await logError(req, fetchError, 'AuthController', 'registrarIntentoFallido', 'usuario', 'lUsuario', id_usuario);
            return;
        }

        const nuevosIntentos = (acceso?.intentos_fallidos || 0) + 1;
        const seBloquea = nuevosIntentos >= 5;
        const bloqueado_hasta = seBloquea ? new Date(Date.now() + 15 * 60 * 1000) : null;

        const { error: updateError } = await supabase
            .schema('usuario')
            .from('tAcceso')
            .update({
                intentos_fallidos: nuevosIntentos,
                ultimo_intento_fallido: new Date(),
                bloqueado_hasta: bloqueado_hasta,
                updated_at: new Date()
            })
            .eq('id_usuario', id_usuario);

        await logAudit(req, 'LOGIN_FAILED', 'tUsuario', id_usuario, { intento_numero: nuevosIntentos });

        if (updateError) {
            await logError(req, updateError, 'AuthController', 'registrarIntentoFallido', 'usuario', 'lUsuario', id_usuario);
        }

        // Si se acaba de bloquear, reflejarlo en el estatus del usuario
        if (seBloquea) {
            const { error: estatusError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .update({ id_estatus_usuario: ESTATUS_USUARIO.BLOQUEADO })
                .eq('id_usuario', id_usuario);

            if (estatusError) {
                await logError(req, estatusError, 'AuthController', 'registrarIntentoFallido_estatus', 'usuario', 'lUsuario', id_usuario);
            }
        }

        await logError(req, new Error(`Intento fallido #${nuevosIntentos}`), 'AuthController', 'login_fallido', 'usuario', 'lUsuario', id_usuario);
    }

    /**
     * Revierte el bloqueo de un usuario una vez que
     * bloqueado_hasta ya expiró.
     */
    private async desbloquearUsuario(id_usuario: number, req: Request) {
        const ahora = new Date();

        const { error: accesoError } = await supabase
            .schema('usuario')
            .from('tAcceso')
            .update({
                intentos_fallidos: 0,
                bloqueado_hasta: null,
                updated_at: ahora
            })
            .eq('id_usuario', id_usuario);

        if (accesoError) {
            await logError(req, accesoError, 'AuthController', 'desbloquearUsuario_acceso', 'usuario', 'lUsuario', id_usuario);
        }

        // Solo revertimos si el estatus actual es "Bloqueado",
        // para no pisar un estatus como "Eliminado"
        const { error: estatusError } = await supabase
            .schema('usuario')
            .from('tUsuario')
            .update({ id_estatus_usuario: ESTATUS_USUARIO.NORMAL })
            .eq('id_usuario', id_usuario)
            .eq('id_estatus_usuario', ESTATUS_USUARIO.BLOQUEADO);

        if (!estatusError) {
            await logAudit(req, 'ACCOUNT_UNLOCKED', 'tUsuario', id_usuario, {});
        }

        if (estatusError) {
            await logError(req, estatusError, 'AuthController', 'desbloquearUsuario_estatus', 'usuario', 'lUsuario', id_usuario);
        }
    }

}

export const authController = new AuthController();