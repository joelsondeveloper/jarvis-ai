import type { AIProvider } from "./ai.provider.js";

export class AIService {
    constructor(private readonly provider: AIProvider) {}

    async generate(prompt: string): Promise<string> {
        return this.provider.generate(prompt);
    }
}