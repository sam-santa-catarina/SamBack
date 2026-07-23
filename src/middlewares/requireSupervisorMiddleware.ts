import { requireRole } from "./requireRoleMiddleware";
import { ID_ROL_SUPERVISOR } from "../constants/rolesUsuario";

export const requireSupervisor = requireRole(ID_ROL_SUPERVISOR);