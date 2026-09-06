import type { Message } from "../conversation/message.js";

export class MemoryRepository {
  private readonly messages: Message[] = [];

  async save(message: Message): Promise<void> {
    this.messages.push(message);
  }

  async getAll(): Promise<Message[]> {
    return [...this.messages];
  }
}