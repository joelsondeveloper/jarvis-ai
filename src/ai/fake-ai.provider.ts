import type { AIProvider } from "./ai.provider.js";
import type { Message } from "../conversation/message.js";

export class FakeAIProvider implements AIProvider {
  async generate(messages: Message[]): Promise<string> {
    const lastMessage = messages[messages.length - 1];
    return `Você disse: ${lastMessage?.content ?? ""}`;
  }
}