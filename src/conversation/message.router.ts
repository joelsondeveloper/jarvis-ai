import type { AgentService } from "../agent/agent.service.js";
import type { MemoryService } from "../memory/memory.service.js";
import type { TaskOrchestrator } from "../orchestrator/task.orchestrator.js";
import { parseDecision, type OrchestratorDecision } from "../orchestrator/orchestrator.types.js";
import { withDeadline } from "../task/deadline.js";

/** Classification happens before creating a task or asking Gemini for an answer. */
export class MessageRouter {
  constructor(
    private readonly planner: { decide(input: string, signal?: AbortSignal): Promise<OrchestratorDecision> },
    private readonly memory: MemoryService,
    private readonly agent: AgentService,
    private readonly orchestrator: TaskOrchestrator,
  ) {}

  async *stream(conversationId: number, input: string) {
    const decision = parseDecision(await withDeadline("classificação inicial do Groq", 45000, signal => this.planner.decide(JSON.stringify({
      phase: "route", request: input,
      tools: this.orchestrator.getToolDefinitions(), steps: [],
    }), signal)));
    if (decision.action === "respond") {
      yield* this.agent.processStream(conversationId, input);
    } else if (decision.action === "coder" || decision.action === "tool") {
      yield* this.orchestrator.startStream(conversationId, input, decision);
    } else {
      throw new Error("Classificação inválida: não é possível concluir antes de executar.");
    }
  }
}
