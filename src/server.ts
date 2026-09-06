import app from "./app.js";
import { AIService } from "./ai/ai.service.js";
import { FakeAIProvider } from "./ai/fake-ai.provider.js";
import { AgentService } from "./agent/agent.service.js";

const PORT = 3000;

const aiProvider = new FakeAIProvider();
const aiService = new AIService(aiProvider);
const agent = new AgentService(aiService);

app.get("/ai", async (req, res) => {
  const prompt = String(req.query.prompt ?? "");

  const response = await agent.process(prompt);

  res.json({
    response,
  });
});

app.listen(PORT, () => {
  console.log(`JARVIS online at http://localhost:${PORT}`);
});