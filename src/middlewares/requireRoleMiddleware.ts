import { Response, NextFunction } from "express";
import { AuthRequest } from "./authMiddleware";

export function requireRole(...rolesPermitidos: number[]) {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const idRol = req.user?.id_rol_usuario;

        if (!idRol || !rolesPermitidos.includes(idRol)) {
            return res.status(403).json({ message: "No tiene permisos para realizar esta acción" });
        }

        next();
    };
}