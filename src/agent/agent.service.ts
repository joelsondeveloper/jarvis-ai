import { AIService } from "../ai/ai.service.js";

export class AgentService {
  constructor(private readonly ai: AIService) {}

  async process(input: string): Promise<string> {
    return this.ai.generate(input);
  }
}