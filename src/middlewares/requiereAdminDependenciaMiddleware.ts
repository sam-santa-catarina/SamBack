import { requireRole } from "./requireRoleMiddleware";
import { ID_ROL_ADMINISTRADOR, ID_ROL_CAPTURISTA } from "../constants/rolesUsuario";

export const requireAdminODependencia = requireRole(ID_ROL_ADMINISTRADOR, ID_ROL_CAPTURISTA);