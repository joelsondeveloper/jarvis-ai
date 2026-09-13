import { randomUUID } from "node:crypto";
import type { AIProvider, AIStreamEvent } from "./ai.provider.js";

export class FakeAIProvider implements AIProvider {
  async generate(
    input: string,
    _previousInteractionId?: string | null,
  ): Promise<{ text: string; interactionId: string }> {
    return {
      text: `Você disse: ${input}`,
      interactionId: randomUUID(),
    };
  }

  async *generateStream(
    input: string,
    previousInteractionId?: string | null,
  ): AsyncGenerator<AIStreamEvent> {
    const result = await this.generate(input, previousInteractionId);

    yield { type: "interaction", interactionId: result.interactionId };
    yield { type: "text", text: result.text };
  }
}
