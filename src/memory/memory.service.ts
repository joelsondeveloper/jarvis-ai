import type { Message } from "../conversation/message.js";
import { MemoryRepository } from "./memory.repository.js";

export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  createConversation(): number {
    return this.repository.createConversation();
  }

  async addMessage(message: Message): Promise<void> {
    await this.repository.save(message);
  }

  async getMessages(conversationId: number): Promise<Message[]> {
    return this.repository.getMessages(conversationId);
  }
}
