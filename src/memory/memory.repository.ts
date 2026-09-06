import type { Message } from "../conversation/message.js";
import { database } from "../database/database.js";

export class MemoryRepository {
  private readonly messages: Message[] = [];

  async save(message: Message): Promise<void> {
    const statement = database.prepare(`
      INSERT INTO messages (role, content)
      VALUES (?, ?)
    `);

    statement.run(message.role, message.content);
  }

  async getAll(): Promise<Message[]> {
    const statement = database.prepare(`
      SELECT role, content
      FROM messages
      ORDER BY id ASC
    `);

    return statement.all() as Message[];
  }
}
