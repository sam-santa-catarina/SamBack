import express, { Application } from "express";
import morgan from "morgan";
import cors from "cors";
import cookieParser from "cookie-parser";
import AuthRoutes from "./routes/authRoutes";
import AuditoriaRoutes from "./routes/auditoriaRoutes";
import ApoyoRoutes from "./routes/apoyoRoutes";
import { requireEstatusNormal } from "./middlewares/estatusMiddleware";
import { authMiddleware } from "./middlewares/authMiddleware";
import DependenciaRoutes from "./routes/dependenciaRoutes";

class Server {
    public app: Application;

    constructor() {
        this.app = express();
        this.config();
        this.routes();
    }

    config() : void {
        const corsOptions = {
            origin: process.env.FRONTEND_URL,
            credentials: true,
            optionsSuccessStatus: 200
        };

        this.app.set('port', process.env.PORT || 3000);
        this.app.use(morgan('dev'));
        this.app.use(cors(corsOptions));
        this.app.use(express.json());
        this.app.use(express.urlencoded({extended : false}));
        this.app.use(cookieParser());
    }

    routes() : void {
        this.app.use("/api/auth", AuthRoutes);
        this.app.use("/api", authMiddleware, requireEstatusNormal)
        this.app.use("/api/auditoria", AuditoriaRoutes);
        this.app.use("/api/apoyos", ApoyoRoutes);
        this.app.use("/api/dependencias", DependenciaRoutes);
    }

    start(): void {
        this.app.listen(this.app.get('port'), () => {
            console.log('Server running on port', this.app.get('port'));
        });
    }
    
}

const server = new Server();
server.start();
