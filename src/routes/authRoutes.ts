import rateLimit from "express-rate-limit";
import { Router } from "express";
import { authController } from "../controllers/authController";
import { authMiddleware } from "../middlewares/authMiddleware";

const createLimiter = (minutes: number, max: number, message: string) =>
    rateLimit({
        windowMs: minutes * 60 * 1000,
        max,
        message: {
            message
        },
        standardHeaders: true,
        legacyHeaders: false
    });

// Registro
const registerLimiter = createLimiter(15, 20,
    "Demasiados intentos de registro. Intenta más tarde."
);

// Login
const loginLimiter = createLimiter(10, 30,
    "Demasiados intentos de inicio de sesión. Intenta más tarde."
);

// Refresh token
const refreshTokenLimiter = createLimiter(15,30,
    "Demasiadas solicitudes de sesión. Intenta más tarde."
);

class AuthRoutes {
    public router: Router = Router();

    constructor() {
        this.config();
    }

    config(): void {
        this.router.post("/register", registerLimiter, authController.register);
        this.router.post("/login", loginLimiter, authController.login);
        this.router.post("/refresh-token", refreshTokenLimiter, authController.refreshToken);
        this.router.post("/logout", authController.logout);
        this.router.post("/change-password", authMiddleware, authController.changePassword);
    }
}

const authRoutes = new AuthRoutes();
export default authRoutes.router;