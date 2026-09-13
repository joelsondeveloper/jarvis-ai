import assert from "node:assert/strict";
import { test, after } from "node:test";
import { once } from "node:events";
import express from "express";
import { consumeStream } from "../public/stream.js";
import { VoiceService } from "../public/voice.js";

process.env.JARVIS_DATABASE_PATH = ":memory:";
const { database } = await import("../src/database/database.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { AIService } = await import("../src/ai/ai.service.ts");
const { FakeAIProvider } = await import("../src/ai/fake-ai.provider.ts");
const { AgentService } = await import("../src/agent/agent.service.ts");
const { ConversationController } = await import("../src/controllers/conversation.controller.ts");
const { createConversationRoutes } = await import("../src/routes/conversation.routes.ts");

const app = express();
app.use(express.json());
const provider = new FakeAIProvider();
const memory = new MemoryService(new MemoryRepository());
const agent = new AgentService(new AIService(provider), memory);
app.use(createConversationRoutes(new ConversationController(memory, agent)));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
});
const post = (path, body) => fetch(base + path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("cria conversa, responde via SSE e recupera histórico e contexto", async () => {
  const created = await post("/conversations");
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const response = await post(`/conversations/${id}/messages/stream`, { prompt: "  Olá ação  " });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  let text = "";
  await consumeStream(response.body, (chunk) => { text += chunk; });
  assert.equal(text, "Você disse: Olá ação");
  const history = await (await fetch(base + `/conversations/${id}/messages`)).json();
  assert.deepEqual(history.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "Olá ação" },
    { role: "assistant", content: text },
  ]);
  assert.ok(memory.getInteractionId(id));
  const reply = await post(`/conversations/${id}/messages`, { prompt: "Segunda mensagem" });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).response, "Você disse: Segunda mensagem");
  assert.equal((await memory.getMessages(id)).length, 4);
});

test("rejeita IDs inválidos, conversas ausentes e mensagens inválidas antes do SSE", async () => {
  const { id } = await (await post("/conversations")).json();
  for (const invalidId of ["abc", "0", "-1", "1.5", "9007199254740992"]) {
    assert.equal((await fetch(base + `/conversations/${invalidId}/messages`)).status, 400);
  }
  assert.equal((await fetch(base + "/conversations/999999/messages")).status, 404);
  for (const suffix of ["messages", "messages/stream"]) {
    assert.equal((await post(`/conversations/999999/${suffix}`, { prompt: "oi" })).status, 404);
    for (const body of [undefined, {}, { prompt: "" }, { prompt: "  " }, { prompt: 5 }, { prompt: "a".repeat(10001) }]) {
      const response = await post(`/conversations/${id}/${suffix}`, body);
      assert.equal(response.status, 400);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.ok((await response.json()).error);
    }
  }
  assert.equal((await memory.getMessages(id)).length, 0);
});

function fragmented(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
}

test("SSE mantém JSON e UTF-8 fragmentados inclusive com CRLF", async () => {
  let result = "";
  await consumeStream(fragmented('data: {"type":"text","text":"ação 🤖"}\r\n\r\ndata: {"type":"done"}\r\n\r\n'), (text) => { result += text; });
  assert.equal(result, "ação 🤖");
});

test("SSE apresenta erro do servidor e detecta término prematuro", async () => {
  await assert.rejects(consumeStream(fragmented('data: {"type":"error","message":"Falha no modelo"}\n\n'), () => {}), /Falha no modelo/);
  await assert.rejects(consumeStream(fragmented('data: {"type":"text","text":"parcial"}\n\n'), () => {}), /interrompida/);
});
test("interface cria conversa, envia para o ID retornado e recupera histórico ao reabrir", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace('import { consumeStream } from "./stream.js";', "")
    .replace('import { VoiceService } from "./voice.js";', "");
  const storage = new Map();
  async function openPage() {
    const children = [];
    const input = { value: "", disabled: false, focus() {} };
    const button = { disabled: false };
    const messages = {
      appendChild(element) { children.push(element); },
      replaceChildren() { children.length = 0; },
      scrollTop: 0,
      scrollHeight: 0,
    };
    let submit;
    const form = {
      querySelector() { return button; },
      addEventListener(_name, handler) { submit = handler; },
    };
    const status = {};
    runInNewContext(source, {
      requestAnimationFrame: (callback) => setTimeout(callback, 0),
      document: {
        visibilityState: "visible",
        getElementById(id) { return { "chat-form": form, prompt: input, messages }[id]; },
        querySelector() { return status; },
        createElement() { return { textContent: "", className: "" }; },
      },
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      fetch: (path, options) => fetch(base + path, options),
      consumeStream,
      VoiceService,
      console,
    });
    const deadline = Date.now() + 5000;
    while (button.disabled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(button.disabled, false, "inicialização deve terminar");
    assert.equal(status.textContent, "● ONLINE");
    return { input, children, submit };
  }
  const page = await openPage();
  const id = Number(storage.get("jarvis.conversationId"));
  assert.ok(id > 0);
  page.input.value = "Mensagem da interface";
  await page.submit({ preventDefault() {} });
  assert.equal(page.children.at(-1).textContent, "Você disse: Mensagem da interface");
  const reopened = await openPage();
  assert.equal(Number(storage.get("jarvis.conversationId")), id);
  assert.deepEqual(reopened.children.map((element) => element.textContent), [
    "Mensagem da interface", "Você disse: Mensagem da interface",
  ]);
  storage.set("jarvis.conversationId", "999999");
  await openPage();
  assert.notEqual(storage.get("jarvis.conversationId"), "999999");
});
test("SSE aguarda a atualização visual antes do próximo evento do mesmo bloco", async () => {
  let release;
  const paint = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const stream = consumeStream(fragmented(
    'data: {"type":"text","text":"primeiro"}\n\ndata: {"type":"text","text":"segundo"}\n\ndata: {"type":"done"}\n\n'
  ), async (text) => {
    seen.push(text);
    if (text === "primeiro") await paint;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["primeiro"]);
  } finally {
    release();
  }
  await stream;
  assert.deepEqual(seen, ["primeiro", "segundo"]);
});

test("HTTP entrega o primeiro trecho enquanto a IA ainda está gerando", { timeout: 5000 }, async () => {
  let release;
  let first;
  const gate = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { first = resolve; });
  const original = provider.generateStream;
  provider.generateStream = async function* () {
    yield { type: "interaction", interactionId: "stream-progress-test" };
    yield { type: "text", text: "Primeiro " };
    await gate;
    yield { type: "text", text: "segundo" };
  };
  let consuming;
  try {
    const { id } = await (await post("/conversations")).json();
    const response = await post(`/conversations/${id}/messages/stream`, { prompt: "Streaming" });
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    let output = "";
    let complete = false;
    consuming = consumeStream(response.body, (text) => { output += text; first(); })
      .then(() => { complete = true; });
    await arrived;
    assert.equal(output, "Primeiro ");
    assert.equal(complete, false);
    release();
    await consuming;
    assert.equal(output, "Primeiro segundo");
    assert.equal(complete, true);
  } finally {
    release();
    provider.generateStream = original;
    if (consuming) await consuming;
  }
});
