import assert from "node:assert/strict";
import { test, after } from "node:test";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import express from "express";
import { consumeStream } from "../public/stream.js";

process.env.JARVIS_DATABASE_PATH = ":memory:";
const { database } = await import("../src/database/database.ts");
const { ResourceResolver } = await import("../src/security/resource.resolver.ts");
const { FileTools } = await import("../src/tools/file.tools.ts");
const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
const { TaskStateService } = await import("../src/task/task.state.ts");
const { TaskOrchestrator } = await import("../src/orchestrator/task.orchestrator.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { AgentService } = await import("../src/agent/agent.service.ts");
const { AIService } = await import("../src/ai/ai.service.ts");
const { FakeAIProvider } = await import("../src/ai/fake-ai.provider.ts");
const { ConversationController } = await import("../src/controllers/conversation.controller.ts");
const { createConversationRoutes } = await import("../src/routes/conversation.routes.ts");
const { MessageRouter } = await import("../src/conversation/message.router.ts");
const { deriveAuthorization } = await import("../src/security/authorization.ts");
const root = mkdtempSync(join(tmpdir(), "jarvis-orchestrator-"));
const workspace = join(root, "workspace");
const downloads = join(root, "downloads");
mkdirSync(workspace);
mkdirSync(downloads);
writeFileSync(join(downloads, "entrada.txt"), "conteúdo real");
const files = new FileTools(new ResourceResolver(workspace, downloads));
const memory = new MemoryService(new MemoryRepository());
const agent = new AgentService(new AIService(new FakeAIProvider()), memory);
const states = new TaskStateService();
const decision = (action, fields = {}) => ({ action, task: "", tool: "", args: "", response: "", ...fields });
const tool = (name, args) => decision("tool", { task: name, tool: name, args: JSON.stringify(args) });
const read = () => tool("read_file", { resource: "downloads", path: "entrada.txt" });
const write = (path = "saida.txt", content = "resultado") => tool("write_file", { resource: "workspace", path, content });
const complete = () => decision("complete", { response: "Concluído com resultado verificado." });
const script = (code, capabilities = []) => ({ language: "javascript", code, explanation: "Teste", capabilities });

for (const isTask of [true, false]) test(`chat principal roteia ${isTask ? "Abra o Bloco de Notas." : "Explique closures em JavaScript."}`, async () => {
  const id = memory.createConversation();
  let geminiCalls = 0, executions = 0, coderCalls = 0, plannerCalls = 0, starts = 0;
  const localAgent = new AgentService(new AIService({
    generate: async input => {
      geminiCalls++;
      assert.match(input, /PID 123/);
      return { text: "Processo iniciado: PID 123.", interactionId: "task-result" };
    },
    async *generateStream() {
      geminiCalls++;
      yield { type: "interaction", interactionId: "conversation-result" };
      yield { type: "text", text: "Uma closure mantém acesso ao escopo externo." };
    },
  }), memory);
  const planner = { decide: async input => {
    plannerCalls++;
    const context = JSON.parse(input);
    if (context.phase === "route") return decision(isTask ? "coder" : "respond", { task: "Abrir Bloco de Notas" });
    assert.equal(executions, 1);
    return complete();
  } };
  const workflow = new TaskOrchestrator(planner, { generate: async () => {
    coderCalls++;
    return { language: "powershell", code: "Start-Process notepad.exe -PassThru -ErrorAction Stop", explanation: "Abrir Bloco de Notas", capabilities: ["process_execution", "app_control"] };
  } }, states, files, { execute: async () => {
    executions++;
    return { success: true, stdout: "PID 123", stderr: "", durationMs: 1 };
  } }, memory, localAgent);
  const originalStart = workflow.startStream.bind(workflow);
  workflow.startStream = (...args) => { starts++; return originalStart(...args); };
  const router = new MessageRouter(planner, memory, localAgent, workflow);
  const app = express();
  app.use(express.json());
  app.use(createConversationRoutes(new ConversationController(memory, localAgent, workflow, router)));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/conversations/${id}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const events = [];
    const response = await post("/messages/stream", { prompt: isTask ? "Abra o Bloco de Notas." : "Explique closures em JavaScript." });
    await consumeStream(response.body, () => {}, event => events.push(event));
    assert.equal(starts, isTask ? 1 : 0);
    assert.equal(geminiCalls, 1);
    assert.equal(executions, isTask ? 1 : 0);
    assert.equal(plannerCalls, isTask ? 2 : 1);
    if (isTask) {
      assert.ok(events.some(event => event.type === "task_started"));
      assert.equal(events.some(event => event.type === "confirmation_required"), false);
      assert.ok(events.some(event => event.type === "task_completed"));
      assert.equal(executions, 1);
      assert.equal(coderCalls, 1);
      assert.equal(geminiCalls, 1);
      assert.equal(workflow.latest(id).status, "completed");
    } else {
      assert.equal(workflow.latest(id), undefined);
      assert.equal(coderCalls, 0);
    }
    assert.equal((await memory.getMessages(id)).length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function setup(decisions, coderResult = script('console.log("55")')) {
  let index = 0;
  const planner = { decide: async () => {
    const entry = decisions[Math.min(index++, decisions.length - 1)];
    if (entry instanceof Error) throw entry;
    return entry;
  } };
  const workflow = new TaskOrchestrator(planner, { generate: async () => coderResult }, states, files, new ScriptExecutor(files), memory, agent);
  return { workflow, id: memory.createConversation(), calls: () => index };
}
async function collect(events) {
  let text = "";
  let task;
  for await (const event of events) {
    if (event.type === "text") text += event.text;
    if (event.type === "task") task = event.task;
  }
  return { text, task };
}

after(() => {
  database.close();
  assert.equal(dirname(root), tmpdir());
  assert.ok(basename(root).startsWith("jarvis-orchestrator-"));
  rmSync(root, { recursive: true, force: true });
});

test("conversa comum mantém streaming e salva somente um par de mensagens", async () => {
  const { workflow, id } = setup([decision("respond")]);
  const result = await collect(workflow.startStream(id, "Olá"));
  assert.equal(result.text, "Você disse: Olá");
  assert.equal(result.task.status, "completed");
  assert.equal((await memory.getMessages(id)).length, 2);
});

test("leitura, aprovação exata, escrita e verificação em várias etapas", async () => {
  const { workflow, id } = setup([read(), write(), tool("read_file", { resource: "workspace", path: "saida.txt" }), complete()]);
  const waiting = await collect(workflow.startStream(id, "Leia e crie a saída"));
  assert.equal(waiting.task.status, "waiting_permission");
  assert.equal(waiting.task.steps[0].result.success, true);
  assert.equal(existsSync(join(workspace, "saida.txt")), false);
  assert.throws(() => workflow.assertCanStart(id), /pendente/);
  const pending = waiting.task.pending;
  // Recover the exact pending code/args from SQLite, not only an in-memory Map.
  assert.equal(new TaskStateService().get(waiting.task.id).pending.id, pending.id);
  const finished = await collect(workflow.resumeStream(id, waiting.task.id, pending.id, true));
  assert.equal(finished.task.status, "completed");
  assert.equal(finished.task.steps.length, 3);
  assert.equal(readFileSync(join(workspace, "saida.txt"), "utf8"), "resultado");
  assert.throws(() => workflow.checkApproval(id, waiting.task.id, pending.id), /já foi usada/);
});

test("cancelamento não executa e aprovação de outra conversa é rejeitada", async () => {
  const { workflow, id } = setup([write("cancelado.txt")]);
  const { task } = await collect(workflow.startStream(id, "Criar arquivo"));
  assert.throws(() => workflow.checkApproval(memory.createConversation(), task.id, task.pending.id), /não encontrada/);
  assert.throws(() => workflow.checkApproval(id, task.id, "token-errado"), /não corresponde/);
  const denied = await collect(workflow.resumeStream(id, task.id, task.pending.id, false));
  assert.equal(denied.task.status, "cancelled");
  assert.equal(existsSync(join(workspace, "cancelado.txt")), false);
  assert.doesNotThrow(() => workflow.assertCanStart(id));
});

test("mudança do arquivo após revisão impede a escrita previamente aprovada", async () => {
  writeFileSync(join(workspace, "mudou.txt"), "antes");
  const { workflow, id } = setup([write("mudou.txt"), decision("respond", { response: "Arquivo alterado externamente." })]);
  const { task } = await collect(workflow.startStream(id, "Alterar"));
  writeFileSync(join(workspace, "mudou.txt"), "edição do usuário");
  const result = await collect(workflow.resumeStream(id, task.id, task.pending.id, true));
  assert.equal(readFileSync(join(workspace, "mudou.txt"), "utf8"), "edição do usuário");
  assert.equal(result.task.status, "failed");
  assert.match(result.task.steps[0].error, /mudou/);
});

test("aprovação expirada falha sem executar e tarefa interrompida não é repetida", async () => {
  const { workflow, id } = setup([write("expirou.txt")]);
  const { task } = await collect(workflow.startStream(id, "Criar"));
  task.pending.expiresAt = new Date(0).toISOString();
  states.save(task);
  const result = await collect(workflow.resumeStream(id, task.id, task.pending.id, true));
  assert.equal(result.task.status, "failed");
  assert.equal(existsSync(join(workspace, "expirou.txt")), false);
  const interrupted = states.create(memory.createConversation(), "Interrompida");
  interrupted.status = "running";
  states.save(interrupted);
  states.recoverInterrupted();
  assert.equal(states.get(interrupted.id).status, "failed");
});

test("não conclui sem execução ou depois de erro; tentativas e etapas são limitadas", async () => {
  let setupResult = setup([complete()]);
  assert.equal((await collect(setupResult.workflow.startStream(setupResult.id, "Executar"))).task.status, "failed");
  setupResult = setup([tool("read_file", { resource: "workspace", path: "ausente.txt" }), complete()]);
  assert.equal((await collect(setupResult.workflow.startStream(setupResult.id, "Ler"))).task.status, "failed");
  setupResult = setup([tool("read_file", { resource: "workspace", path: "ausente.txt" })]);
  const failed = await collect(setupResult.workflow.startStream(setupResult.id, "Ler"));
  assert.equal(failed.task.steps.length, 2);
  assert.equal(setupResult.calls(), 2);
  setupResult = setup([read()]);
  const bounded = await collect(setupResult.workflow.startStream(setupResult.id, "Ler repetidamente"));
  assert.equal(bounded.task.status, "failed");
  assert.equal(bounded.task.steps.length, 6);
});

test("falha do provedor deixa tarefa terminal e permite um novo pedido", async () => {
  const { workflow, id } = setup([new Error("Provedor indisponível")]);
  const { task } = await collect(workflow.startStream(id, "Olá"));
  assert.equal(task.status, "failed");
  assert.doesNotThrow(() => workflow.assertCanStart(id));
});

test("cálculo isolado sem efeitos não exige confirmação", async () => {
  const { workflow, id } = setup([decision("coder", { task: "Somar" }), complete()],
    script('let s = 0; for (let i = 1; i <= 10; i++) s += i; console.log(s);'));
  const { task } = await collect(workflow.startStream(id, "Calcule"));
  assert.equal(task.status, "completed");
  assert.equal(task.steps[0].result.output.trim(), "55");
});

test("runtime não expõe Node, rede, ambiente ou escrita sem capacidade", async () => {
  const executor = new ScriptExecutor(files);
  const run = (code, caps = [], timeoutMs = 1000) => executor.execute({ language: "javascript", code, timeoutMs,
    authorization: deriveAuthorization("Crie um arquivo script.txt.", files.resources) }, caps);
  const globals = await run('console.log(typeof process, typeof require, typeof fetch, typeof WebSocket);');
  assert.equal(globals.success, true);
  assert.equal(globals.stdout.trim(), "undefined undefined undefined undefined");
  const denied = await run('jarvis.writeFile({resource:"workspace",path:"bypass.txt",content:"x"});');
  assert.equal(denied.success, false);
  assert.equal(existsSync(join(workspace, "bypass.txt")), false);
  const writeResult = await run('console.log(jarvis.writeFile({resource:"workspace",path:"script.txt",content:"ok"}));', ["filesystem_write"]);
  assert.equal(writeResult.success, true);
  assert.equal(readFileSync(join(workspace, "script.txt"), "utf8"), "ok");
  const deleting = await run('jarvis.deleteFile({resource:"workspace",path:"script.txt"});', ["filesystem_write"]);
  assert.equal(deleting.success, false);
  assert.equal(existsSync(join(workspace, "script.txt")), true);
  const network = await run('console.log(1)', ["network"]);
  assert.equal(network.success, false);
  const timeout = await run("while (true) {}", [], 30);
  assert.equal(timeout.success, false);
  assert.ok(timeout.durationMs < 2000);
});

test("ferramentas bloqueiam traversal, mudanças em Downloads e remoção de diretório", () => {
  assert.throws(() => files.run("read_file", { resource: "workspace", path: "../downloads/entrada.txt" }), /fora/);
  assert.throws(() => files.run("write_file", { resource: "downloads", path: "x.txt", content: "x" }), /somente/);
  mkdirSync(join(workspace, "pasta"));
  assert.throws(() => files.run("delete_file", { resource: "workspace", path: "pasta" }), /somente arquivos/);
});

test("links simbólicos inclusive quebrados não escapam das raízes", (t) => {
  try {
    symlinkSync(join(root, "fora.txt"), join(workspace, "link.txt"), "file");
  } catch (error) {
    if (error.code === "EPERM") { t.skip("Windows sem privilégio de criação de symlink."); return; }
    throw error;
  }
  assert.throws(() => files.run("write_file", { resource: "workspace", path: "link.txt", content: "escape" }), /Links/);
  assert.equal(existsSync(join(root, "fora.txt")), false);
});

test("API devolve aprovação no SSE, recupera a tarefa e rejeita replay HTTP", async () => {
  const { workflow, id } = setup([write("http.txt"), complete()]);
  const app = express();
  app.use(express.json());
  app.use(createConversationRoutes(new ConversationController(memory, agent, workflow)));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/conversations/${id}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const response = await post("/messages/stream", { prompt: "Crie um arquivo" });
    let task;
    await consumeStream(response.body, () => {}, (event) => { if (event.type === "task") task = event.task; });
    assert.equal(task.status, "waiting_permission");
    assert.equal((await post("/messages/stream", { prompt: "Outra" })).status, 409);
    const restored = await (await fetch(base + "/messages")).json();
    assert.equal(restored.task.pending.id, task.pending.id);
    const payload = { approvalId: task.pending.id, allow: true };
    const approved = await post(`/tasks/${task.id}/approval`, payload);
    await consumeStream(approved.body, () => {});
    assert.equal(readFileSync(join(workspace, "http.txt"), "utf8"), "resultado");
    assert.equal((await post(`/tasks/${task.id}/approval`, payload)).status, 409);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
