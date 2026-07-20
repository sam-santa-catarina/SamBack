import { Response, NextFunction } from "express";
import { AuthRequest } from "./authMiddleware";
import { ESTATUS_USUARIO } from "../constants/estatusUsuario";
import supabase from "../database";

// Rutas a las que SIEMPRE se debe poder entrar, sin importar el estatus,
// mientras el usuario tenga un access_token válido.
const RUTAS_EXENTAS = [
  "/api/auth/change-password",
  "/api/auth/refresh-token",
  "/api/auth/logout",
  "/api/auth/register",
  "/api/auth/login",
];

export async function requireEstatusNormal(req: AuthRequest, res: Response, next: NextFunction) {
  const rutaCompleta = req.originalUrl.split('?')[0];
  if (RUTAS_EXENTAS.some((r) => rutaCompleta === `/api${r}`)) {
    return next();
  }

  const id_usuario = req.user?.id_usuario;

  if (!id_usuario) {
    return res.status(401).json({ message: "No autorizado" });
  }

  const { data, error } = await supabase
    .schema('usuario')
    .from('tUsuario')
    .select('id_estatus_usuario')
    .eq('id_usuario', id_usuario)
    .maybeSingle();

  if (error || !data) {
    return res.status(401).json({ message: "Usuario no encontrado" });
  }

  switch (data.id_estatus_usuario) {
    case ESTATUS_USUARIO.NUEVO:
      return res.status(403).json({
        message: "Debe cambiar su contraseña antes de continuar",
        requiere_cambio_contrasena: true,
      });
    case ESTATUS_USUARIO.BLOQUEADO:
      return res.status(423).json({ message: "Cuenta bloqueada" });
    case ESTATUS_USUARIO.ELIMINADO:
      return res.status(403).json({ message: "Cuenta eliminada" });
    default:
      next();
  }
}