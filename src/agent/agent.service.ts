import { AIService } from "../ai/ai.service.js";
import type { Message } from "../conversation/message.js";
import { MemoryService } from "../memory/memory.service.js";

export class AgentService {
  constructor(
    private readonly ai: AIService,
    private readonly memory: MemoryService,
  ) {}

  async process(conversationId: number, input: string): Promise<string> {
    const userMessage: Message = {
      conversationId,
      role: "user",
      content: input,
    };

    await this.memory.addMessage(userMessage);

    const messages = await this.memory.getMessages(conversationId);

    const response = await this.ai.generate(messages);

    const assistantMessage: Message = {
      conversationId,
      role: "assistant",
      content: response,
    };

    await this.memory.addMessage(assistantMessage);

    return response;
  }
}
