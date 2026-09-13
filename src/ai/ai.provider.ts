export type AIStreamEvent =
  | { type: "text"; text: string }
  | { type: "interaction"; interactionId: string };

export interface AIProvider {
  generate(
    input: string,
    previousInteractionId?: string | null,
  ): Promise<{
    text: string;
    interactionId: string;
  }>;

  generateStream(
    input: string,
    previousInteractionId?: string | null,
  ): AsyncGenerator<AIStreamEvent>;
}
