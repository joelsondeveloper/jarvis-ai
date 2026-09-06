import type { Message } from "../conversation/message.js";
import { database } from "../database/database.js";

export class MemoryRepository {
   createConversation(): number {
    const statement = database.prepare(`
      INSERT INTO conversations DEFAULT VALUES
    `);

    const result = statement.run();

    return Number(result.lastInsertRowid);
  }


   async save(message: Message): Promise<void> {
    const statement = database.prepare(`
      INSERT INTO messages (
        conversation_id,
        role,
        content
      )
      VALUES (?, ?, ?)
    `);

    statement.run(
      message.conversationId,
      message.role,
      message.content,
    );
  }

  async getMessages(
    conversationId: number,
  ): Promise<Message[]> {
    const statement = database.prepare(`
      SELECT
        id,
        conversation_id AS conversationId,
        role,
        content,
        created_at AS createdAt
      FROM messages
      WHERE conversation_id = ?
      ORDER BY id ASC
    `);

    return statement.all(conversationId) as Message[];
  }
}
