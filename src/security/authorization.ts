import type { AuthorizationContext, PermissionAction } from "./permission.manager.js";
import type { ResourceResolver } from "./resource.resolver.js";
import { isAbsolute, relative, dirname, join } from "node:path";
import { notepadRepeatCount } from "../task/action.signature.js";

export type AuthorizationGrant = { action: PermissionAction; resource: string; source: "explicit" | "necessary" };
export function applicationId(value: string): string | undefined {
  const name = value.trim().toLowerCase();
  if (["notepad", "notepad.exe", "bloco de notas"].includes(name)) return "notepad";
  if (["spotify", "spotify.exe"].includes(name)) return "spotify";
  return undefined;
}

/** Only affirmative commands anchored to the user's request create scoped grants.
 * Model responses, history and file contents never create authorizations. */
export function deriveAuthorization(input: string, resources: ResourceResolver): AuthorizationContext {
  const grants: AuthorizationGrant[] = [];
  const command = input.trim().replace(/^(?:por favor[, ]+|(?:você )?pode\s+|quero que (?:você )?)/i, "");
  const app = /^(?:abra|abrir|abre|inicie|iniciar)\s+(?:o\s+)?(bloco de notas|notepad(?:\.exe)?|spotify(?:\.exe)?)(?=[\s.!?,]|$)/i.exec(command);
  if (app) grants.push({ action: "execute_process", resource: applicationId(app[1]!)!, source: "explicit" });
  const closed = /^(?:feche|fechar|encerre|encerrar|finalize|finalizar)\s+(?:o\s+)?(bloco de notas|notepad(?:\.exe)?|spotify(?:\.exe)?)(?=[\s.!?,]|$)/i.exec(command);
  if (closed) grants.push({ action: "terminate_process", resource: applicationId(closed[1]!)!, source: "explicit" });
  if (notepadRepeatCount(input) > 1) grants.push({ action: "execute_process", resource: "notepad", source: "explicit" });
  const opened = /^(?:abra|abrir|abre)\s+(?:(?:o|meu)\s+)?(?:arquivo\s+)?["']?([^\s"']+\.[a-z0-9]{1,10})["']?[.!?]?$/i.exec(command);
  if (opened && !app) {
    for (const resource of ["workspace", "downloads"] as const) {
      try {
        const path = opened[1]!;
        const target = resources.file(resource, isAbsolute(path) ? relative(resources.resolve(resource), path) : path);
        if (!isAbsolute(path) && resource === "downloads") continue;
        grants.push({ action: "open_file", resource: target, source: "explicit" });
        break;
      } catch { /* No grant outside registered roots. */ }
    }
  }
  const moved = /^(mova|mover|renomeie|renomear)\s+(?:o\s+)?(?:arquivo\s+)?["']?([^\s"']+\.[a-z0-9]{1,10})["']?\s+para\s+["']?([^\s"']+\.[a-z0-9]{1,10})["']?[.!?]?$/i.exec(command);
  if (moved) {
    try {
      const source = resources.file("workspace", moved[2]!, true);
      const destination = resources.file("workspace", /^renome/i.test(moved[1]!) ? join(dirname(moved[2]!), moved[3]!) : moved[3]!, true);
      grants.push({ action: "move_file", resource: JSON.stringify([source, destination]), source: "explicit" });
    } catch { /* Both ends must be valid. */ }
  }
  if (/^(?:liste|listar|mostre|mostrar|consulte|consultar|quais são)\b.*\bprocessos\b/i.test(command)) grants.push({ action: "query_system", resource: "get_running_processes", source: "explicit" });
  if (/^(?:mostre|mostrar|consulte|consultar|informe|qual|quais)\b.*\b(sistema|computador|memória|memoria|cpu)\b/i.test(command)) grants.push({ action: "query_system", resource: "get_system_info", source: "explicit" });
  const file = /^(crie|criar|leia|ler|escreva|salve)\s+(?:(?:um|o|meu)\s+)?(?:arquivo\s+)?["']?([^\s"']+\.[a-z0-9]{1,10})(?:["']?[.!?]?$|["']?\s)/i.exec(command);
  if (file) {
    try {
      const action = /^(leia|ler)$/i.test(file[1]!) ? "read_file" : "write_file";
      const resource = resources.file(/\bdownloads\b/i.test(command) ? "downloads" : "workspace", file[2]!, action === "write_file");
      grants.push({ action, resource, source: "explicit" });
    } catch { /* Invalid or unsupported resources never widen scope. */ }
  }
  if (/^(?:crie|criar|gere|gerar)\s+(?:um\s+)?relatório em txt[.!]?$/i.test(command)) {
    grants.push({ action: "write_file", resource: resources.file("workspace", "relatorio.txt", true), source: "necessary" });
  }
  return { read: false, write: false, process: false, network: false, grants };
}
