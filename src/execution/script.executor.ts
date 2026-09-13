import { getQuickJS, DefaultIntrinsics } from "quickjs-emscripten";
import type { ScriptExecutionRequest, ScriptExecutionResult } from "./execution.types.js";
import type { CoderCapability } from "../ai/qwen-coder.provider.js";
import { FileTools } from "../tools/file.tools.js";
import { ResourceResolver } from "../security/resource.resolver.js";
import { applicationId } from "../security/authorization.js";
import { PermissionManager, type PermissionRequest } from "../security/permission.manager.js";
import { scriptApplication } from "../security/script.scope.js";
import { launchProcess, resolveApplication, terminateApplication } from "./process.broker.js";
import { ExecutionValidator } from "../security/execution.validator.js";

type ProcessBroker = {
  resolve: (name: string) => string;
  launch: (command: string, args: string[], timeoutMs: number) => string;
  terminate?: (name: string, timeoutMs: number) => string;
};

export class ScriptExecutor {
  constructor(private readonly files = new FileTools(new ResourceResolver()),
    private readonly processes: ProcessBroker = { resolve: resolveApplication, launch: launchProcess, terminate: terminateApplication }) {}

  async execute(request: ScriptExecutionRequest, capabilities: CoderCapability[]): Promise<ScriptExecutionResult> {
    const startedAt = Date.now();
    let stdout = "";
    try {
      if (!["javascript", "python", "powershell"].includes(request.language) || request.code.length > 20_000) throw new Error("Script inválido.");
      if (request.coderMode === "compute") {
        new ExecutionValidator(this.files.resources).analyzeCompute({ ...request, explanation: "Compute", capabilities });
        if ((request.input ?? "").length > 16000) throw new Error("Input compute excedeu o limite.");
      }
      const app = scriptApplication(request);
      if (request.language !== "javascript") {
        if (!app) throw new Error("Script de host sem escopo verificável; execução bloqueada.");
        request = { ...request, language: "javascript", code: `console.log(jarvis.openApp(${JSON.stringify(app)}));` };
      }
      if (capabilities.includes("network")) throw new Error("Rede não habilitada neste runtime.");
      const check = (operation: PermissionRequest) => {
        const approved = request.approvedRequests?.some(item => item.action === operation.action && item.resource === operation.resource);
        if (!approved && new PermissionManager().check(operation, request.authorization).decision !== "allow") {
          throw new Error("Operação fora do escopo aprovado: " + operation.action + " " + (operation.resource ?? ""));
        }
      };
      const QuickJS = await getQuickJS();
      const vm = QuickJS.newContext({ intrinsics: { ...DefaultIntrinsics, Promise: false } });
      const deadline = Date.now() + Math.min(request.timeoutMs ?? 1000, capabilities.some(capability => ["process_execution", "process_control"].includes(capability)) ? 10000 : 1000);
      vm.runtime.setMemoryLimit(16 * 1024 * 1024);
      vm.runtime.setMaxStackSize(256 * 1024);
      vm.runtime.setInterruptHandler(() => Date.now() >= deadline);
      let calls = 0;
      try {
        const api = vm.newObject();
        for (const [name, tool, capability] of [
          ["listFiles", "list_files", "filesystem_read"],
          ["readFile", "read_file", "filesystem_read"],
          ["writeFile", "write_file", "filesystem_write"],
          ["deleteFile", "delete_file", "filesystem_delete"],
        ] as const) {
          const fn = vm.newFunction(name, (arg) => {
            if (++calls > 32 || Date.now() >= deadline) throw new Error("Limite de operações do script atingido.");
            if (!capabilities.includes(capability)) throw new Error("Capacidade não aprovada: " + capability);
            const input = this.files.validate(tool, arg ? vm.dump(arg) : undefined);
            check({ action: tool === "list_files" ? "read_file" : tool,
              resource: this.files.resources.file(input.resource, input.path, this.files.mutates(tool)) });
            const result = this.files.run(tool, input);
            return vm.newString(JSON.stringify(result));
          });
          vm.setProp(api, name, fn);
          fn.dispose();
        }
        const openApp = vm.newFunction("openApp", (name, args) => {
          if (++calls > 1 || Date.now() >= deadline) throw new Error("Limite de abertura de aplicativos atingido.");
          if (!capabilities.includes("process_execution")) throw new Error("Execução de processos não foi aprovada.");
          const raw: unknown = name ? vm.dump(name) : undefined;
          const argumentsValue: unknown = args ? vm.dump(args) : [];
          const id = typeof raw === "string" ? applicationId(raw) : undefined;
          if (!id || !Array.isArray(argumentsValue) || argumentsValue.length) throw new Error("Processo ou argumentos fora do escopo permitido.");
          check({ action: "execute_process", resource: id });
          const executable = this.processes.resolve(id);
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("Tempo limite atingido durante a localização do aplicativo.");
          return vm.newString(this.processes.launch(executable, [], remaining));
        });
        vm.setProp(api, "openApp", openApp);
        const closeApp = vm.newFunction("closeApp", (name) => {
          if (++calls > 1 || Date.now() >= deadline) throw new Error("Limite de encerramento de aplicativos atingido.");
          if (!capabilities.includes("process_control")) throw new Error("Controle de processos não foi aprovado.");
          if (capabilities.some(capability => capability !== "process_control")) throw new Error("Encerramento deve ser a única capacidade do script.");
          const raw: unknown = name ? vm.dump(name) : undefined;
          const id = typeof raw === "string" ? applicationId(raw) : undefined;
          if (!id) throw new Error("Aplicativo fora da lista permitida para encerramento.");
          check({ action: "terminate_process", resource: id });
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("Tempo limite atingido durante o encerramento do aplicativo.");
          if (!this.processes.terminate) throw new Error("O runtime não oferece encerramento seguro de aplicativos.");
          return vm.newString(this.processes.terminate(id, remaining));
        });
        vm.setProp(api, "closeApp", closeApp);
        const childProcess = vm.newObject();
        vm.setProp(childProcess, "execFileSync", openApp);
        const requireFunction = vm.newFunction("require", name => {
          const module = name ? vm.dump(name) : undefined;
          if (!capabilities.includes("process_execution") || !["child_process", "node:child_process"].includes(module)) throw new Error("Módulo não autorizado.");
          return childProcess.dup();
        });
        if (capabilities.includes("process_execution")) vm.setProp(vm.global, "require", requireFunction);
        requireFunction.dispose();
        openApp.dispose();
        closeApp.dispose();
        if (request.coderMode !== "compute") vm.setProp(vm.global, "jarvis", api);
        api.dispose();
        if (request.coderMode === "compute") {
          const input = vm.newString(request.input ?? ""); vm.setProp(vm.global, "input", input); input.dispose();
        }
        const consoleObject = vm.newObject();
        const log = vm.newFunction("log", (...args) => {
          const line = args.map((arg) => {
            const value: unknown = vm.dump(arg);
            return typeof value === "string" ? value : JSON.stringify(value);
          }).join(" ") + "\n";
          if (stdout.length + line.length > 16_000) throw new Error("Limite de saída atingido.");
          stdout += line;
        });
        vm.setProp(consoleObject, "log", log);
        log.dispose();
        vm.setProp(vm.global, "console", consoleObject);
        consoleObject.dispose();
        const result = vm.evalCode(request.code, "task.js");
        childProcess.dispose();
        if (result.error) {
          const error: unknown = vm.dump(result.error);
          result.error.dispose();
          throw new Error(JSON.stringify(error));
        }
        result.value.dispose();
        // Scripts are synchronous. Do not silently discard deferred side effects.
        if (vm.runtime.hasPendingJob()) throw new Error("Use código síncrono, sem Promise ou async.");
      } finally {
        vm.dispose();
      }
      return { success: true, stdout, stderr: "", exitCode: 0, durationMs: Date.now() - startedAt };
    } catch (error) {
      return { success: false, stdout, stderr: error instanceof Error ? error.message : "Falha no script", exitCode: 1, durationMs: Date.now() - startedAt };
    }
  }

}
