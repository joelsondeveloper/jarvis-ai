import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../tools/tool.registry.js";
import type { TaskPlan, PlanStep } from "./plan.types.js";
import { notepadRepeatCount } from "./action.signature.js";

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plano deve conter objetos válidos.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 2000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Texto do plano inválido.");
  return value;
};
function keys(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some(key => !names.includes(key))) throw new Error("Campo não permitido no plano.");
}
export function resultValue(plan: TaskPlan, id: string, path: string): unknown {
  const step = plan.steps.find(item => item.id === id);
  if (!step || !["completed", "skipped_duplicate"].includes(step.status)) throw new Error("Dependência sem resultado concluído: " + id);
  let value: unknown = { output: step.result?.output, data: step.result?.toolResult?.success ? step.result.toolResult.data : undefined };
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || ["__proto__", "prototype", "constructor"].includes(part) || !Object.hasOwn(value, part)) throw new Error("Referência de resultado inválida.");
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function resolveArguments(args: Record<string, unknown>, plan: TaskPlan): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? value.replace(/\{\{([\w-]+)\.([\w.]+)\}\}/g, (_, id: string, path: string) => {
    const result = resultValue(plan, id, path);
    return typeof result === "string" ? result : JSON.stringify(result);
  }) : value]));
}

export class PlanValidator {
  constructor(private readonly registry: ToolRegistry) {}
  normalize(input: unknown, taskId: string, goal: string, preserved: PlanStep[] = []): TaskPlan {
    const raw = record(input); keys(raw, ["steps"]);
    if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length + preserved.length > 6) throw new Error("Plano deve ter de 1 a 6 etapas, incluindo histórico preservado.");
    const known = new Set(preserved.map(step => step.id));
    const steps: PlanStep[] = [];
    for (const value of raw.steps) {
      const item = record(value); keys(item, ["id", "description", "status", "kind", "tool", "args", "coderTask", "coderMode", "input", "dependsOn", "occurrence", "expect"]);
      const id = text(item.id, 80);
      if (!/^[\w-]+$/.test(id) || known.has(id)) throw new Error("IDs do plano devem ser únicos; etapas antigas não podem ser reescritas.");
      if (item.status !== undefined && item.status !== "pending") throw new Error("Etapa inicial deve ser pending.");
      const dependencies = Array.isArray(item.dependsOn) ? [...item.dependsOn] : item.dependsOn ?? [];
      if (!Array.isArray(dependencies) || dependencies.some(dep => typeof dep !== "string" || !known.has(dep))) throw new Error("Dependências devem apontar para etapas anteriores.");
      const occurrence = item.occurrence ?? 1;
      if (!Number.isInteger(occurrence) || Number(occurrence) < 1) throw new Error("Ocorrência inválida.");
      let execution: PlanStep["execution"];
      if (item.kind === "tool") {
        if (item.coderMode !== undefined || item.input !== undefined || item.coderTask !== undefined) throw new Error("ToolStep não pode conter campos de Coder.");
        const name = text(item.tool, 100); const tool = this.registry.get(name);
        if (!tool) throw new Error("Ferramenta desconhecida no plano: " + name);
        const args = record(typeof item.args === "string" ? JSON.parse(item.args) : item.args);
        const sample = { ...args }; let hasBindings = false;
        for (const [key, value] of Object.entries(args)) if (typeof value === "string") {
          sample[key] = value.replace(/\{\{([\w-]+)\.([\w.]+)\}\}/g, (_, ref: string, path: string) => {
            if (!known.has(ref) || !/^(output|data(?:\.[\w]+)*)$/.test(path)) throw new Error("Referência de resultado inválida no plano.");
            if (!dependencies.includes(ref)) dependencies.push(ref);
            hasBindings = true;
            return key === "path" || key === "destinationPath" ? "result.txt" : "resultado";
          });
        }
        const validated = (tool.validatePlan ?? tool.validate)(sample);
        const max = name === "open_app" && validated.app === "notepad" ? notepadRepeatCount(goal) : 1;
        if (Number(occurrence) > max) throw new Error("Repetição não autorizada pelo pedido do usuário.");
        execution = { kind: "tool", toolName: name, arguments: hasBindings ? args : validated };
      } else if (item.kind === "coder") {
        if (item.tool !== undefined || item.args !== undefined) throw new Error("CoderStep não pode conter campos de Tool.");
        if (occurrence !== 1) throw new Error("Repetição de código não autorizada.");
        const coderMode = item.coderMode ?? "compute";
        if (!["compute", "script"].includes(String(coderMode))) throw new Error("Modo Coder inválido.");
        if (coderMode === "compute" && /(?:feche|fechar|encerre|encerrar|finalize|finalizar)\s+(?:o\s+)?(?:spotify|spotify\.exe|bloco de notas|notepad(?:\.exe)?)/i.test(`${goal} ${item.description ?? ""} ${item.coderTask ?? ""}`)) {
          throw new Error("Encerramento de aplicativo exige CoderStep com coderMode=script e process_control.");
        }
        const input = item.input ?? "";
        if (typeof input !== "string" || input.length > 16000) throw new Error("Input compute inválido ou acima de 16000 caracteres.");
        for (const match of input.matchAll(/\{\{([\w-]+)\.([\w.]+)\}\}/g)) {
          if (!known.has(match[1]!) || !/^(output|data(?:\.[\w]+)*)$/.test(match[2]!)) throw new Error("Referência compute inválida.");
          if (!dependencies.includes(match[1]!)) dependencies.push(match[1]!);
        }
        execution = { kind: "coder", task: text(item.coderTask, 10000), coderMode: coderMode as "compute" | "script", input };
      } else throw new Error("Mecanismo de plano desconhecido.");
      const step: PlanStep = { id, description: text(item.description), status: "pending", execution, dependsOn: [...new Set(dependencies)] as string[], occurrence: Number(occurrence), attempts: 0 };
      if (item.expect !== undefined && item.expect !== null) {
        const expectation = record(item.expect); keys(expectation, ["path", "value"]);
        if (typeof expectation.path !== "string" || !/^(output|data(?:\.[\w]+)*)$/.test(expectation.path) || !Object.hasOwn(expectation, "value") || (expectation.value !== null && !["string", "number", "boolean"].includes(typeof expectation.value))) throw new Error("Expectativa de resultado inválida.");
        step.expect = { path: text(expectation.path, 200), value: expectation.value };
      }
      steps.push(step); known.add(id);
    }
    const now = new Date().toISOString();
    return { id: randomUUID(), taskId, goal, version: 1, status: "active", steps: [...structuredClone(preserved), ...steps], createdAt: now, updatedAt: now };
  }
}
