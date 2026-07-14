import { Request, Response } from "express";
import { generateAccessToken, generateRefreshToken, hashRefreshToken, getRefreshTokenExpiry, verifyRefreshToken } from "../utils/tokenUtil";
import { TokenPayload } from "../interfaces/tokenInterface";
import { RegisterUser } from "../interfaces/authInterface";
import { logError } from "../utils/logError";
import { logAudit } from "../utils/logAudit";
import supabase from "../database";
import bcrypt from "bcrypt";

class AuthController {

    constructor() {
        this.register = this.register.bind(this);
        this.login = this.login.bind(this);
    }

    /**
     * POST /api/auth/register
     * Crea un nuevo usuario en el sistema.
     */
    public async register(req: Request, res: Response) {
        try {
            const user: RegisterUser = req.body;

            const {
                nombre_usuario,
                correo_electronico,
                contrasena
            } = user;

            // Limpieza de variables
            const nombre = nombre_usuario?.trim().replace(/\s+/g, ' ');
            const correo = correo_electronico?.trim().toLowerCase();

            const errores = [];
            const emailRegex = /^[^\s@]+@([^\s@.,]+\.)+[^\s@.,]{2,}$/;
            const nombreRegex = /^[A-Za-zÁÉÍÓÚáéíóúÜüÑñ]+(?:\s[A-Za-zÁÉÍÓÚáéíóúÜüÑñ]+)*$/;
            const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S{8,70}$/;

            // Validaciones básicas
            if (!nombre || !correo || !contrasena) {
                errores.push("Los campos nombre_usuario, correo_electronico y contraseña son obligatorios");
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

                if (contrasena.length < 8 || contrasena.length > 70) {
                    errores.push("La contraseña debe tener entre 8 y 70 caracteres");
                }

                if (!passwordRegex.test(contrasena)) {
                    errores.push("La contraseña debe tener al menos una letra mayuscula, una letra minuscula, un número, un caracter especial y sin espacios");
                }
            }

            if (errores.length > 0) {
                return res.status(400).json({ errors: errores });
            }

            // Hash de contraseña
            let contrasena_hash: string;
            try {
                const saltRounds = process.env.NODE_ENV === 'production' ? 12 : 10;
                contrasena_hash = await bcrypt.hash(contrasena, saltRounds);
            } catch (hashError) {
                await logError(req, hashError, 'AuthController', 'register', 'usuario', 'lUsuario');
                return res.status(500).json({ message: "Error interno al procesar la contraseña" });
            }

            const defaultRole = Number(process.env.DEFAULT_ROLE_ID || 3); // Rol por defecto: Capturista

            const { data, error } = await supabase.schema('usuario')
                .rpc('registrar_usuario', {
                    _nombre_usuario: nombre,
                    _correo_electronico: correo,
                    _contrasena_hash: contrasena_hash,
                    _id_rol_usuario: defaultRole
                });

            if (error) {
                await logError(req, error, 'AuthController', 'register', 'usuario', 'lUsuario');

                if (error.message?.includes('Ya existe un usuario registrado')) {
                    return res.status(409).json({ message: "El correo ya está registrado" });
                }
                return res.status(500).json({ message: "Error al registrar el usuario" });
            }

            const nuevoUsuario = data;
            const userId = nuevoUsuario.id;

            await logAudit(req, 'REGISTER', 'tUsuario', userId, { email: correo, nombre: nombre, rol: defaultRole });

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
                .select('id_usuario, nombre_usuario, correo_electronico, contrasena_hash, id_rol_usuario')
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

            const { data: acceso, error: accesoError } = await supabase
                .schema('usuario')
                .from('tAcceso')
                .select('intentos_fallidos, bloqueado_hasta')
                .eq('id_usuario', user.id_usuario)
                .maybeSingle();

            if (accesoError) {
                await logError(req, accesoError, 'AuthController', 'login', 'usuario', 'lUsuario', user.id_usuario);
            }

            if (acceso?.bloqueado_hasta && new Date(acceso.bloqueado_hasta) > new Date()) {
                const minutosRestantes = Math.ceil((new Date(acceso.bloqueado_hasta).getTime() - Date.now()) / 60000);
                return res.status(423).json({
                    message: `Cuenta bloqueada. Intente nuevamente en ${minutosRestantes} minutos`
                });
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
                id_rol_usuario: user.id_rol_usuario
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
                sameSite: 'strict',
                path: '/api/auth/refresh-token',
                maxAge: 30 * 24 * 60 * 60 * 1000
            });

            res.status(200).json({
                message: "Inicio de sesión exitoso",
                user: {
                    id: user.id_usuario,
                    nombre_usuario: user.nombre_usuario,
                    correo_electronico: user.correo_electronico
                },
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
     * POST /api/auth/refresh-token
     * Actualiza token para mantener sesión activa.
     */
    public async refreshToken(req: Request, res: Response) {
        try {
            const refresh_token = req.cookies?.refresh_token;

            if (!refresh_token) {
                return res.status(400).json({ message: "Refresh token es requerido" });
            }

            // Verificar que el token JWT sea válido
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

           // Hashear el token recibido para compararlo con el almacenado
            const tokenHash = await hashRefreshToken(refresh_token);

            // Primero: buscar si existe la sesión (sin filtrar por revocada)
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

            // Si no existe la sesión con ese hash, token inválido
            if (!sesion) {
                return res.status(401).json({ message: "Refresh token no válido" });
            }

            // Si la sesión ya estaba revocada, posible robo de token
            if (sesion.revoked) {
                // Revocar TODAS las sesiones del usuario por seguridad
                const ahora = new Date();
                await supabase
                    .schema('usuario')
                    .from('tSesion')
                    .update({ revoked: true, revoked_at: ahora })
                    .eq('id_usuario', userId)
                    .eq('revoked', false);


                return res.status(401).json({ message: "Sesión revocada por seguridad" });
            }

            // Verificar que no haya expirado en BD
            if (new Date(sesion.expires_at) < new Date()) {
                // Marcar como revocada por expiración
                await supabase
                    .schema('usuario')
                    .from('tSesion')
                    .update({ revoked: true, revoked_at: new Date() })
                    .eq('id_sesion', sesion.id_sesion);
                return res.status(401).json({ message: "Refresh token expirado" });
            }

            // Obtener datos actualizados del usuario (por si cambiaron roles o correo)
            const { data: user, error: userError } = await supabase
                .schema('usuario')
                .from('tUsuario')
                .select('id_usuario, nombre_usuario, correo_electronico, id_rol_usuario')
                .eq('id_usuario', userId)
                .single();

            if (userError || !user) {
                await logError(req, userError || new Error('Usuario no encontrado'), 'AuthController', 'refreshToken', 'usuario', 'lUsuario', userId);
                return res.status(401).json({ message: "Usuario no encontrado" });
            }

            // Revocar la sesión actual (rotación de refresh token)
            const ahora = new Date();
            const { error: revokeError } = await supabase
                .schema('usuario')
                .from('tSesion')
                .update({ revoked: true, revoked_at: ahora })
                .eq('id_sesion', sesion.id_sesion);

            if (revokeError) {
                await logError(req, revokeError, 'AuthController', 'refreshToken_revoke', 'usuario', 'lUsuario', userId);
            }

            // Generar nuevos tokens
            const tokenPayload: TokenPayload = {
                id_usuario: user.id_usuario,
                nombre_usuario: user.nombre_usuario,
                correo_electronico: user.correo_electronico,
                id_rol_usuario: user.id_rol_usuario
            };

            const newAccessToken = generateAccessToken(tokenPayload);
            const newRefreshToken = generateRefreshToken(tokenPayload);
            const newRefreshTokenHash = await hashRefreshToken(newRefreshToken);
            const expiresAt = getRefreshTokenExpiry();

            // IP y User-Agent limpios
            const rawIp = (req.headers['x-forwarded-for'] as string || req.ip || req.socket.remoteAddress) as string;
            const realIp = rawIp?.split(',')[0]?.trim().replace(/^::ffff:/, '') || '0.0.0.0';
            const userAgent = req.headers['user-agent'] || 'Desconocido';

            // Guardar nueva sesión
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

            // Auditoría de renovación exitosa
            await logAudit(req, 'REFRESH_TOKEN', 'tUsuario', userId, {
                email: user.correo_electronico
            });

            // Nueva cookie con el nuevo refresh token
            res.cookie('refresh_token', newRefreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                path: '/api/auth/refresh-token',
                maxAge: 30 * 24 * 60 * 60 * 1000
            });

            res.status(200).json({
                message: "Token refrescado exitosamente",
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
     * Método auxiliar para registrar
     * intentos fallidos y posible bloqueo.
     */
    private async registrarIntentoFallido(id_usuario: number | null, req: Request) {
        if (!id_usuario) {
            // Si el usuario no existe, solo logueamos el intento (sin asociar a usuario)
            await logError(req, new Error("Intento de login con usuario inexistente"), 'AuthController', 'login_intento_fallido', 'usuario', 'lUsuario');
            return;
        }

        // Obtener intentos actuales
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
        const bloqueado_hasta = nuevosIntentos >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

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

        if (updateError) {
            await logError(req, updateError, 'AuthController', 'registrarIntentoFallido', 'usuario', 'lUsuario', id_usuario);
        }

        await logError(req, new Error(`Intento fallido #${nuevosIntentos}`), 'AuthController', 'login_fallido', 'usuario', 'lUsuario', id_usuario);
    }
}

export const authController = new AuthController();