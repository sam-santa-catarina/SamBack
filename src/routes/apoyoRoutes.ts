import { Router } from "express";
import { apoyoController } from "../controllers/apoyoController";
import { requireSupervisor } from "../middlewares/requireSupervisorMiddleware";
import multer from "multer";
import { requireAdminODependencia } from "../middlewares/requiereAdminDependenciaMiddleware";

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
        this.router.get("/exportar-sin-monto", requireAdminODependencia, apoyoController.exportarSinMonto);
        this.router.post("/actualizar-monto", requireAdminODependencia, upload.single('file'), apoyoController.actualizarMontoExcel);
        this.router.post('/importar', requireAdminODependencia, upload.single('file'), apoyoController.importarExcel);
        this.router.post('/importar-pendientes', requireAdminODependencia, upload.single('file'), apoyoController.importarExcelPendientes);
    }
}

const apoyoRoutes = new ApoyoRoutes();
export default apoyoRoutes.router;