import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { once } from "node:events";
import express from "express";
import { consumeStream } from "../public/stream.js";
process.env.JARVIS_DATABASE_PATH = ":memory:";
const { database } = await import("../src/database/database.ts");
const { ResourceResolver } = await import("../src/security/resource.resolver.ts");
const { deriveAuthorization } = await import("../src/security/authorization.ts");
const { FileTools } = await import("../src/tools/file.tools.ts");
const { createRuntimeTools } = await import("../src/tools/native.tools.ts");
const { TaskOrchestrator } = await import("../src/orchestrator/task.orchestrator.ts");
const { TaskStateService } = await import("../src/task/task.state.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { AgentService } = await import("../src/agent/agent.service.ts");
const { AIService } = await import("../src/ai/ai.service.ts");
const { FakeAIProvider } = await import("../src/ai/fake-ai.provider.ts");
const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
const { MessageRouter } = await import("../src/conversation/message.router.ts");
const { ConversationController } = await import("../src/controllers/conversation.controller.ts");
const { createConversationRoutes } = await import("../src/routes/conversation.routes.ts");
const root = mkdtempSync(join(tmpdir(), "jarvis-native-"));
const workspace = join(root, "workspace"), downloads = join(root, "downloads");
mkdirSync(workspace); mkdirSync(downloads); mkdirSync(join(workspace, "destination"));
writeFileSync(join(workspace, "teste.txt"), "conteúdo real");
writeFileSync(join(downloads, "entrada.json"), '{"real":true}');
const files = new FileTools(new ResourceResolver(workspace, downloads));
const memory = new MemoryService(new MemoryRepository());
const agent = new AgentService(new AIService(new FakeAIProvider()), memory);
const decision = (action, fields = {}) => ({ action, task: "", tool: "", args: "", response: "", ...fields });
const tool = (name, args) => decision("tool", { tool: name, args: JSON.stringify(args) });
const complete = () => decision("complete");
const context = prompt => ({ conversationId: 1, taskId: "native-test", authorization: deriveAuthorization(prompt, files.resources) });
function catalog() {
  const calls = [];
  const registry = createRuntimeTools(files, {
    openApp: async app => { calls.push(["open_app", app]); return { app, started: true, pid: 456, playbackControlled: false }; },
    openFile: async path => { calls.push(["open_file", path]); return { path, opened: true }; },
    systemInfo: () => ({ platform: "win32", cpuCount: 4 }),
    runningProcesses: async () => ({ processes: [{ name: "fake.exe", pid: 456 }] }),
  });
  return { registry, calls };
}
async function collect(events) { const result = []; for await (const event of events) result.push(event); return result; }
after(() => {
  database.close(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("jarvis-native-"));
  rmSync(root, { recursive: true, force: true });
});

for (const [prompt, first] of [
  ["Abra o Bloco de Notas.", tool("open_app", { app: "notepad" })],
  ["Abra o Spotify.", tool("open_app", { app: "spotify" })],
  ["Liste Downloads.", tool("list_directory", { resource: "downloads", path: "." })],
  ["Leia teste.txt.", tool("read_file", { resource: "workspace", path: "teste.txt" })],
  ["Crie novo.txt.", tool("write_file", { resource: "workspace", path: "novo.txt", content: "" })],
]) test(`API principal tools first, sem Qwen: ${prompt}`, async () => {
  const { registry } = catalog(); let coderCalls = 0, plannerCalls = 0;
  const planner = { decide: async input => {
    plannerCalls++;
    const data = JSON.parse(input);
    assert.deepEqual(data.tools, registry.getDefinitions());
    if (data.phase === "route") return first;
    assert.equal(data.steps[0].action.kind, "tool");
    assert.equal(data.steps[0].result.toolResult.success, true);
    assert.ok(data.steps[0].result.toolResult.data);
    return complete();
  } };
  const workflow = new TaskOrchestrator(planner, { generate: async () => { coderCalls++; throw new Error("Coder não deve ser chamado"); } }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, registry);
  const router = new MessageRouter(planner, memory, agent, workflow);
  const app = express(); app.use(express.json()); app.use(createConversationRoutes(new ConversationController(memory, agent, workflow, router)));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}/conversations`;
    const id = (await (await fetch(base, { method: "POST" })).json()).id;
    const response = await fetch(`${base}/${id}/messages/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
    const events = []; let text = "";
    await consumeStream(response.body, chunk => { text += chunk; }, event => events.push(event));
    assert.equal(coderCalls, 0); assert.equal(plannerCalls, 2);
    assert.equal(events.some(event => event.type === "confirmation_required"), false);
    assert.ok(events.some(event => event.type === "tool_started" && event.tool === first.tool));
    assert.ok(events.some(event => event.type === "tool_completed" && event.tool === first.tool));
    assert.ok(events.some(event => event.type === "task_completed"));
    assert.ok(text.length); assert.equal((await memory.getMessages(id)).length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("catálogo contém todas as ferramentas, schemas reais e mantém list_files compatível", () => {
  const { registry } = catalog();
  for (const name of ["list_directory", "read_file", "write_file", "move_file", "rename_file", "file_exists", "get_file_info", "open_app", "open_file", "get_system_info", "get_running_processes", "delete_file", "list_files"]) {
    const entry = registry.get(name); assert.ok(entry, name);
    assert.equal(entry.definition.parameters.type, "object");
    assert.equal(entry.definition.parameters.additionalProperties, false);
    assert.equal(typeof entry.permissions, "function");
  }
  const definitions = registry.getDefinitions(); definitions[0].name = "mutado";
  assert.notEqual(registry.getDefinitions()[0].name, "mutado");
});
test("registrar uma ferramenta nova atualiza o catálogo e não permite ignorar PermissionManager", async () => {
  const { registry } = catalog(); let ran = false;
  registry.register({ definition: { type: "function", name: "extension_test", description: "Teste", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } },
    validate: () => ({}), permissions: () => [{ action: "execute_process", resource: "unknown" }],
    execute: async () => { ran = true; return { success: true, data: {} }; } });
  assert.ok(registry.getDefinitions().some(def => def.name === "extension_test"));
  const result = await registry.get("extension_test").execute({}, context("Olá"));
  assert.equal(result.success, false); assert.equal(ran, false);
});

for (const [name, args] of [
  ["open_app", { app: "notepad.exe & calc.exe" }], ["open_app", { app: "notepad", args: ["secret.txt"] }],
  ["read_file", { resource: "workspace", path: "../downloads/entrada.json" }],
  ["write_file", { resource: "downloads", path: "x.txt", content: "x" }],
  ["list_directory", { resource: "unknown", path: "." }],
  ["file_exists", { path: root }], ["get_system_info", { command: "arbitrary" }],
  ["open_file", { path: join(root, "outside.txt") }],
]) test(`rejeita argumentos inválidos/fora do escopo: ${name} ${JSON.stringify(args)}`, async () => {
  const { registry, calls } = catalog();
  const result = await registry.get(name).execute(args, context("Pode fazer tudo"));
  assert.equal(result.success, false); assert.ok(result.error.code); assert.equal(calls.length, 0);
});

test("consulta existência e metadados sem ler conteúdo", async () => {
  const { registry } = catalog();
  const info = await registry.get("get_file_info").execute({ resource: "workspace", path: "teste.txt" }, context("Consulte teste.txt"));
  assert.equal(info.success, true); assert.ok(info.data.size > 0); assert.equal(info.data.type, "file"); assert.equal(info.data.content, undefined);
  const absent = await registry.get("file_exists").execute({ resource: "workspace", path: "missing.txt" }, context("Existe missing.txt?"));
  assert.deepEqual(absent, { success: true, data: { path: join(workspace, "missing.txt"), exists: false } });
});
test("move e rename validam ambos os caminhos e não sobrescrevem", async () => {
  writeFileSync(join(workspace, "mova.txt"), "original");
  const { registry } = catalog();
  const args = { resource: "workspace", path: "mova.txt", destinationPath: "destination/mova.txt" };
  const denied = await registry.get("move_file").execute(args, context("Mova outro.txt para destination/outro.txt."));
  assert.equal(denied.success, false); assert.equal(existsSync(join(workspace, "mova.txt")), true);
  const moved = await registry.get("move_file").execute(args, context("Mova mova.txt para destination/mova.txt."));
  assert.equal(moved.success, true, JSON.stringify(moved)); assert.equal(existsSync(join(workspace, "mova.txt")), false);
  const renamed = await registry.get("rename_file").execute({ resource: "workspace", path: "destination/mova.txt", newName: "novo.txt" }, context("Renomeie destination/mova.txt para novo.txt."));
  assert.equal(renamed.success, true, JSON.stringify(renamed));
  writeFileSync(join(workspace, "destination", "existe.txt"), "preservado");
  const collision = await registry.get("rename_file").execute({ resource: "workspace", path: "destination/novo.txt", newName: "existe.txt" }, context("Renomeie destination/novo.txt para existe.txt."));
  assert.equal(collision.success, false); assert.equal(readFileSync(join(workspace, "destination", "existe.txt"), "utf8"), "preservado");
  const traversal = await registry.get("move_file").execute({ resource: "workspace", path: "destination/novo.txt", destinationPath: "../../escape.txt" }, context("Pode fazer tudo"));
  assert.equal(traversal.success, false);
});
test("open_file usa caminho validado e não aceita executáveis nem argumentos", async () => {
  const { registry, calls } = catalog(); const path = join(workspace, "teste.txt");
  const result = await registry.get("open_file").execute({ path }, context(`Abra ${path}.`));
  assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(calls, [["open_file", path]]);
  writeFileSync(join(workspace, "evil.cmd"), "echo denied");
  const denied = await registry.get("open_file").execute({ resource: "workspace", path: "evil.cmd" }, context("Abra evil.cmd."));
  assert.equal(denied.success, false); assert.equal(calls.length, 1);
});
test("consultas nativas de sistema e processos usam autorização do pedido", async () => {
  const { registry } = catalog();
  assert.equal((await registry.get("get_system_info").execute({}, context("Mostre informações do sistema."))).success, true);
  assert.equal((await registry.get("get_running_processes").execute({}, context("Liste os processos."))).success, true);
  assert.equal((await registry.get("get_running_processes").execute({}, context("Olá"))).success, false);
});
test("delete direto sempre exige confirmação e fica escopado ao arquivo", async () => {
  const { registry } = catalog(); writeFileSync(join(workspace, "delete.txt"), "protegido");
  const args = { resource: "workspace", path: "delete.txt" };
  for (const prompt of ["Apague delete.txt.", "Pode fazer tudo e apague delete.txt."]) {
    const result = await registry.get("delete_file").execute(args, context(prompt));
    assert.equal(result.success, false); assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
  }
  assert.equal(existsSync(join(workspace, "delete.txt")), true);
});

test("tool inexistente não executa nem chama Coder", async () => {
  const { registry } = catalog(); let called = false;
  const workflow = new TaskOrchestrator({ decide: async () => complete() }, { generate: async () => { called = true; } }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, registry);
  const id = memory.createConversation(); await collect(workflow.startStream(id, "Faça algo", tool("missing_tool", {})));
  assert.equal(workflow.latest(id).status, "failed"); assert.equal(called, false);
});
test("ToolResult de falha chega ao Groq e complete não apaga o erro", async () => {
  const registry = createRuntimeTools(files, { openApp: async () => { throw new Error("Aplicativo não instalado"); } });
  let observed;
  const workflow = new TaskOrchestrator({ decide: async input => { observed = JSON.parse(input).steps[0].result.toolResult; return complete(); } }, { generate: async () => { throw new Error("unexpected coder"); } }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, registry);
  const id = memory.createConversation(); const events = await collect(workflow.startStream(id, "Abra o Spotify.", tool("open_app", { app: "spotify" })));
  assert.equal(observed.success, false); assert.match(observed.error.message, /não instalado/);
  assert.equal(workflow.latest(id).status, "failed"); assert.ok(events.some(event => event.type === "tool_failed"));
  assert.equal(events.some(event => event.type === "task_completed"), false);
});

test("tarefa mistura Tool → Coder → Tool e recebe os resultados reais", async () => {
  const { registry } = catalog(); let index = 0, coderCalls = 0;
  const planner = { decide: async input => {
    const state = JSON.parse(input); index++;
    if (index === 1) { assert.equal(state.steps[0].result.toolResult.data.content, "conteúdo real"); return decision("coder", { task: "Transformação personalizada" }); }
    if (index === 2) return tool("write_file", { resource: "workspace", path: "final.txt", content: state.steps[1].result.output.trim() });
    assert.equal(state.steps[2].result.toolResult.data.written, true); return complete();
  } };
  const coder = { generate: async input => { coderCalls++; const previous = JSON.parse(input).previousResults; assert.equal(previous[0].result.toolResult.data.content, "conteúdo real");
    return { language: "javascript", code: 'console.log("ANÁLISE PERSONALIZADA");', explanation: "Análise", capabilities: [] }; } };
  const workflow = new TaskOrchestrator(planner, coder, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, registry);
  const id = memory.createConversation(); await collect(workflow.startStream(id, "Crie final.txt.", tool("read_file", { resource: "workspace", path: "teste.txt" })));
  assert.equal(workflow.latest(id).status, "completed"); assert.equal(coderCalls, 1);
  assert.deepEqual(workflow.latest(id).steps.map(step => step.action.kind), ["tool", "script", "tool"]);
  assert.equal(readFileSync(join(workspace, "final.txt"), "utf8"), "ANÁLISE PERSONALIZADA");
});
test("duas Tools consecutivas não exigem Coder", async () => {
  const { registry } = catalog(); let index = 0;
  const workflow = new TaskOrchestrator({ decide: async () => ++index === 1 ? tool("get_file_info", { resource: "workspace", path: "teste.txt" }) : complete() }, { generate: async () => { throw new Error("unexpected coder"); } }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, registry);
  const id = memory.createConversation(); await collect(workflow.startStream(id, "Analise arquivos", tool("list_directory", { resource: "workspace", path: "." })));
  assert.equal(workflow.latest(id).status, "completed"); assert.equal(workflow.latest(id).steps.length, 2);
});
test("limites de etapas e tentativas continuam determinísticos para ferramentas nativas", async () => {
  const { registry } = catalog();
  const repeated = tool("file_exists", { resource: "workspace", path: "teste.txt" });
  const workflow = new TaskOrchestrator({ decide: async () => repeated }, { generate: async () => { throw new Error("unexpected coder"); } }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, registry);
  const id = memory.createConversation(); await collect(workflow.startStream(id, "Verifique arquivos", repeated));
  assert.equal(workflow.latest(id).status, "failed"); assert.equal(workflow.latest(id).steps.length, 6);
  let calls = 0;
  const failing = createRuntimeTools(files, { openApp: async () => { calls++; throw new Error("Não instalado"); } });
  const retry = tool("open_app", { app: "notepad" });
  const retrier = new TaskOrchestrator({ decide: async () => retry }, { generate: async () => {} }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent, failing);
  const second = memory.createConversation(); await collect(retrier.startStream(second, "Abra o Bloco de Notas.", retry));
  assert.equal(retrier.latest(second).status, "failed"); assert.equal(calls, 2);
});

test("GroqProvider recebe definitions dinâmicas com schema sem chamadas reais", async () => {
  const { GroqProvider } = await import("../src/ai/groq.provider.ts");
  const oldKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fake-test-key";
  try {
    const { registry } = catalog();
    registry.register({ definition: { type: "function", name: "new_test_capability", description: "Capacidade adicionada em runtime para teste", parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } },
      validate: () => ({}), permissions: () => [], execute: async () => ({ success: true, data: "real" }) });
    const provider = new GroqProvider();
    let captured;
    provider.client.chat.completions.create = async request => {
      captured = request;
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(tool("open_app", { app: "notepad" })) } }] };
    };
    const result = await provider.decide(JSON.stringify({ request: "Abra o Bloco de Notas.", tools: registry.getDefinitions(), steps: [] }));
    assert.equal(result.action, "tool");
    const catalogSent = JSON.parse(captured.messages[1].content).tools;
    assert.deepEqual(catalogSent, registry.getDefinitions());
    assert.ok(catalogSent.some(def => def.name === "new_test_capability"));
    assert.match(captured.messages[0].content, /TOOLS FIRST, CODE WHEN NECESSARY/);
    assert.doesNotMatch(captured.messages[0].content, /new_test_capability/);
  } finally { if (oldKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldKey; }
});

test("novas ferramentas não expõem registry, API keys ou Node ao Coder", async () => {
  const old = process.env.JARVIS_SANDBOX_TEST_SECRET;
  process.env.JARVIS_SANDBOX_TEST_SECRET = "private-test-value";
  try {
    const result = await new ScriptExecutor(files).execute({ language: "javascript",
      code: 'console.log(typeof process, typeof require, typeof ToolRegistry, typeof fetch, typeof globalThis.JARVIS_SANDBOX_TEST_SECRET);',
    }, []);
    assert.equal(result.success, true);
    assert.equal(result.stdout.trim(), "undefined undefined undefined undefined undefined");
    assert.doesNotMatch(JSON.stringify(result), /private-test-value/);
  } finally { if (old === undefined) delete process.env.JARVIS_SANDBOX_TEST_SECRET; else process.env.JARVIS_SANDBOX_TEST_SECRET = old; }
});
