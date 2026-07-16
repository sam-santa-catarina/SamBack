import { requireRole } from "./requireRoleMiddleware";
import { ID_ROL_ADMINISTRADOR } from "../constants/rolesUsuario";

export const requireAdmin = requireRole(ID_ROL_ADMINISTRADOR);