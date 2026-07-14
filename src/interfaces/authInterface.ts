export interface RegisterUser {
    nombre_usuario: string;
    correo_electronico: string;
    contrasena: string;
    id_rol_usuario?: number;
}

export interface UsuarioDB extends Omit<RegisterUser, 'contrasena'> {
    contrasena_hash: string;
}

export interface LoginCredentials {
    correo: string;
    contrasena: string;
}