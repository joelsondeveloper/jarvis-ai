import app from "./app.js";
import { AIService } from "./ai/ai.service.js";
import { FakeAIProvider } from "./ai/fake-ai.provider.js";
import { AgentService } from "./agent/agent.service.js";
import { MemoryRepository } from "./memory/memory.repository.js";
import { MemoryService } from "./memory/memory.service.js";

const PORT = 3000;

const aiProvider = new FakeAIProvider();

const aiService = new AIService(aiProvider);

const memoryRepository = new MemoryRepository();

const memoryService = new MemoryService(memoryRepository);

const agent = new AgentService(aiService, memoryService);

app.post("/conversations", async (_req, res) => {
  const conversationId = memoryService.createConversation();

  res.status(201).json({ id: conversationId });
});

app.post("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);
 
  const { prompt } = req.body;

  const response = await agent.process(conversationId, prompt);

  res.json({ response });
});

app.get("/conversations/:id/messages", async (req, res) => {
  const conversationId = Number(req.params.id);

  const messages = await memoryService.getMessages(conversationId);

  res.json({ messages });
});

app.get("/ai", async (req, res) => {
  const prompt = String(req.query.prompt ?? "");

  const response = await agent.process(conversationId, prompt);

  res.json({
    response,
  });
});

app.listen(PORT, () => {
  console.log(`JARVIS online at http://localhost:${PORT}`);
});