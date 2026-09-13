import { randomUUID } from "node:crypto";
import { parseDecision, type OrchestratorDecision } from "./orchestrator.types.js";
import { parseCoderResult, type CoderResult } from "../ai/qwen-coder.provider.js";
import type { AgentService } from "../agent/agent.service.js";
import type { MemoryService } from "../memory/memory.service.js";
import { TaskStateService } from "../task/task.state.js";
import type { ChatEvent, TaskState, TaskStep } from "../task/task.types.js";
import { FileTools } from "../tools/file.tools.js";
import { ScriptExecutor } from "../execution/script.executor.js";
import { ExecutionValidator } from "../security/execution.validator.js";
import { PermissionManager, type AuthorizationContext, type PermissionRequest } from "../security/permission.manager.js";
import { createRuntimeTools } from "../tools/native.tools.js";
import type { ToolRegistry } from "../tools/tool.registry.js";
import { withDeadline, TaskTimeoutError } from "../task/deadline.js";
import { deriveAuthorization } from "../security/authorization.js";
import { scriptApplication } from "../security/script.scope.js";
import type { PlanProvider, PlanStep } from "../task/plan.types.js";
import { PlanValidator, resolveArguments, resultValue } from "../task/plan.validator.js";
import { actionSignature } from "../task/action.signature.js";
import { closePlan } from "../task/terminal.plan.js";

export class WorkflowError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
type Planner = { decide(input: string, signal?: AbortSignal): Promise<OrchestratorDecision> } & Partial<PlanProvider>;
type Coder = { generate(input: string, signal?: AbortSignal): Promise<CoderResult> };
const MAX_STEPS = 6;
const MAX_DECISIONS = 8;
const MAX_FAILURES = 2;

export class TaskOrchestrator {
  private readonly busy = new Set<number>();
  private readonly permissions = new PermissionManager();
  constructor(
    private readonly planner: Planner,
    private readonly coder: Coder,
    private readonly state: TaskStateService,
    private readonly files: FileTools,
    private readonly executor: Pick<ScriptExecutor, "execute">,
    private readonly memory: MemoryService,
    private readonly agent: AgentService,
    private readonly registry: ToolRegistry = createRuntimeTools(files),
    private readonly deadlines = { plannerMs: 45000, coderMs: 45000, executionMs: 30000, narrationMs: 15000 },
  ) {}

  latest(conversationId: number) { return this.state.latest(conversationId); }
  getToolDefinitions() { return this.registry.getDefinitions(); }

  get(conversationId: number, taskId: string): TaskState {
    const task = this.state.get(taskId);
    if (!task || task.conversationId !== conversationId) throw new WorkflowError("Tarefa não encontrada.", 404);
    return task;
  }

  assertCanStart(conversationId: number): void {
    const task = this.latest(conversationId);
    if (this.busy.has(conversationId) || (task && ["planning", "running", "waiting_permission"].includes(task.status))) {
      throw new WorkflowError("Conclua ou cancele a tarefa pendente antes de enviar outra mensagem.");
    }
  }

  checkApproval(conversationId: number, taskId: string, approvalId: string): TaskState {
    const task = this.get(conversationId, taskId);
    if (this.busy.has(conversationId) || task.status !== "waiting_permission" || task.pending?.id !== approvalId) {
      throw new WorkflowError("Esta aprovação já foi usada ou não corresponde à tarefa pendente.");
    }
    return task;
  }

  async *startStream(conversationId: number, input: string, initialDecision?: OrchestratorDecision): AsyncGenerator<ChatEvent> {
    this.assertCanStart(conversationId);
    this.busy.add(conversationId);
    const authorization = this.authorizationFrom(input);
    const task = this.state.create(conversationId, input, authorization);
    try {
      await this.memory.addMessage({ conversationId, role: "user", content: input });
      yield this.event(task);
      yield { type: "task_started", task: structuredClone(task) };
      if (this.planner.plan) {
        task.decisions++;
        let draft: unknown; let plannerError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            draft = await withDeadline("planejamento do Groq", this.deadlines.plannerMs, signal => this.planner.plan!(JSON.stringify({
              request: input, tools: this.registry.getDefinitions(), authorization,
              coder: "Transformações personalizadas usam CoderStep coderMode=compute em JavaScript síncrono, sem efeitos. Quando a tarefa é executável, não há Tool suficiente e o runtime oferece uma ponte restrita, use CoderStep coderMode=script; para fechar Spotify ou Bloco de Notas use somente process_control e a ponte closeApp no alvo pedido. Python/PowerShell somente templates reconhecidos pelo ExecutionValidator; sem shell arbitrário. Tools first.",
              limits: { steps: MAX_STEPS, attempts: MAX_FAILURES }, feedback: attempt ? "A resposta anterior violou o contrato. Corrija o JSON, separando ToolStep e CoderStep; uma operação de arquivo comum deve ser somente ToolStep e um encerramento de aplicativo deve ser coderMode=script com process_control." : "",
            }), signal));
            task.plan = new PlanValidator(this.registry).normalize(draft, task.id, input); plannerError = undefined; break;
          } catch (error) { plannerError = error; if (attempt === 1) throw error; }
        }
        if (plannerError || !task.plan) throw plannerError instanceof Error ? plannerError : new Error("Planner não produziu plano válido.");
        task.planVersions = []; task.formatVersion = 2;
        this.state.save(task);
        yield { type: "task_planned", task: structuredClone(task) };
      }
      yield* this.advance(task, initialDecision);
    } catch (error) {
      yield* this.failure(task, error);
    } finally { this.busy.delete(conversationId); }
  }

  private authorizationFrom(input: string): AuthorizationContext {
    return deriveAuthorization(input, this.files.resources);
  }

  private permissionFor(task: TaskState, requests: PermissionRequest[]): { confirm?: PermissionRequest } {
    let confirm: PermissionRequest | undefined;
    for (const request of requests) {
      const result = this.permissions.check(request, task.authorization);
      if (result.decision === "deny") throw new WorkflowError(result.reason, 403);
      if (result.decision === "confirm" && (!confirm || request.action === "delete_file")) confirm = request;
    }
    return confirm ? { confirm } : {};
  }

  async *resumeStream(conversationId: number, taskId: string, approvalId: string, allow: boolean): AsyncGenerator<ChatEvent> {
    const task = this.checkApproval(conversationId, taskId, approvalId);
    this.busy.add(conversationId);
    const approval = task.pending!;
    delete task.pending;
    task.status = "running";
    // Consume the approval durably BEFORE any side effect.
    this.state.save(task);
    try {
      if (!allow) {
        await this.finish(task, "cancelled", "Tarefa cancelada. A ação pendente não foi executada.");
        yield { type: "text", text: task.response! };
        yield this.event(task);
        yield { type: "done" };
        return;
      }
      if (Date.parse(approval.expiresAt) <= Date.now()) throw new Error("A aprovação expirou. Faça um novo pedido para revisar a ação novamente.");
      const step = task.steps.find((item) => item.id === approval.stepId);
      if (!step || step.status !== "pending") throw new Error("Etapa de aprovação inválida.");
      yield* this.execute(task, step, true);
      yield* this.advance(task);
    } catch (error) {
      yield* this.failure(task, error);
    } finally { this.busy.delete(conversationId); }
  }

  private event(task: TaskState): ChatEvent {
    return { type: "task", task: structuredClone(task) };
  }

  private async *advance(task: TaskState, initialDecision?: OrchestratorDecision): AsyncGenerator<ChatEvent> {
    if (task.plan) { yield* this.advancePlan(task); return; }
    // Compatibility for old tasks/providers without the plan contract.
    while (task.decisions < MAX_DECISIONS) {
      if (task.consecutiveFailures >= MAX_FAILURES) throw new Error("Limite de tentativas atingido. Confira os resultados antes de tentar novamente.");
      task.status = "planning";
      task.decisions++;
      this.state.save(task);
      yield this.event(task);
      yield { type: "status", task: structuredClone(task) };
      const decision = parseDecision(initialDecision ?? await withDeadline("avaliação do Groq", this.deadlines.plannerMs, signal => this.planner.decide(JSON.stringify({
        request: task.userRequest, tools: this.registry.getDefinitions(),
        steps: task.steps.map((step) => ({
          description: step.description, action: step.action, status: step.status,
          result: step.result ? { success: step.result.success, output: step.result.output.slice(0, 12_000), toolResult: step.result.toolResult } : null,
          error: step.error ?? null,
        })),
        limits: { remainingSteps: MAX_STEPS - task.steps.length, remainingDecisions: MAX_DECISIONS - task.decisions },
      }), signal)));
      initialDecision = undefined;

      if (decision.action === "respond") {
        if (task.steps.length) {
          await this.finish(task, "failed", decision.response || "Não consegui concluir todas as etapas. Confira os resultados já obtidos.");
          yield { type: "text", text: task.response! };
          yield { type: "task_failed", task: structuredClone(task) };
        } else if (decision.response) {
          await this.finish(task, "completed", decision.response);
          yield { type: "text", text: task.response! };
        } else {
          let response = "";
          // User message was already saved above.
          const stream = this.agent.processStream(task.conversationId, task.userRequest, false);
          const endsAt = Date.now() + this.deadlines.narrationMs;
          while (true) {
            const remaining = endsAt - Date.now();
            if (remaining <= 0) throw new TaskTimeoutError("resposta de conversa");
            const next = await withDeadline("resposta de conversa", remaining, () => stream.next());
            if (next.done) break;
            const event = next.value;
            if (event.type === "text" && event.text !== undefined) {
              response += event.text;
              yield { type: "text", text: event.text };
            }
          }
          task.response = response;
          task.status = "completed";
          this.state.save(task);
        }
        yield this.event(task);
        yield { type: "done" };
        return;
      }
      if (decision.action === "complete") {
        const last = task.steps.at(-1);
        if (!last?.result?.success) throw new Error("O orquestrador tentou concluir sem uma execução bem-sucedida.");
        // Execution is terminal independently of the narration provider.
        task.status = "completed";
        task.response = last.result.output;
        this.state.save(task);
        yield { type: "task_completed", task: structuredClone(task) };
        yield this.event(task);
        await this.finish(task, "completed", decision.response || last.result.output);
        yield { type: "text", text: task.response! };
        yield this.event(task);
        yield { type: "done" };
        return;
      }
      if (task.steps.length >= MAX_STEPS) throw new Error("Limite de etapas atingido. A tarefa não foi concluída.");
      let step: TaskStep;
      if (decision.action === "tool") {
        const tool = this.registry.get(decision.tool);
        if (!tool) throw new Error("Ferramenta desconhecida: " + decision.tool);
        const args = tool.validate(JSON.parse(decision.args));
        step = {
          id: randomUUID(), description: decision.task || decision.tool, status: "pending",
          attempts: task.consecutiveFailures + 1,
          action: { kind: "tool", name: decision.tool, args },
        };
        if (step.action.kind === "tool" && tool.fingerprint) step.action.fingerprint = tool.fingerprint(args);
      } else {
        const script = parseCoderResult(await withDeadline("geração de código", this.deadlines.coderMs, signal => this.coder.generate(JSON.stringify({
          request: task.userRequest, step: decision.task,
          authorization: task.authorization,
          tools: this.registry.getDefinitions(),
          previousResults: task.steps.map((item) => ({ result: item.result, error: item.error })),
        }), signal)));
        new ExecutionValidator(this.files.resources).analyze(script);
        step = { id: randomUUID(), description: decision.task || script.explanation,
          status: "pending", attempts: task.consecutiveFailures + 1, action: { kind: "script", script } };
      }
      task.steps.push(step);
      task.currentStep = task.steps.length - 1;
      const requests = this.requestsFor(step);
      const permission = this.permissionFor(task, requests);
      if (permission.confirm) {
        task.status = "waiting_permission";
        task.pending = {
          id: randomUUID(), stepId: step.id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          action: permission.confirm.action,
          ...(permission.confirm.resource ? { resource: permission.confirm.resource } : {}),
          summary: permission.confirm.action === "delete_file"
            ? `Excluir o arquivo indicado (${permission.confirm.resource ?? "recurso não identificado"}). Exclusão sempre exige sua confirmação.`
            : step.action.kind === "script"
            ? `Executar código ${step.action.script.language} com as capacidades: ${step.action.script.capabilities.join(", ") || "nenhuma"}. A ação será executada no ambiente aprovado.`
            : `Usar a ferramenta ${step.action.name} com os argumentos indicados. A ação está fora do escopo já autorizado.`,
        };
        this.state.save(task);
        yield this.event(task);
        yield { type: "confirmation_required", task: structuredClone(task) };
        yield { type: "done" };
        return;
      }
      yield* this.execute(task, step);
    }
    throw new Error("Limite de decisões atingido. A tarefa não foi concluída.");
  }

  private unexpected(task: TaskState, step: PlanStep): boolean {
    if (!step.expect || step.evaluated || step.status !== "completed") return false;
    try { return JSON.stringify(resultValue(task.plan!, step.id, step.expect.path)) !== JSON.stringify(step.expect.value); }
    catch { return true; }
  }

  private async *evaluatePlan(task: TaskState, step: PlanStep): AsyncGenerator<ChatEvent> {
    if (!this.planner.evaluate || task.decisions >= MAX_DECISIONS) throw new Error("Não foi possível adaptar o plano dentro do limite de decisões.");
    task.decisions++; task.status = "planning"; this.state.save(task);
    yield { type: "status", task: structuredClone(task) };
    const raw = await withDeadline("avaliação do plano", this.deadlines.plannerMs, signal => this.planner.evaluate!(JSON.stringify({
      request: task.userRequest, plan: task.plan, currentStep: step, results: task.steps,
      tools: this.registry.getDefinitions(), remainingExecutions: MAX_STEPS - task.steps.length,
      condition: step.error || "Resultado diferente da expectativa declarada.",
    }), signal));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Avaliação inválida.");
    const decision = raw as Record<string, unknown>;
    if (Object.keys(decision).some(key => !["action", "reason", "steps"].includes(key)) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 2000) throw new Error("Avaliação inválida.");
    const reason = decision.reason;
    switch (decision.action) {
      case "retry":
        if (step.reasonCode === "COMPUTE_EFFECT_FORBIDDEN") throw new Error("Retry da estratégia compute com efeitos proibidos foi bloqueado; separe I/O em Tools.");
        if (step.reasonCode === "PROCESS_CONTROL_TEMPLATE_FORBIDDEN") throw new Error("Retry do controle de processos bloqueado; use somente a ponte de encerramento restrita para o alvo solicitado.");
        if (step.status !== "failed" || step.result?.success || step.attempts >= MAX_FAILURES || task.consecutiveFailures >= MAX_FAILURES) throw new Error("Retry não permitido: limite atingido ou efeito já realizado.");
        step.status = "pending"; step.reason = reason; delete step.evaluated;
        break;
      case "continue":
        if (step.status !== "completed" || !step.result?.success) throw new Error("Não é permitido continuar uma etapa sem sucesso.");
        step.evaluated = true; step.reason = reason;
        break;
      case "skip":
        if (step.status === "completed") step.evaluated = true;
        else step.status = "skipped";
        step.reason = reason;
        break;
      case "modify_plan": {
        const blocked = task.plan!.steps.filter(item => ["COMPUTE_EFFECT_FORBIDDEN", "PROCESS_CONTROL_TEMPLATE_FORBIDDEN"].includes(item.reasonCode ?? ""));
        if (blocked.length && (!Array.isArray(decision.steps) || !decision.steps.some(item => item?.kind === "tool") || decision.steps.some(item => item?.kind === "coder" && (item.coderMode === "script" || blocked.some(old => old.execution.kind === "coder" && old.execution.task === item.coderTask))))) {
          throw new Error("Replan repetiu uma estratégia de Coder bloqueada. Reformule a etapa e mantenha os efeitos externos em Tools ou pontes verificadas.");
        }
        const previous = structuredClone(task.plan!);
        const preserved = structuredClone(previous.steps.filter(item => item.status !== "pending")).map(item => {
          if (item.status === "failed") { item.status = "skipped"; item.reason = reason; }
          if (item.status === "completed") item.evaluated = true;
          return item;
        });
        // All old identifiers are reserved, including abandoned pending steps.
        if (!Array.isArray(decision.steps) || decision.steps.some(value => value && typeof value === "object" && previous.steps.some(old => old.id === (value as { id?: unknown }).id))) throw new Error("Replan não pode reescrever etapas antigas.");
        const next = new PlanValidator(this.registry).normalize({ steps: decision.steps }, task.id, task.userRequest, preserved);
        next.id = previous.id; next.version = previous.version + 1; next.createdAt = previous.createdAt;
        task.planVersions ??= []; task.planVersions.push(previous); task.plan = next;
        break;
      }
      case "complete":
        if (task.plan!.steps.some(item => !["completed", "skipped_duplicate"].includes(item.status)) || !step.result?.success) throw new Error("Conclusão sem todas as etapas comprovadas foi bloqueada.");
        step.evaluated = true;
        break;
      case "fail": throw new Error(reason);
      default: throw new Error("Ação de avaliação desconhecida.");
    }
    this.state.save(task);
    yield { type: "plan_updated", task: structuredClone(task) };
  }

  private async *advancePlan(task: TaskState): AsyncGenerator<ChatEvent> {
    while (true) {
      const plan = task.plan!;
      const problem = plan.steps.find(step => step.status === "failed" || this.unexpected(task, step));
      if (problem) { yield* this.evaluatePlan(task, problem); continue; }
      const next = plan.steps.find(step => step.status === "pending");
      if (!next) {
        if (!task.steps.some(step => step.result?.success) || plan.steps.some(step => step.status === "running")) throw new Error("Plano sem resultado concluído.");
        const output = plan.steps.map(step => `${step.description}: ${step.status}\n${step.result?.output || step.error || step.reason || ""}`).join("\n").slice(0, 12000);
        plan.status = "completed"; task.status = "completed"; task.response = output;
        this.state.save(task);
        yield { type: "task_completed", task: structuredClone(task) };
        await this.finish(task, "completed", output);
        yield { type: "text", text: task.response! }; yield this.event(task); yield { type: "done" }; return;
      }
      if (task.steps.length >= MAX_STEPS || next.attempts >= MAX_FAILURES || task.consecutiveFailures >= MAX_FAILURES) throw new Error("Limite de execução ou tentativas atingido.");
      let step: TaskStep;
      try {
        if (next.dependsOn.some(id => !plan.steps.some(item => item.id === id && ["completed", "skipped_duplicate"].includes(item.status)))) throw new Error("Dependência não concluída; a etapa não pode executar.");
        const action = next.execution;
        if (action.kind === "tool") {
          const tool = this.registry.get(action.toolName)!;
          // Normalize before deduplication, but defer mutable filesystem checks to execution.
          const args = (tool.validatePlan ?? tool.validate)(resolveArguments(action.arguments, plan));
          const signature = actionSignature(action.toolName, args);
          const prior = task.steps.find(item => item.signature === signature && item.occurrence === next.occurrence && item.result?.success);
          if (prior) {
            next.status = "skipped_duplicate"; next.reason = "Ação equivalente já executada com sucesso nesta tarefa.";
            if (prior.result) next.result = structuredClone(prior.result);
            this.state.save(task); yield { type: "plan_updated", task: structuredClone(task) }; continue;
          }
          tool.validate(args);
          step = { id: randomUUID(), planStepId: next.id, description: next.description, status: "pending", attempts: next.attempts + 1,
            signature, occurrence: next.occurrence, action: { kind: "tool", name: action.toolName, args } };
          if (tool.fingerprint && step.action.kind === "tool") step.action.fingerprint = tool.fingerprint(args);
        } else {
          const mode = action.coderMode ?? "compute";
          const input = String(resolveArguments({ input: action.input ?? "" }, plan).input);
          if (input.length > 16000) throw new Error("Input compute excedeu o limite de 16000 caracteres.");
          const script = parseCoderResult(await withDeadline("geração de código", this.deadlines.coderMs, signal => this.coder.generate(JSON.stringify({
            request: task.userRequest, step: action.task, authorization: task.authorization, tools: this.registry.getDefinitions(),
            coderMode: mode, input, constraints: mode === "compute"
              ? "PURE COMPUTE: use a variável global input e console.log para output. Capabilities vazias. Nenhum I/O; leitura e escrita são outras etapas Tools."
              : "SCRIPT EFFECTFUL RESTRITO: use somente a capability necessária e as pontes verificadas. Para fechar um aplicativo sem Tool nativa, use exatamente console.log(jarvis.closeApp(\"spotify\")) ou console.log(jarvis.closeApp(\"notepad\")) conforme o alvo solicitado, com capability process_control. Não use taskkill, Stop-Process, child_process, shell, comandos concatenados, curingas ou outro alvo.",
            previousResults: task.steps.map(item => ({ planStepId: item.planStepId, result: item.result, error: item.error })),
          }), signal)));
          const validator = new ExecutionValidator(this.files.resources);
          if (mode === "compute") validator.analyzeCompute(script); else validator.analyze(script);
          step = { id: randomUUID(), planStepId: next.id, description: next.description, status: "pending", attempts: next.attempts + 1, action: { kind: "script", script, coderMode: mode, input } };
        }
      } catch (error) {
        next.status = "failed"; next.attempts++; next.error = error instanceof Error ? error.message : "Falha preparando etapa.";
        if (error && typeof error === "object" && "code" in error && typeof error.code === "string") next.reasonCode = error.code;
        task.consecutiveFailures++; this.state.save(task);
        yield { type: "step_failed", task: structuredClone(task) };
        if (error instanceof TaskTimeoutError) throw error;
        continue;
      }
      task.steps.push(step); task.currentStep = task.steps.length - 1;
      const permission = this.permissionFor(task, this.requestsFor(step));
      if (permission.confirm) {
        task.status = "waiting_permission";
        task.pending = { id: randomUUID(), stepId: step.id, expiresAt: new Date(Date.now() + 600000).toISOString(),
          action: permission.confirm.action, ...(permission.confirm.resource ? { resource: permission.confirm.resource } : {}),
          summary: `Autorizar ${next.description}? Revise a ação abaixo. Exclusão sempre exige confirmação.` };
        this.state.save(task); yield { type: "confirmation_required", task: structuredClone(task) }; yield { type: "done" }; return;
      }
      yield* this.execute(task, step);
    }
  }

  private requestsFor(step: TaskStep): PermissionRequest[] {
    if (step.action.kind === "script" && step.action.coderMode === "compute") { new ExecutionValidator(this.files.resources).analyzeCompute(step.action.script); return []; }
    if (step.action.kind === "script") return new ExecutionValidator(this.files.resources).analyze(step.action.script);
    const tool = this.registry.get(step.action.name);
    if (!tool) throw new Error("Ferramenta desconhecida: " + step.action.name);
    return tool.permissions(tool.validate(step.action.args));
  }

  private async *execute(task: TaskState, step: TaskStep, confirmed = false): AsyncGenerator<ChatEvent> {
    task.status = "running";
    step.status = "running";
    const planned = task.plan?.steps.find(item => item.id === step.planStepId);
    if (planned) { planned.status = "running"; planned.attempts = step.attempts; }
    this.state.save(task);
    yield this.event(task);
    if (planned) yield { type: "step_started", task: structuredClone(task) };
    if (step.action.kind === "tool") yield { type: "tool_started", tool: step.action.name, taskId: task.id, stepId: step.id, message: `Executando ${step.action.name}...` };
    try {
      const requests = this.requestsFor(step);
      if (!confirmed && this.permissionFor(task, requests).confirm) throw new Error("Ação exige confirmação antes da execução.");
      if (step.action.kind === "tool") {
        const action = step.action;
        const tool = this.registry.get(action.name);
        if (!tool) throw new Error("Ferramenta indisponível.");
        if (tool.fingerprint && tool.fingerprint(action.args) !== action.fingerprint) {
          throw new Error("O arquivo mudou após a revisão. A ação foi bloqueada; é necessária uma nova aprovação.");
        }
        const result = await withDeadline("ferramenta " + action.name, this.deadlines.executionMs, signal => tool.execute(action.args, { conversationId: task.conversationId, taskId: task.id,
          authorization: task.authorization, approvedRequests: confirmed ? requests : [], workspace: this.files.resources.resolve("workspace"), signal }));
        step.result = { success: result.success, output: JSON.stringify(result.success ? result.data : result.error), toolResult: result };
        if (!result.success) step.error = result.error.message;
      } else {
        const script = parseCoderResult(step.action.script);
        const scriptAction = step.action;
        if (step.action.coderMode === "compute") new ExecutionValidator(this.files.resources).analyzeCompute(script);
        new ExecutionValidator(this.files.resources).analyze(script);
        const result = await withDeadline("execução do script", this.deadlines.executionMs, () => this.executor.execute({ language: script.language, code: script.code,
          ...(scriptAction.coderMode ? { coderMode: scriptAction.coderMode } : {}), ...(scriptAction.input !== undefined ? { input: scriptAction.input } : {}),
          timeoutMs: script.capabilities.some(capability => ["process_execution", "process_control"].includes(capability)) ? 10000 : 1000,
          authorization: task.authorization, approvedRequests: confirmed ? requests : [],
        }, script.capabilities));
        step.result = { success: result.success, output: result.stdout };
        if (!result.success) step.error = result.stderr;
      }
    } catch (error) {
      step.result = { success: false, output: "" };
      step.error = error instanceof Error ? error.message : "Falha na execução.";
      if (error instanceof TaskTimeoutError) {
        step.status = "failed";
        if (planned) { planned.status = "failed"; planned.error = step.error; planned.result = step.result; }
        this.state.save(task);
        if (planned) yield { type: "step_failed", task: structuredClone(task) };
        if (step.action.kind === "tool") yield { type: "tool_failed", tool: step.action.name, taskId: task.id, stepId: step.id, message: "Tempo limite da ferramenta atingido." };
        // A timed-out side effect may be partial: never ask the planner to retry it.
        throw error;
      }
    }
    step.status = step.result.success ? "completed" : "failed";
    if (planned) {
      planned.status = step.status; planned.result = structuredClone(step.result);
      if (step.error) planned.error = step.error; else delete planned.error;
    }
    task.consecutiveFailures = step.result.success ? 0 : task.consecutiveFailures + 1;
    this.state.save(task);
    yield this.event(task);
    if (planned) yield { type: step.result.success ? "step_completed" : "step_failed", task: structuredClone(task) };
    if (step.action.kind === "tool") yield { type: step.result.success ? "tool_completed" : "tool_failed", tool: step.action.name, taskId: task.id, stepId: step.id,
      message: step.result.success ? `Ferramenta ${step.action.name} concluída.` : `Falha na ferramenta ${step.action.name}.` };
  }

  private async finish(task: TaskState, status: TaskState["status"], response: string): Promise<void> {
    task.status = status;
    if (task.plan && (status === "failed" || status === "cancelled")) closePlan(task.plan, status);
    if (task.plan && (status === "completed" || status === "failed" || status === "cancelled")) task.plan.status = status;
    task.response = response;
    delete task.pending;
    this.state.save(task);
    if (status === "completed" && task.steps.length) {
      try { response = await withDeadline("resposta final do Gemini", this.deadlines.narrationMs, signal => this.agent.summarizeTask(structuredClone(task), response, signal)); }
      catch {
        response = "A execução terminou. Resultado obtido: " + (task.steps.at(-1)?.result?.output.slice(0, 12000) || response);
      }
    }
    if (/spotify/i.test(task.userRequest) && /música|musica|toque|tocar|coloque|reproduz/i.test(task.userRequest) && task.steps.some(step => {
      const spotify = step.action.kind === "script" ? scriptApplication(step.action.script) === "spotify" : step.action.name === "open_app" && step.action.args.app === "spotify";
      if (!spotify || !step.result?.success) return false;
      try { return JSON.parse(step.result.output).started === true; } catch { return false; }
    })) {
      response = "A abertura do Spotify foi solicitada ao Windows. O controle de reprodução de música ainda não está implementado; nenhuma música foi selecionada ou iniciada pelo JARVIS.";
    }
    task.response = response;
    delete task.pending;
    await this.memory.addMessage({ conversationId: task.conversationId, role: "assistant", content: response });
    this.state.save(task);
  }

  private async *failure(task: TaskState, error: unknown): AsyncGenerator<ChatEvent> {
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    const detail = status === 429
      ? "O serviço de IA atingiu um limite temporário. Aguarde um pouco e envie o pedido novamente."
      : status === 401 || status === 403
        ? "O provedor de IA recusou o acesso. Confira a configuração das chaves no servidor."
        : error instanceof Error ? error.message : "Erro inesperado.";
    const running = task.steps.find((step) => step.status === "running");
    if (running) { running.status = "failed"; running.error = detail; }
    task.error = { code: error instanceof TaskTimeoutError ? error.code : "TASK_FAILED", message: detail };
    await this.finish(task, "failed", "Não consegui concluir a tarefa: " + detail);
    yield { type: "text", text: task.response! };
    yield this.event(task);
    yield { type: "task_failed", task: structuredClone(task) };
    yield { type: "done" };
  }
}
