import { Router } from "express";
import { dependenciaController } from "../controllers/dependenciaController";

class DependenciaRoutes {
    public router: Router = Router();

    constructor() {
        this.config();
    }

    config(): void {
        this.router.get("/", dependenciaController.listar);
    }
}

const dependenciaRoutes = new DependenciaRoutes();
export default dependenciaRoutes.router;