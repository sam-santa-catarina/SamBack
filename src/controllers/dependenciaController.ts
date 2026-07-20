import { Request, Response } from "express";
import { logError } from "../utils/logError";
import supabase from "../database";

class DependenciaController {
    constructor() {
        this.listar = this.listar.bind(this);
    }

    public async listar(req: Request, res: Response) {
        try {
            const { data, error } = await supabase
                .schema('usuario')
                .from('tDependencia')
                .select('id_dependencia, nombre_dependencia, descripcion_dependencia, estatus_dependencia')
                .eq('estatus_dependencia', true)
                .order('nombre_dependencia', { ascending: true });

            if (error) {
                await logError(req, error, 'DependenciaController', 'listar', 'usuario', 'lUsuario');
                return res.status(500).json({ message: "Error al consultar las dependencias" });
            }

            res.status(200).json({ data });
        } catch (err: any) {
            await logError(req, err, 'DependenciaController', 'listar', 'usuario', 'lUsuario');
            res.status(500).json({ error: "Error en el servidor" });
        }
    }
}

export const dependenciaController = new DependenciaController();