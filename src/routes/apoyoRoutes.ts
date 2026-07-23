import { Router } from "express";
import { apoyoController } from "../controllers/apoyoController";
import { requireAdmin } from "../middlewares/requireAdminMiddleware";
import { requireSupervisor } from "../middlewares/requireSupervisorMiddleware";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

class ApoyoRoutes {
    public router: Router = Router();

    constructor() {
        this.config();
    }

    config(): void {
        this.router.get("/", apoyoController.listar);
        this.router.get("/pendientes", apoyoController.listarPendientes);
        this.router.get("/supervisor/otorgados", requireSupervisor, apoyoController.listarSupervisor);
        this.router.get("/supervisor/pendientes", requireSupervisor, apoyoController.listarPendientesSupervisor);
        this.router.post('/importar', requireAdmin, upload.single('file'), apoyoController.importarExcel);
        this.router.post('/importar-pendientes', requireAdmin, upload.single('file'), apoyoController.importarExcelPendientes);
    }
}

const apoyoRoutes = new ApoyoRoutes();
export default apoyoRoutes.router;