import { Router } from "express";
import { apoyoController } from "../controllers/apoyoController";
import { requireAdmin } from "../middlewares/requireAdminMiddleware";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

class ApoyoRoutes {
    public router: Router = Router();

    constructor() {
        this.config();
    }

    config(): void {
        this.router.get("/", apoyoController.listar);
        this.router.post('/importar', requireAdmin, upload.single('file'), apoyoController.importarExcel
);
    }
}

const apoyoRoutes = new ApoyoRoutes();
export default apoyoRoutes.router;