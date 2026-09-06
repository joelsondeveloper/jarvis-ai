import type { Message } from "../conversation/message.js";

export interface AIProvider {
  generate(messages: Message[]): Promise<string>;
}