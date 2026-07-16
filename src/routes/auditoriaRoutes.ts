// routes/auditoriaRoutes.ts
import { Router } from "express";
import { auditoriaController } from "../controllers/auditoriaController";
import { requireAdmin } from "../middlewares/requireAdminMiddleware";

class AuditoriaRoutes {
    public router: Router = Router();

    constructor() {
        this.config();
    }

    config(): void {
        this.router.get("/", requireAdmin, auditoriaController.listar);
    }
}

const auditoriaRoutes = new AuditoriaRoutes();
export default auditoriaRoutes.router;