import express from "express";
import path from "node:path";

import { AgentService } from "./agent/agent.service.js";
import { AIService } from "./ai/ai.service.js";
import { GeminiProvider } from "./ai/gemini.provider.js";
import { MemoryRepository } from "./memory/memory.repository.js";
import { MemoryService } from "./memory/memory.service.js";

import { ConversationController } from "./controllers/conversation.controller.js";
import { createConversationRoutes } from "./routes/conversation.routes.js";

import { GroqProvider } from "./ai/groq.provider.js";
import { GroqFallbackProvider } from "./ai/groq-fallback.provider.js";
import { QwenCoderProvider } from "./ai/qwen-coder.provider.js";
import { TaskStateService } from "./task/task.state.js";
import { TaskOrchestrator } from "./orchestrator/task.orchestrator.js";
import { FileTools } from "./tools/file.tools.js";
import { ResourceResolver } from "./security/resource.resolver.js";
import { ScriptExecutor } from "./execution/script.executor.js";
import { MessageRouter } from "./conversation/message.router.js";
import { createRuntimeTools } from "./tools/native.tools.js";

const app = express();
// Browser requests from other origins must not control this local assistant.
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) {
        res.status(403).json({ error: "Origem não permitida." });
        return;
      }
    } catch {
      res.status(403).json({ error: "Origem inválida." });
      return;
    }
  }
  next();
});

app.use(express.json());

app.use(
  express.static(
    path.resolve(
      process.cwd(),
      "public",
    ),
  ),
);

const memory = new MemoryService(new MemoryRepository());
const ai = new AIService(new GeminiProvider());
const planner = new GroqProvider();
const fallback = new GroqFallbackProvider();
const agent = new AgentService(ai, memory, fallback);
const taskState = new TaskStateService();
taskState.recoverInterrupted();
const files = new FileTools(new ResourceResolver());
const registry = createRuntimeTools(files);
const orchestrator = new TaskOrchestrator(
  planner, new QwenCoderProvider(), taskState, files,
  new ScriptExecutor(files), memory, agent, registry,
);
const router = new MessageRouter(planner, memory, agent, orchestrator);
const conversationController = new ConversationController(memory, agent, orchestrator, router);

const conversationRoutes =
  createConversationRoutes(
    conversationController,
  );

app.use(
  conversationRoutes,
);

app.get("/", (_req, res) => {
  res.sendFile(
    path.resolve(
      process.cwd(),
      "public",
      "index.html",
    ),
  );
});

export default app;
