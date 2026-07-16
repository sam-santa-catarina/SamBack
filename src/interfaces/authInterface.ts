/** DTO de entrada para POST /api/auth/register */
export interface RegisterUser {
    nombre_usuario: string;
    correo_electronico: string;
    id_dependencia?: number | null;
}

/** Fila real de usuario.tUsuario */
export interface UsuarioDB {
    id_usuario: number;
    nombre_usuario: string;
    correo_electronico: string;
    contrasena_hash: string;
    id_rol_usuario: number;
    id_dependencia: number | null;
    id_estatus_usuario: number;
}

export interface LoginCredentials {
    correo: string;
    contrasena: string;
}

export interface UsuarioListado {
    id_usuario: number;
    nombre_usuario: string;
    correo_electronico: string;
    id_estatus_usuario: number;
}