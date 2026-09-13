import { GoogleGenAI } from "@google/genai";
import type { AIProvider, AIStreamEvent } from "./ai.provider.js";
import { JARVIS_SYSTEM_PROMPT } from "./jarvis.system-prompt.js";

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;
  private readonly model = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY não foi configurada.");
    }

    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: 30_000 },
    });
  }

  async generate(input: string, previousInteractionId?: string | null): Promise<{text: string; interactionId: string}> {
    const startedAt = Date.now(); const debug = process.env.JARVIS_DEBUG_GEMINI === "1";
    try {
      const interaction = await this.client.interactions.create({
        model: this.model, input,
        system_instruction: JARVIS_SYSTEM_PROMPT,
        ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
      });
      if (debug) console.error(JSON.stringify({ provider: "gemini", event: "request_completed", hasInteractionId: Boolean(interaction.id), chars: (interaction.output_text ?? "").length, durationMs: Date.now() - startedAt }));
      return { text: interaction.output_text ?? "", interactionId: interaction.id };
    } catch (error) {
      if (debug) console.error(JSON.stringify({ provider: "gemini", event: "request_error", errorName: error instanceof Error ? error.name : "Error", errorCode: (error as { code?: string })?.code, errorStatus: (error as { status?: number })?.status, errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown", durationMs: Date.now() - startedAt }));
      throw error;
    }
  }

  async *generateStream(
  input: string,
  previousInteractionId?: string | null,
): AsyncGenerator<AIStreamEvent> {
  const startedAt = Date.now();
  const debug = process.env.JARVIS_DEBUG_GEMINI === "1";
  if (debug) console.error(JSON.stringify({ provider: "gemini", event: "request_started", model: this.model, hasInteractionId: Boolean(previousInteractionId) }));
  let stream;
  try {
    stream = await this.client.interactions.create({
      model: this.model, input,
      system_instruction: JARVIS_SYSTEM_PROMPT,
      stream: true,
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    });
  } catch (error) {
    if (debug) console.error(JSON.stringify({ provider: "gemini", event: "stream_open_error", errorName: error instanceof Error ? error.name : "Error", errorCode: (error as { code?: string })?.code, errorStatus: (error as { status?: number })?.status, errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown", durationMs: Date.now() - startedAt }));
    throw error;
  }

  let completed = false;
  let receivedAnyText = false;
  try { for await (const event of stream) {
    if (event.event_type === "error") {
      const detail = event.error as { message?: string; code?: string; status?: number } | undefined;
      const message = detail?.message || "O provedor interrompeu a resposta.";
      const error = new Error(message);
      Object.assign(error, { code: detail?.code, status: detail?.status });
      throw error;
    }
    if (event.event_type === "interaction.created") { yield { type: "interaction", interactionId: event.interaction.id }; continue; }
    if (event.event_type === "interaction.completed") { completed = true; continue; }
    if (event.event_type === "interaction.status_update" && ["failed", "cancelled", "incomplete", "budget_exceeded"].includes(event.status)) {
      throw new Error(`O provedor encerrou a interação com status ${event.status}.`);
    }
    if (event.event_type !== "step.delta" || event.delta.type !== "text") continue;
    const chunk = event.delta.text;
    if (!chunk) continue;
    if (debug) console.error(JSON.stringify({ provider: "gemini", event: "chunk", chunkHasText: true, firstText: !receivedAnyText }));
    receivedAnyText = true; yield { type: "text", text: chunk };
  } } catch (error) {
    if (debug) console.error(JSON.stringify({ provider: "gemini", event: "stream_error", errorName: error instanceof Error ? error.name : "Error", errorCode: (error as { code?: string })?.code, errorStatus: (error as { status?: number })?.status, errorMessage: error instanceof Error ? error.message.slice(0, 300) : "unknown", durationMs: Date.now() - startedAt }));
    throw error;
  }
  // A normally closed iterator is successful even if the SDK omits the optional
  // lifecycle completion event. Only an actual error event is an interruption.
  if (debug) console.error(JSON.stringify({ provider: "gemini", event: "stream_completed", lifecycleEvent: completed, receivedAnyText, durationMs: Date.now() - startedAt }));
}
}
