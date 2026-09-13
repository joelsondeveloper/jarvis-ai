import type { GroqProvider } from "../ai/groq.provider.js";
import type { OrchestratorDecision } from "./orchestrator.types.js";

export class OrchestratorService {
  constructor(private readonly grok: GroqProvider) {}

  async decide(input: string): Promise<OrchestratorDecision> {
    return this.grok.decide(input);
  }
}
