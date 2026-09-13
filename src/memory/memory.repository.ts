import type { Message } from "../conversation/message.js";
import { database } from "../database/database.js";

export class MemoryRepository {
  hasConversation(conversationId: number): boolean {
    return database.prepare("SELECT 1 FROM conversations WHERE id = ?").get(conversationId) !== undefined;
  }

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

  getInteractionId(
  conversationId: number,
): string | null {
  const statement = database.prepare(`
    SELECT interaction_id AS interactionId
    FROM conversations
    WHERE id = ?
  `);

  const conversation = statement.get(
    conversationId,
  ) as { interactionId?: string } | undefined;

  return conversation?.interactionId ?? null;
}

setInteractionId(
  conversationId: number,
  interactionId: string,
): void {
  const statement = database.prepare(`
    UPDATE conversations
    SET interaction_id = ?
    WHERE id = ?
  `);

  statement.run(
    interactionId,
    conversationId,
  );
}
}
