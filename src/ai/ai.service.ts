import type { AIProvider } from "./ai.provider.js";
import type { Message } from "../conversation/message.js";

export class AIService {
    constructor(private readonly provider: AIProvider) {}

    async generate(messages: Message[]): Promise<string> {
        return this.provider.generate(messages);
    }
}