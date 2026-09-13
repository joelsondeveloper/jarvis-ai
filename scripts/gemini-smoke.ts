import "dotenv/config";
import { GeminiProvider } from "../src/ai/gemini.provider.js";

const started = Date.now();
let chunks = 0;
let text = "";
try {
  const provider = new GeminiProvider();
  console.log(JSON.stringify({ event: "request_started", model: process.env.GEMINI_MODEL ?? "gemini-3-flash-preview", hasInteractionId: false }));
  for await (const event of provider.generateStream("Responda apenas: JARVIS online")) {
    if (event.type === "interaction") console.log(JSON.stringify({ event: "interaction_created" }));
    else { chunks++; text += event.text; console.log(JSON.stringify({ event: "chunk", index: chunks, chars: event.text.length })); }
  }
  console.log(JSON.stringify({ event: "completed", chunks, chars: text.length, durationMs: Date.now() - started }));
} catch (error) {
  const value = error as { name?: string; status?: number; code?: string };
  console.error(JSON.stringify({ event: "error", name: value.name ?? "Error", status: value.status, code: value.code, message: error instanceof Error ? error.message.slice(0, 500) : "unknown", durationMs: Date.now() - started }));
  process.exitCode = 1;
}
