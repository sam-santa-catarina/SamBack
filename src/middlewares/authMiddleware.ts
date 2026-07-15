import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/tokenUtil";
import { TokenPayload } from "../interfaces/tokenInterface";

export interface AuthRequest extends Request {
    user?: TokenPayload;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: "Token de acceso requerido" });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = verifyAccessToken(token!);
        if (!decoded) {
            return res.status(401).json({ message: "Token inválido o expirado" });
        }

        req.user = decoded as TokenPayload;
        next();
    } catch {
        return res.status(401).json({ message: "Token inválido o expirado" });
    }
}