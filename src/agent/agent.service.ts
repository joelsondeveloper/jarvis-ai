import { AIService } from "../ai/ai.service.js";
import type { Message } from "../conversation/message.js";

export class AgentService {
  private readonly messages: Message[] = [];

  constructor(private readonly ai: AIService) {}

  async process(input: string): Promise<string> {
    this.messages.push({ role: "user", content: input });

    const response = await this.ai.generate(input);

    this.messages.push({ role: "assistant", content: response });

    return response;
  }
}
