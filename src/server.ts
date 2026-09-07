import "dotenv/config";

import app from "./app.js";
import { AIService } from "./ai/ai.service.js";
import { GeminiProvider } from "./ai/gemini.provider.js";
import { AgentService } from "./agent/agent.service.js";
import { MemoryRepository } from "./memory/memory.repository.js";
import { MemoryService } from "./memory/memory.service.js";
import { ConversationController } from "./controllers/conversation.controller.js";
import { createConversationRoutes } from "./routes/conversation.routes.js";

const PORT = 3000;

const aiProvider = new GeminiProvider();

const aiService = new AIService(aiProvider);

const memoryRepository = new MemoryRepository();

const memoryService = new MemoryService(
  memoryRepository,
);

const agent = new AgentService(
  aiService,
  memoryService,
);

const conversationController =
  new ConversationController(
    memoryService,
    agent,
  );

app.use(
  createConversationRoutes(
    conversationController,
  ),
);

app.listen(PORT, () => {
  console.log(
    `JARVIS online at http://localhost:${PORT}`,
  );
});