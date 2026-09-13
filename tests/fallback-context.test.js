import assert from "node:assert/strict";
import { test, after } from "node:test";

process.env.JARVIS_DATABASE_PATH = ":memory:";
const { database } = await import("../src/database/database.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { AIService } = await import("../src/ai/ai.service.ts");
const { AgentService } = await import("../src/agent/agent.service.ts");
const { MessageRouter } = await import("../src/conversation/message.router.ts");

const memory = new MemoryService(new MemoryRepository());
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
after(() => database.close());

test("fallback Groq recebe o histórico persistido e a mensagem atual sem interaction_id", async () => {
  const conversationId = memory.createConversation();
  await memory.addMessage({ conversationId, role: "user", content: "Meu nome é Joelson." });
  await memory.addMessage({ conversationId, role: "assistant", content: "Prazer, Joelson." });
  memory.setInteractionId(conversationId, "gemini-interaction-nao-enviado");
  const calls = [];
  const fallback = {
    respondFallback: async (context) => { calls.push(context); return "Seu nome é Joelson."; },
  };
  const failingGemini = {
    generate: async () => { throw Object.assign(new Error("quota"), { code: "quota_exceeded" }); },
    async *generateStream() { throw Object.assign(new Error("quota"), { code: "quota_exceeded" }); },
  };
  const agent = new AgentService(new AIService(failingGemini), memory, fallback);
  const events = await collect(agent.processStream(conversationId, "Qual é o meu nome?"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].currentUserMessage, "Qual é o meu nome?");
  assert.deepEqual(calls[0].recentMessages, [
    { role: "user", content: "Meu nome é Joelson." },
    { role: "assistant", content: "Prazer, Joelson." },
  ]);
  assert.match(calls[0].systemPrompt, /JARVIS/);
  assert.equal("interactionId" in calls[0], false);
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), "Seu nome é Joelson.");
  assert.equal(events.filter(event => event.type === "done").length, 1);
  const messages = await memory.getMessages(conversationId);
  assert.deepEqual(messages.slice(-2).map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Qual é o meu nome?" },
    { role: "assistant", content: "Seu nome é Joelson." },
  ]);
});

test("Gemini bem-sucedido não chama o fallback", async () => {
  const conversationId = memory.createConversation();
  let fallbackCalls = 0;
  const fallback = { respondFallback: async () => { fallbackCalls++; return "fallback"; } };
  const provider = {
    generate: async () => ({ text: "Resposta Gemini", interactionId: "gemini-ok" }),
    async *generateStream() { yield { type: "interaction", interactionId: "gemini-ok" }; yield { type: "text", text: "Resposta Gemini" }; },
  };
  const agent = new AgentService(new AIService(provider), memory, fallback);
  const events = await collect(agent.processStream(conversationId, "Olá"));
  assert.equal(fallbackCalls, 0);
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), "Resposta Gemini");
  assert.equal((await memory.getMessages(conversationId)).at(-1).content, "Resposta Gemini");
});

test("Gemini recupera contexto persistido quando interaction_id não existe", async () => {
  const conversationId = memory.createConversation();
  await memory.addMessage({ conversationId, role: "user", content: "Meu personagem favorito é Homem-Aranha." });
  await memory.addMessage({ conversationId, role: "assistant", content: "Anotado." });
  let capturedInput;
  const provider = {
    generate: async input => { capturedInput = input; return { text: "Homem-Aranha.", interactionId: "gemini-restored" }; },
    async *generateStream(input) { capturedInput = input; yield { type: "interaction", interactionId: "gemini-restored" }; yield { type: "text", text: "Homem-Aranha." }; },
  };
  const agent = new AgentService(new AIService(provider), memory);
  await collect(agent.processStream(conversationId, "Qual personagem eu falei?"));
  assert.match(capturedInput, /Homem-Aranha/);
  assert.match(capturedInput, /Qual personagem eu falei/);
});

test("Planner não recebe histórico conversacional", async () => {
  const conversationId = memory.createConversation();
  await memory.addMessage({ conversationId, role: "user", content: "Meu segredo é somente para a conversa." });
  let routeInput;
  const planner = { decide: async input => { routeInput = input; return { action: "respond", task: "", tool: "", args: "", response: "" }; } };
  const agent = { async *processStream() { yield { type: "text", text: "resposta" }; yield { type: "done" }; } };
  const orchestrator = { getToolDefinitions: () => [], startStream: async function* () { yield { type: "done" }; } };
  await collect(new MessageRouter(planner, memory, agent, orchestrator).stream(conversationId, "Explique closures."));
  const payload = JSON.parse(routeInput);
  assert.equal("history" in payload, false);
  assert.doesNotMatch(routeInput, /Meu segredo/);
});

test("fallback de narração recebe contexto e resultado real da Task", async () => {
  const conversationId = memory.createConversation();
  await memory.addMessage({ conversationId, role: "user", content: "Liste os arquivos da workspace." });
  let captured;
  const fallback = { respondFallback: async (context, _signal, taskResult) => { captured = { context, taskResult }; return "Encontrei real.txt."; } };
  const agent = new AgentService(new AIService({ generate: async () => { throw new Error("Gemini indisponível"); } }), memory, fallback);
  const text = await agent.summarizeTask({ id: "task-1", conversationId, userRequest: "Liste os arquivos da workspace.", status: "completed", authorization: { read: false, write: false, process: false, network: false }, currentStep: 0, steps: [{ id: "step-1", description: "Listar", status: "completed", attempts: 1, action: { kind: "tool", name: "list_directory", args: {} }, result: { success: true, output: '{"files":["real.txt"]}' } }], decisions: 1, consecutiveFailures: 0, createdAt: "", updatedAt: "" }, "fallback");
  assert.equal(text, "Encontrei real.txt.");
  assert.match(captured.context.recentMessages[0].content, /Liste os arquivos/);
  assert.match(captured.taskResult, /real\.txt/);
});

test("GroqFallbackProvider usa mensagens de chat e prompt próprio, sem interaction_id ou Planner", async () => {
  const oldKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "test-fallback-key";
  try {
    const { GroqFallbackProvider } = await import("../src/ai/groq-fallback.provider.ts");
    const provider = new GroqFallbackProvider();
    let request;
    provider.client.chat.completions.create = async input => {
      request = input;
      return { choices: [{ message: { content: "Resposta contextual." } }] };
    };
    const text = await provider.respondFallback({
      systemPrompt: "SYSTEM JARVIS",
      recentMessages: [{ role: "user", content: "Meu nome é Joelson." }],
      currentUserMessage: "Qual é meu nome?",
    });
    assert.equal(text, "Resposta contextual.");
    assert.equal(request.messages[0].role, "system");
    assert.match(request.messages[0].content, /SYSTEM JARVIS/);
    assert.doesNotMatch(request.messages[0].content, /PLANNER|EVALUATOR/);
    assert.deepEqual(request.messages.slice(1).map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "Meu nome é Joelson." },
      { role: "user", content: "Qual é meu nome?" },
    ]);
    assert.equal("previous_interaction_id" in request, false);
  } finally {
    if (oldKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldKey;
  }
});
