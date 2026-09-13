import type { CoderResult } from "../ai/qwen-coder.provider.js";
import type { PermissionRequest, PermissionAction } from "./permission.manager.js";
import { ResourceResolver } from "./resource.resolver.js";
import { scriptApplication, scriptTermination } from "./script.scope.js";

export class ExecutionValidator {
  constructor(private readonly resources: ResourceResolver) {}
  analyzeCompute(result: CoderResult): void {
    if (result.language !== "javascript" || result.capabilities.length || this.analyze(result).length || /\b(jarvis|require|process|fetch)\b/.test(result.code)) {
      throw new ComputeEffectError();
    }
  }
  analyze(result: CoderResult): PermissionRequest[] {
    const app = scriptApplication(result);
    if (app && result.capabilities.includes("process_execution") && result.capabilities.every(cap => ["process_execution", "app_control"].includes(cap))) {
      return [{ action: "execute_process", resource: app }];
    }
    const terminated = scriptTermination(result);
    if (result.capabilities.includes("process_control") && (!terminated || result.capabilities.some(cap => cap !== "process_control"))) {
      throw new ProcessControlTemplateError();
    }
    if (terminated && result.capabilities.includes("process_control") && result.capabilities.every(cap => cap === "process_control")) {
      return [{ action: "terminate_process", resource: terminated }];
    }
    if (result.language !== "javascript") throw new Error("Script de host sem escopo verificável. Use JavaScript com jarvis para arquivos ou jarvis.openApp para aplicativos; código arbitrário de host não é liberado.");
    if (!["javascript", "python", "powershell"].includes(result.language) || !result.code.trim() || result.code.length > 20_000) {
      throw new Error("A linguagem ou o código não é aceito (limite de 20000 caracteres).");
    }
    if (/(-encodedcommand|invoke-expression|iex\s|frombase64string|downloadstring|curl\s+[^\s]+\s*\|\s*(iex|powershell)|rm\s+-rf|remove-item\s+.*-recurse)/i.test(result.code)) {
      throw new Error("Código obfuscado, download remoto ou exclusão recursiva foi bloqueado pelo verificador de segurança.");
    }
    const supported = ["filesystem_read", "filesystem_write", "filesystem_delete", "process_execution", "process_control", "network", "app_control"];
    if (!Array.isArray(result.capabilities) || result.capabilities.some((cap) => !supported.includes(cap))) {
      throw new Error("O script solicita capacidades indisponíveis. Rede e processos não são permitidos.");
    }
    const detected: string[] = [];
    if (/(readFile|readdir|open\(|fs\.|os\.path|Get-Content|Get-ChildItem|read_text|os\.listdir)/i.test(result.code)) detected.push("read_file");
    if (/(writeFile|appendFile|mkdir|fs\.write|Set-Content|Out-File|write_text|open\([^\n]+['\"]w)/i.test(result.code)) detected.push("write_file");
    if (/(unlink|rmdir|rm\s|Remove-Item|del\s|erase\s|os\.remove|shutil\.rmtree|deleteFile)/i.test(result.code)) detected.push("delete_file");
    if (/(child_process|spawn\(|exec\(|execFile|Start-Process|subprocess|Invoke-Item)/i.test(result.code)) detected.push("execute_process");
    if (/(fetch\(|https?\.request|requests\.|urllib|Invoke-WebRequest|Invoke-RestMethod|curl\s)/i.test(result.code)) detected.push("network");
    const declared: PermissionRequest[] = result.capabilities.map((cap) => {
      const action: PermissionAction = cap === "filesystem_read" ? "read_file" : cap === "filesystem_write" ? "write_file" : cap === "filesystem_delete" ? "delete_file" : cap === "network" ? "network" : cap === "process_control" ? "terminate_process" : "execute_process";
      return cap.startsWith("filesystem")
        ? { action, resource: this.resources.resolve("workspace") }
        : { action };
    });
    const detectedRequests: PermissionRequest[] = detected.filter((action, index) => detected.indexOf(action) === index).map((action) => ({ action: action as PermissionRequest["action"] }));
    const scoped: PermissionRequest[] = [];
    for (const match of result.code.matchAll(/jarvis\.(listFiles|readFile|writeFile|deleteFile)\(\s*(\{[^\n]*?\})\s*\)/g)) {
      try {
        const args = JSON.parse(match[2]!);
        const action: PermissionAction = match[1] === "writeFile" ? "write_file" : match[1] === "deleteFile" ? "delete_file" : "read_file";
        scoped.push({ action, resource: this.resources.file(args.resource, args.path, action !== "read_file") });
      } catch { /* Dynamic arguments remain unscoped and are checked again by the bridge. */ }
    }
    return [...scoped, ...declared, ...detectedRequests].filter((request, index, all) =>
      (!scoped.some(item => item.action === request.action) || index < scoped.length) &&
      all.findIndex(item => item.action === request.action && item.resource === request.resource) === index);
  }
}

export class ProcessControlTemplateError extends Error {
  readonly code = "PROCESS_CONTROL_TEMPLATE_FORBIDDEN";
  constructor() { super("process_control só aceita o template de encerramento do aplicativo solicitado; operações adicionais foram bloqueadas."); }
}

export class ComputeEffectError extends Error {
  readonly code = "COMPUTE_EFFECT_FORBIDDEN";
  constructor() { super("Compute tentou uma capacidade externa proibida. Separe leitura/escrita em Tools; compute deve apenas transformar input e imprimir output."); }
}
