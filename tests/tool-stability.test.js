import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import express from "express";
process.env.JARVIS_DATABASE_PATH = ":memory:";
const { database } = await import("../src/database/database.ts");
const { ApplicationLauncher } = await import("../src/execution/application.launcher.ts");
const { SystemRuntime } = await import("../src/tools/system.runtime.ts");
const { createRuntimeTools } = await import("../src/tools/native.tools.ts");
const { ResourceResolver } = await import("../src/security/resource.resolver.ts");
const { deriveAuthorization } = await import("../src/security/authorization.ts");
const { FileTools } = await import("../src/tools/file.tools.ts");
const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
const { TaskOrchestrator } = await import("../src/orchestrator/task.orchestrator.ts");
const { TaskStateService } = await import("../src/task/task.state.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { AgentService } = await import("../src/agent/agent.service.ts");
const { AIService } = await import("../src/ai/ai.service.ts");
const { FakeAIProvider } = await import("../src/ai/fake-ai.provider.ts");
const { MessageRouter } = await import("../src/conversation/message.router.ts");
const { ConversationController } = await import("../src/controllers/conversation.controller.ts");
const { createConversationRoutes } = await import("../src/routes/conversation.routes.ts");
const root = mkdtempSync(join(tmpdir(), "jarvis-stability-"));
const downloads = join(root, "downloads"); mkdirSync(downloads);
writeFileSync(join(downloads, "real.txt"), "resultado real");
const files = new FileTools(new ResourceResolver(join(root, "workspace"), downloads));
const memory = new MemoryService(new MemoryRepository());
const agent = new AgentService(new AIService(new FakeAIProvider()), memory);
const states = new TaskStateService();
const decision = (action, fields = {}) => ({ action, task: "", tool: "", args: "", response: "", ...fields });
const listing = () => decision("tool", { tool: "list_directory", args: JSON.stringify({ resource: "downloads", path: "." }) });
const complete = () => decision("complete");
const pending = () => new Promise(() => {});
const deadlines = { plannerMs: 50, coderMs: 50, executionMs: 1000, narrationMs: 50 };
const aumid = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify";
const context = name => ({ conversationId: 1, taskId: "test", authorization: deriveAuthorization(`Abra o ${name}.`, files.resources) });
function platform(overrides = {}) {
  const calls = [];
  return { calls, driver: {
    win32: () => undefined,
    protocolRegistered: async () => false,
    spotifyAumid: async () => undefined,
    launchWin32: async path => { calls.push(["win32", path]); return 123; },
    activate: async target => { calls.push(["activate", target]); },
    ...overrides,
  } };
}
function setup(planner, options = {}) {
  const registry = options.registry ?? createRuntimeTools(files);
  const workflow = new TaskOrchestrator(planner, options.coder ?? { generate: async () => ({ language: "javascript", code: 'console.log("calculado")', explanation: "Cálculo", capabilities: [] }) },
    states, files, options.executor ?? new ScriptExecutor(files), memory, options.agent ?? agent, registry, { ...deadlines, ...options.deadlines });
  return { workflow, id: memory.createConversation() };
}
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }
function terminal(workflow, id, events, expected) {
  assert.equal(workflow.latest(id).status, expected);
  assert.equal(events.filter(event => event.type === "done").length, 1);
  assert.equal(events.at(-1).type, "done");
  assert.doesNotThrow(() => workflow.assertCanStart(id));
}
after(() => { database.close(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("jarvis-stability-")); rmSync(root, { recursive: true, force: true }); });

test("Notepad conserva lançamento Win32 e PID", async () => {
  const p = platform({ win32: () => "C:\\Windows\\System32\\notepad.exe" });
  const result = await new ApplicationLauncher(p.driver).open("notepad");
  assert.equal(result.launchMethod, "win32"); assert.equal(result.pid, 123); assert.equal(p.calls.length, 1);
});
test("Spotify empacotado nunca executa diretamente WindowsApps", async () => {
  const p = platform({ win32: () => "C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_x64\\Spotify.exe", spotifyAumid: async () => aumid });
  const result = await new ApplicationLauncher(p.driver).open("spotify");
  assert.equal(result.launchMethod, "aumid"); assert.equal(result.pid, undefined); assert.equal(result.activationRequested, true);
  assert.deepEqual(p.calls, [["activate", "shell:AppsFolder\\" + aumid]]);
});
test("falha Win32 usa protocolo conhecido como fallback", async () => {
  const p = platform({ win32: () => "C:\\Spotify\\Spotify.exe", launchWin32: async () => { throw new Error("EPERM"); }, protocolRegistered: async () => true });
  const result = await new ApplicationLauncher(p.driver).open("spotify");
  assert.equal(result.launchMethod, "protocol"); assert.deepEqual(p.calls, [["activate", "spotify:"]]);
});
test("falha de protocolo usa AUMID validado e não aceita AUMID arbitrário", async () => {
  const calls = [];
  const p = platform({ protocolRegistered: async () => true, spotifyAumid: async () => aumid,
    activate: async target => { calls.push(target); if (target === "spotify:") throw new Error("Falhou"); } });
  assert.equal((await new ApplicationLauncher(p.driver).open("spotify")).launchMethod, "aumid");
  assert.deepEqual(calls, ["spotify:", "shell:AppsFolder\\" + aumid]);
  const bad = platform({ spotifyAumid: async () => aumid + ";calc.exe" });
  await assert.rejects(new ApplicationLauncher(bad.driver).open("spotify"), { code: "app_not_launchable" });
  assert.equal(bad.calls.length, 0);
});
test("aplicativo não localizável retorna ToolResult estruturado", async () => {
  const p = platform();
  const registry = createRuntimeTools(files, new SystemRuntime(new ApplicationLauncher(p.driver)));
  const result = await registry.get("open_app").execute({ app: "spotify" }, context("Spotify"));
  assert.equal(result.success, false); assert.equal(result.error.code, "app_not_launchable");
  assert.deepEqual(result.data, { app: "spotify", launchMethod: null });
  await assert.rejects(new ApplicationLauncher(p.driver).open("unknown"), { code: "app_not_launchable" });
});
test("open_app rejeita argumentos extras antes de escolher estratégia", async () => {
  const p = platform({ protocolRegistered: async () => true });
  const registry = createRuntimeTools(files, new SystemRuntime(new ApplicationLauncher(p.driver)));
  for (const args of [{ app: "spotify", args: ["arbitrary"] }, { app: "spotify:track:123" }, { app: "spotify", launchMethod: "win32" }]) {
    assert.equal((await registry.get("open_app").execute(args, context("Spotify"))).success, false);
  }
  assert.equal(p.calls.length, 0);
});
test("Spotify empacotado segue Tool → Groq, sem Qwen", async () => {
  const p = platform({ spotifyAumid: async () => aumid });
  const registry = createRuntimeTools(files, new SystemRuntime(new ApplicationLauncher(p.driver)));
  const { workflow, id } = setup({ decide: async input => {
    assert.equal(JSON.parse(input).steps[0].result.toolResult.data.launchMethod, "aumid"); return complete();
  } }, { registry, coder: { generate: async () => { assert.fail("Qwen não deve ser chamado"); } } });
  const events = await collect(workflow.startStream(id, "Abra o Spotify.", decision("tool", { tool: "open_app", args: '{"app":"spotify"}' })));
  terminal(workflow, id, events, "completed");
});

for (const [label, next, expected] of [
  ["complete", async () => complete(), "completed"],
  ["decisão vazia", async () => undefined, "failed"],
  ["decisão inválida", async () => ({ action: "invented" }), "failed"],
  ["exceção", async () => { throw new Error("Falha Groq"); }, "failed"],
  ["promise pendente", pending, "failed"],
]) test(`após list_directory, Groq ${label}: estado terminal e done único`, { timeout: 2000 }, async () => {
  const { workflow, id } = setup({ decide: async input => {
    assert.equal(JSON.parse(input).steps[0].result.toolResult.success, true); return next();
  } });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
  terminal(workflow, id, events, expected);
  if (expected === "failed") { assert.ok(workflow.latest(id).error.code); assert.ok(events.some(event => event.type === "task_failed")); }
});
test("resultado tardio do Groq não ressuscita tarefa expirada", { timeout: 2000 }, async () => {
  let resolve;
  const { workflow, id } = setup({ decide: () => new Promise(r => { resolve = r; }) });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
  terminal(workflow, id, events, "failed");
  const saved = workflow.latest(id);
  resolve(complete()); await new Promise(r => setImmediate(r));
  assert.deepEqual(workflow.latest(id), saved);
});
for (const [label, generate] of [["falha", async () => { throw new Error("Gemini falhou"); }], ["pendente", pending]]) {
  test(`Gemini ${label}: completed persistido antes da narração, fallback e done`, { timeout: 2000 }, async () => {
    let workflow, id;
    const localAgent = new AgentService(new AIService({ generate: async () => {
      assert.equal(workflow.latest(id).status, "completed"); return generate();
    } }), memory);
    ({ workflow, id } = setup({ decide: async () => complete() }, { agent: localAgent }));
    const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
    terminal(workflow, id, events, "completed");
    assert.equal(events.filter(event => event.type === "task_completed").length, 1);
    assert.match(events.filter(event => event.type === "text").map(event => event.text).join(""), /real.txt/);
    assert.equal((await memory.getMessages(id)).length, 2);
  });
}
test("Gemini tardio não modifica histórico nem interaction ID após fallback", { timeout: 2000 }, async () => {
  let resolve;
  const localAgent = new AgentService(new AIService({ generate: () => new Promise(r => { resolve = r; }) }), memory);
  const { workflow, id } = setup({ decide: async () => complete() }, { agent: localAgent });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing())); terminal(workflow, id, events, "completed");
  const before = memory.getInteractionId(id);
  const messages = await memory.getMessages(id);
  resolve({ interactionId: "late", text: "late" }); await new Promise(r => setImmediate(r));
  assert.equal(memory.getInteractionId(id), before); assert.deepEqual(await memory.getMessages(id), messages);
});
test("Coder pendente após ToolResult encerra tarefa", { timeout: 2000 }, async () => {
  const { workflow, id } = setup({ decide: async () => decision("coder") }, { coder: { generate: pending } });
  terminal(workflow, id, await collect(workflow.startStream(id, "Liste Downloads.", listing())), "failed");
  assert.equal(workflow.latest(id).error.code, "TASK_STAGE_TIMEOUT");
});
test("Tool pendente encerra SSE e nunca é repetida automaticamente", { timeout: 2000 }, async () => {
  let calls = 0;
  const registry = createRuntimeTools(files);
  registry.register({ definition: { type: "function", name: "hang", description: "Teste", parameters: {} }, validate: () => ({}), permissions: () => [],
    execute: () => { calls++; return pending(); } });
  const { workflow, id } = setup({ decide: async () => decision("tool", { tool: "hang", args: "{}" }) }, { registry, deadlines: { executionMs: 50 } });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
  terminal(workflow, id, events, "failed"); assert.equal(calls, 1); assert.equal(workflow.latest(id).error.code, "TASK_STAGE_TIMEOUT");
});
test("ScriptExecutor pendente não deixa running ou retry automático", { timeout: 2000 }, async () => {
  let calls = 0;
  const { workflow, id } = setup({ decide: async () => decision("coder") }, { executor: { execute: () => { calls++; return pending(); } }, deadlines: { executionMs: 50 } });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
  terminal(workflow, id, events, "failed"); assert.equal(calls, 1);
});
test("Tool falha e Groq complete não produz sucesso", async () => {
  const { workflow, id } = setup({ decide: async () => complete() });
  const events = await collect(workflow.startStream(id, "Leia missing.txt.", decision("tool", { tool: "read_file", args: '{"resource":"workspace","path":"missing.txt"}' })));
  terminal(workflow, id, events, "failed"); assert.equal(events.some(event => event.type === "task_completed"), false);
});
for (const mechanism of ["tool", "coder"]) test(`sucesso seguido de ${mechanism} continua e termina`, async () => {
  let calls = 0;
  const { workflow, id } = setup({ decide: async () => ++calls === 1 ? (mechanism === "tool" ? listing() : decision("coder")) : complete() });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
  terminal(workflow, id, events, "completed"); assert.equal(workflow.latest(id).steps.length, 2);
});
test("limite de etapas continua terminando loops com done único", async () => {
  const { workflow, id } = setup({ decide: async () => listing() });
  const events = await collect(workflow.startStream(id, "Liste Downloads.", listing()));
  terminal(workflow, id, events, "failed"); assert.equal(workflow.latest(id).steps.length, 6);
});
for (const hangs of [false, true]) test(`HTTP list_directory fecha SSE ${hangs ? "após timeout" : "após complete"}`, { timeout: 3000 }, async () => {
  const planner = { decide: async input => JSON.parse(input).phase === "route" ? listing() : hangs ? pending() : complete() };
  const { workflow, id } = setup(planner);
  const app = express(); app.use(express.json()); app.use(createConversationRoutes(new ConversationController(memory, agent, workflow, new MessageRouter(planner, memory, agent, workflow))));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/conversations/${id}/messages/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Liste Downloads." }), signal: AbortSignal.timeout(2000),
    });
    const body = await response.text(); // Reaching here proves EOF, not only a done frame.
    const events = body.split("\n\n").filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, "")));
    terminal(workflow, id, events, hangs ? "failed" : "completed");
  } finally { await new Promise(resolve => server.close(resolve)); }
});
