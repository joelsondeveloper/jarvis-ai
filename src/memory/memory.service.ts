import type { Message } from "../conversation/message.js";
import { MemoryRepository } from "./memory.repository.js";

export class MemoryService {
  constructor(private readonly repository: MemoryRepository) {}

  async addMessage(message: Message): Promise<void> {
    await this.repository.save(message);
  }

  async getMessages(): Promise<Message[]> {
    return this.repository.getAll();
  }
}