import type { AIProvider } from "./ai.provider.js";

export class FakeAIProvider implements AIProvider {
  async generate(prompt: string): Promise<string> {
    return `Você disse: ${prompt}`;
  }
}