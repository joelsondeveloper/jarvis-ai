import { GoogleGenAI } from "@google/genai";
import type { AIProvider } from "./ai.provider.js";
import type { Message } from "../conversation/message.js";
import { JARVIS_SYSTEM_PROMPT} from "./jarvis.system-prompt.js";

export class GeminiProvider implements AIProvider {
  private readonly client: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY não foi configurada.");
    }

    this.client = new GoogleGenAI({
      apiKey,
    });
  }

  async generate(messages: Message[]): Promise<string> {
    const contents = messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: message.content,
        },
      ],
    }));

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.models.generateContent({
          model: "gemini-3-flash-preview",
          contents,
          config: {
            systemInstruction: JARVIS_SYSTEM_PROMPT
          }
        });

        return response.text ?? "";
      } catch (error) {
        const isLastAttempt = attempt === maxAttempts;

        if (isLastAttempt) {
          throw error;
        }

        const delay = 1000 * 2 ** (attempt - 1);

        console.log(
          `Gemini indisponível. Tentativa ${attempt}/${maxAttempts}. ` +
            `Tentando novamente em ${delay}ms...`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error("Falha ao gerar resposta.");
  }
}
