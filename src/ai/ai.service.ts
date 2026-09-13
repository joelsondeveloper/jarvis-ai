import type { AIProvider } from "./ai.provider.js";

export class AIService {
  constructor(private readonly provider: AIProvider) {}

  async generate(
    input: string,
    previousInteractionId?: string | null,
  ): Promise<{
    text: string;
    interactionId: string;
  }> {
    return this.provider.generate(input, previousInteractionId);
  }

  async *generateStream(input: string, previousInteractionId?: string | null) {
    yield* this.provider.generateStream(input, previousInteractionId);
  }
}
