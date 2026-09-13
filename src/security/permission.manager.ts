export type PermissionAction = "read_file" | "write_file" | "delete_file" | "execute_process" | "terminate_process" | "network" | "move_file" | "open_file" | "query_system";
export type PermissionRequest = { action: PermissionAction; resource?: string };
export type PermissionDecision = "allow" | "confirm" | "deny";
import type { AuthorizationGrant } from "./authorization.js";
export type AuthorizationContext = { read: boolean; write: boolean; process: boolean; network: boolean; grants?: AuthorizationGrant[] };
export type PermissionResult = { decision: PermissionDecision; allowed: boolean; requiresUserConfirmation: boolean; reason: string };

export class PermissionManager {
  check(request: PermissionRequest, authorization: AuthorizationContext = { read: false, write: false, process: false, network: false }): PermissionResult {
    const confirmed = (reason: string): PermissionResult => ({ decision: "confirm", allowed: false, requiresUserConfirmation: true, reason });
    const allowed = (reason: string): PermissionResult => ({ decision: "allow", allowed: true, requiresUserConfirmation: false, reason });
    if (request.action === "delete_file") return confirmed("Exclusão sempre exige confirmação, mesmo com autorização ampla.");
    if (authorization.grants?.some(grant => grant.action === request.action && grant.resource === request.resource)) {
      return allowed("Ação e recurso dentro do escopo solicitado pelo usuário.");
    }
    if (request.action === "network" || request.action === "execute_process" || request.action === "terminate_process") {
      return confirmed("Ação fora do escopo autorizado; revise a ação exata.");
    }
    if (request.action === "read_file") return authorization.grants?.some(grant => grant.action === "read_file")
      ? confirmed("Leitura fora do arquivo solicitado.") : allowed("Leitura limitada aos recursos autorizados.");
    if (request.action === "write_file") return confirmed("Alteração fora do arquivo solicitado exige aprovação da ação exata.");
    if (["move_file", "open_file", "query_system"].includes(request.action)) return confirmed("Ação fora do escopo solicitado exige confirmação.");
    return { decision: "deny", allowed: false, requiresUserConfirmation: false, reason: "Ação desconhecida ou bloqueada." };
  }
}
