export interface TokenPayload {
    id_usuario: number;
    nombre_usuario: string;
    correo_electronico: string;
    id_rol_usuario: number;
    requires_profile_completion?: boolean;
}