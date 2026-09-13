import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
const { FileTools } = await import("../src/tools/file.tools.ts");
const { TaskOrchestrator } = await import("../src/orchestrator/task.orchestrator.ts");
const { TaskStateService } = await import("../src/task/task.state.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { MessageRouter } = await import("../src/conversation/message.router.ts");
const { ConversationController } = await import("../src/controllers/conversation.controller.ts");
const { createConversationRoutes } = await import("../src/routes/conversation.routes.ts");
const { actionSignature } = await import("../src/task/action.signature.ts");
const root = mkdtempSync(join(tmpdir(), "jarvis-plan-"));
const workspace = join(root, "workspace"), downloads = join(root, "downloads");
mkdirSync(workspace); mkdirSync(downloads);
const files = new FileTools(new ResourceResolver(workspace, downloads));
const state = new TaskStateService(), memory = new MemoryService(new MemoryRepository());
const op = (id, tool = "open_app", args = { app: "notepad" }, extra = {}) => ({ id, kind: "tool", tool, args, description: tool, ...extra });
const list = id => op(id, "list_directory", { resource: "workspace", path: "." });
const code = id => ({ id, kind: "coder", coderTask: "Converta para maiúsculas o conteúdo da etapa anterior e imprima", description: "Transformar conteúdo" });
const never = () => new Promise(() => {});
async function collect(stream) { const events = []; for await (const item of stream) events.push(item); return events; }
function setup(steps, options = {}) {
  const calls = { launch: 0, plan: 0, evaluate: 0, coder: 0, decide: 0 };
  const launcher = new ApplicationLauncher({ win32: () => "C:\\Windows\\System32\\notepad.exe", protocolRegistered: async () => false, spotifyAumid: async () => undefined,
    launchWin32: async () => { calls.launch++; return 100 + calls.launch; }, activate: async () => { throw new Error("unexpected activation"); } });
  const registry = options.registry ?? createRuntimeTools(files, new SystemRuntime(launcher));
  const planner = {
    decide: async input => { calls.decide++; return options.decide ? options.decide(input) : { action: options.conversation ? "respond" : "tool", tool: "open_app", args: '{"app":"notepad"}', task: "Abrir", response: "" }; },
    plan: async input => { calls.plan++; return options.plan ? options.plan(input) : { steps }; },
    evaluate: async input => { calls.evaluate++; return options.evaluate ? options.evaluate(JSON.parse(input)) : { action: "fail", reason: "Falha real" }; },
  };
  const id = memory.createConversation();
  const agent = options.agent ?? { summarizeTask: async task => {
    assert.equal(state.get(task.id).status, "completed"); assert.equal(state.get(task.id).plan.status, "completed");
    return task.steps.map(step => step.result?.output ?? step.error).join("\n");
  }, async *processStream(conversationId, input) {
    await memory.addMessage({ conversationId, role: "user", content: input });
    await memory.addMessage({ conversationId, role: "assistant", content: "Uma closure..." });
    yield { type: "text", text: "Uma closure..." }; yield { type: "done" };
  } };
  const coder = { generate: async input => { calls.coder++; return options.coder ? options.coder(input) : { language: "javascript", code: 'console.log("OLÁ")', explanation: "Transformação", capabilities: [] }; } };
  const workflow = new TaskOrchestrator(planner, coder, state, files, options.executor ?? { execute: async () => ({ success: true, stdout: "OLÁ", stderr: "" }) }, memory, agent, registry,
    { plannerMs: 60, coderMs: 60, executionMs: 100, narrationMs: 60 });
  return { workflow, registry, calls, id, agent, router: new MessageRouter(planner, memory, agent, workflow) };
}
function terminal(s, events, expected = "completed") {
  const task = s.workflow.latest(s.id);
  assert.equal(task.status, expected, task.response); if (task.plan) assert.equal(task.plan.status, expected);
  assert.equal(events.filter(e => e.type === "done").length, 1); assert.equal(events.at(-1).type, "done");
  return task;
}
async function approveAll(s, events) {
  while (s.workflow.latest(s.id)?.status === "waiting_permission") {
    const task = s.workflow.latest(s.id);
    events = await collect(s.workflow.resumeStream(s.id, task.id, task.pending.id, true));
    assert.equal(events.filter(e => e.type === "done").length, 1);
  }
  return events;
}
after(() => { database.close(); assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("jarvis-plan-")); rmSync(root, { recursive: true, force: true }); });

test("pedido Notepad pelo router: plano único, launcher uma vez, sem decisões entre etapas", async () => {
  const s = setup([op("open")]); const events = await collect(s.router.stream(s.id, "Abra o Bloco de Notas."));
  const task = terminal(s, events); assert.equal(task.plan.steps.length, 1);
  assert.deepEqual(s.calls, { launch: 1, plan: 1, evaluate: 0, coder: 0, decide: 1 });
  for (const type of ["task_planned", "step_started", "step_completed", "task_completed"]) assert.ok(events.some(e => e.type === type));
  assert.equal((await memory.getMessages(s.id)).length, 2);
});
test("regressão seis janelas: seis sugestões idênticas executam launcher uma vez", async () => {
  const s = setup(Array.from({ length: 6 }, (_, i) => op("s" + i)));
  const task = terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas.")));
  assert.equal(s.calls.launch, 1); assert.equal(task.plan.steps.filter(x => x.status === "skipped_duplicate").length, 5);
});
test("três Blocinhos: ocorrências explícitas autorizadas executam três vezes", async () => {
  const s = setup([1, 2, 3].map(n => op("s" + n, "open_app", { app: "notepad" }, { occurrence: n })));
  terminal(s, await collect(s.workflow.startStream(s.id, "Abra três Blocinhos de Notas."))); assert.equal(s.calls.launch, 3);
});
test("mesma ação em tarefas diferentes pode executar novamente", async () => {
  const s = setup([op("s1")]); await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas."));
  terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas."))); assert.equal(s.calls.launch, 2);
});
test("plano inteiro persistido antes do primeiro efeito; write e open em ordem", async () => {
  const s = setup([op("write", "write_file", { resource: "workspace", path: "teste.txt", content: "Olá JARVIS" }), op("open", "open_file", { resource: "workspace", path: "teste.txt" }, { dependsOn: ["write"] })]);
  let effects = 0;
  const write = s.registry.get("write_file"), original = write.execute;
  write.execute = async (args, context) => { assert.equal(state.get(context.taskId).plan.steps.length, 2); effects++; return original(args, context); };
  s.registry.get("open_file").execute = async () => { assert.equal(readFileSync(join(workspace, "teste.txt"), "utf8"), "Olá JARVIS"); effects++; return { success: true, data: { opened: true } }; };
  const first = await collect(s.workflow.startStream(s.id, "Crie teste.txt, escreva Olá JARVIS nele e abra o arquivo."));
  const task = terminal(s, await approveAll(s, first)); assert.equal(effects, 2);
  assert.deepEqual(task.steps.map(step => step.planStepId), ["write", "open"]); assert.equal(s.calls.evaluate, 0);
});
test("Tool → Coder → Tool usa resultados reais em binding", async () => {
  writeFileSync(join(workspace, "origem.txt"), "olá");
  const s = setup([op("read", "read_file", { resource: "workspace", path: "origem.txt" }), code("transform"), op("write", "write_file", { resource: "workspace", path: "transformado.txt", content: "{{transform.output}}" })], {
    coder: async input => { assert.match(input, /olá/); return { language: "javascript", code: 'console.log("OLÁ")', explanation: "Transformar", capabilities: [] }; },
  });
  terminal(s, await approveAll(s, await collect(s.workflow.startStream(s.id, "Transforme origem.txt em transformado.txt"))));
  assert.equal(readFileSync(join(workspace, "transformado.txt"), "utf8"), "OLÁ"); assert.equal(s.calls.evaluate, 0); assert.equal(s.calls.coder, 1);
});
test("falha não executa dependentes cegamente", async () => {
  const s = setup([op("read", "read_file", { resource: "workspace", path: "ausente.txt" }), op("open", "open_app", { app: "notepad" }, { dependsOn: ["read"] })]);
  terminal(s, await collect(s.workflow.startStream(s.id, "Leia ausente.txt")), "failed"); assert.equal(s.calls.launch, 0); assert.equal(s.calls.evaluate, 1);
});
test("retry legítimo após failure registra attempts e dois resultados", async () => {
  const s = setup([list("read")], { evaluate: () => ({ action: "retry", reason: "Falha temporária" }) }); let calls = 0;
  s.registry.get("list_directory").execute = async () => ++calls === 1 ? { success: false, error: { code: "TEMP", message: "temporário" } } : { success: true, data: [] };
  const task = terminal(s, await collect(s.workflow.startStream(s.id, "Liste arquivos")));
  assert.equal(calls, 2); assert.equal(task.plan.steps[0].attempts, 2); assert.equal(task.steps.length, 2); assert.equal(s.calls.evaluate, 1);
});
test("retry persistente é limitado a duas tentativas", async () => {
  const s = setup([list("read")], { evaluate: () => ({ action: "retry", reason: "Tentar novamente" }) }); let calls = 0;
  s.registry.get("list_directory").execute = async () => { calls++; return { success: false, error: { code: "FAIL", message: "falhou" } }; };
  terminal(s, await collect(s.workflow.startStream(s.id, "Liste arquivos")), "failed"); assert.equal(calls, 2);
});
test("replan versionado preserva completed e deduplica nova sugestão", async () => {
  const s = setup([op("open"), op("read", "read_file", { resource: "workspace", path: "ausente.txt" })], {
    evaluate: () => ({ action: "modify_plan", reason: "Pular arquivo indisponível", steps: [op("again"), list("list")] }),
  });
  const events = await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas.")); const task = terminal(s, events);
  assert.equal(task.plan.version, 2); assert.equal(task.planVersions[0].version, 1); assert.equal(task.planVersions[0].steps[1].status, "failed");
  assert.equal(task.plan.steps[0].status, "completed"); assert.equal(s.calls.launch, 1); assert.equal(task.plan.steps[2].status, "skipped_duplicate");
  assert.ok(events.some(e => e.type === "plan_updated"));
});
test("replan não pode reutilizar ID concluído", async () => {
  const s = setup([op("open"), op("read", "read_file", { resource: "workspace", path: "ausente.txt" })], {
    evaluate: () => ({ action: "modify_plan", reason: "Reescrever passado", steps: [op("open")] }),
  });
  const task = terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas.")), "failed");
  assert.equal(task.plan.steps[0].status, "completed"); assert.equal(s.calls.launch, 1);
});
const invalidPlans = {
  "tool inexistente": [op("one"), op("two", "inventada")],
  "argumentos inválidos": [op("one"), op("two", "open_app", { app: "notepad", command: "calc" })],
  "IDs duplicados": [op("same"), op("same")],
  "dependência futura": [op("one", "open_app", { app: "notepad" }, { dependsOn: ["two"] }), op("two")],
  "status inventado": [op("one", "open_app", { app: "notepad" }, { status: "completed" })],
  "kind inválido": [{ ...op("one"), kind: "shell" }],
  "plano vazio": [],
  "sete etapas": Array.from({ length: 7 }, (_, n) => op("s" + n)),
  "repetição inventada": [op("one", "open_app", { app: "notepad" }, { occurrence: 2 })],
  "coder vazio": [{ ...code("one"), coderTask: "" }],
  "escrita proibida em downloads": [op("one", "write_file", { resource: "downloads", path: "x.txt", content: "x" })],
};
for (const [name, steps] of Object.entries(invalidPlans)) test("rejeita plano inteiro antes de qualquer efeito: " + name, async () => {
  const s = setup(steps); const task = terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas.")), "failed");
  assert.equal(s.calls.launch, 0); assert.equal(task.steps.length, 0); assert.equal(task.plan, undefined);
});
for (const stage of ["Planner", "Evaluator", "Coder", "Executor", "Gemini"]) test(stage + " timeout termina sem ficar planning/running", async () => {
  const options = stage === "Planner" ? { plan: never } : stage === "Evaluator" ? { evaluate: never } : stage === "Coder" ? { coder: never } : stage === "Executor" ? { executor: { execute: never } } : { agent: { summarizeTask: never } };
  const steps = stage === "Evaluator" ? [op("read", "read_file", { resource: "workspace", path: "ausente.txt" })] : ["Coder", "Executor"].includes(stage) ? [code("code")] : [list("list")];
  const s = setup(steps, options); terminal(s, await collect(s.workflow.startStream(s.id, "Execute tarefa")), stage === "Gemini" ? "completed" : "failed");
});
test("Tool timeout não chama Evaluator nem repete efeito incerto", async () => {
  const s = setup([list("list")]); s.registry.get("list_directory").execute = never;
  const task = terminal(s, await collect(s.workflow.startStream(s.id, "Liste arquivos")), "failed");
  assert.equal(s.calls.evaluate, 0); assert.equal(task.plan.steps[0].status, "failed");
});
test("assinatura estável para ordem de chaves e caminhos normalizados", () => {
  assert.equal(actionSignature("write_file", { path: "a/../b.txt", content: "x", nested: { a: 1, b: 2 } }), actionSignature("write_file", { nested: { b: 2, a: 1 }, content: "x", path: "b.txt" }));
  assert.notEqual(actionSignature("write_file", { path: "a.txt" }), actionSignature("write_file", { path: "b.txt" }));
});
test("delete exige aprovação, retoma etapa, não aceita replay", async () => {
  writeFileSync(join(workspace, "delete.txt"), "x");
  const s = setup([op("delete", "delete_file", { resource: "workspace", path: "delete.txt" })]);
  const events = await collect(s.workflow.startStream(s.id, "Apague delete.txt."));
  assert.ok(events.some(e => e.type === "confirmation_required")); assert.equal(existsSync(join(workspace, "delete.txt")), true);
  const before = s.workflow.latest(s.id), approval = before.pending.id;
  terminal(s, await collect(s.workflow.resumeStream(s.id, before.id, approval, true)));
  assert.equal(existsSync(join(workspace, "delete.txt")), false);
  await assert.rejects(collect(s.workflow.resumeStream(s.id, before.id, approval, true)));
});
test("negar confirmação cancela plano sem executar", async () => {
  const s = setup([op("open")]); await collect(s.workflow.startStream(s.id, "Organize meu computador"));
  const task = s.workflow.latest(s.id);
  terminal(s, await collect(s.workflow.resumeStream(s.id, task.id, task.pending.id, false)), "cancelled"); assert.equal(s.calls.launch, 0);
});
test("restart preserva completed e marca running falha sem execução", async () => {
  const s = setup([op("open")]); await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas."));
  const task = s.workflow.latest(s.id); task.status = "running"; task.plan.status = "active";
  task.plan.steps.push({ ...structuredClone(task.plan.steps[0]), id: "interrupted", status: "running" }); state.save(task);
  new TaskStateService().recoverInterrupted(); const recovered = state.get(task.id);
  assert.equal(recovered.status, "failed"); assert.equal(recovered.plan.steps[0].status, "completed"); assert.equal(recovered.plan.steps[1].status, "failed"); assert.equal(s.calls.launch, 1);
});
test("conversa normal usa Gemini sem plano e preserva histórico", async () => {
  const s = setup([], { conversation: true }); const events = await collect(s.router.stream(s.id, "Explique closures em JavaScript."));
  assert.equal(s.calls.plan, 0); assert.equal(s.workflow.latest(s.id), undefined); assert.ok(events.some(e => e.type === "text"));
  assert.equal((await memory.getMessages(s.id)).length, 2);
});
test("resultado inesperado consulta Evaluator; continue não repete sucesso", async () => {
  const s = setup([op("open", "open_app", { app: "notepad" }, { expect: { path: "data.pid", value: 999 } })], { evaluate: () => ({ action: "continue", reason: "PID real é válido" }) });
  terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas."))); assert.equal(s.calls.launch, 1); assert.equal(s.calls.evaluate, 1);
});
test("Evaluator retry não pode repetir ação successful inesperada", async () => {
  const s = setup([op("open", "open_app", { app: "notepad" }, { expect: { path: "data.pid", value: 999 } })], { evaluate: () => ({ action: "retry", reason: "Abrir de novo" }) });
  terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas.")), "failed"); assert.equal(s.calls.launch, 1);
});
test("Evaluator complete não oculta dependentes pendentes após falha", async () => {
  const s = setup([op("read", "read_file", { resource: "workspace", path: "ausente.txt" }), op("open")], { evaluate: () => ({ action: "complete", reason: "Pronto" }) });
  terminal(s, await collect(s.workflow.startStream(s.id, "Leia ausente.txt")), "failed"); assert.equal(s.calls.launch, 0);
});
test("compute rejeita pontes externas deterministicamente", async () => {
  const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
  const result = await new ScriptExecutor(files).execute({ language: "javascript", code: 'jarvis.writeFile({resource:"workspace",path:"escape.txt",content:"x"});', coderMode: "compute", input: "x" }, []);
  assert.equal(result.success, false); assert.match(result.stderr, /PURE COMPUTE|capacidade externa|proibida/i); assert.equal(existsSync(join(workspace, "escape.txt")), false);
});
test("fechar Spotify usa Coder script e o broker recebe somente o alvo autorizado", async () => {
  const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
  const terminated = [];
  const executor = new ScriptExecutor(files, {
    resolve: () => "C:\\Windows\\System32\\notepad.exe",
    launch: () => JSON.stringify({ started: true }),
    terminate: (name) => { terminated.push(name); return JSON.stringify({ app: name, terminated: true }); },
  });
  const s = setup([{ id: "close", kind: "coder", description: "Fechar Spotify", coderTask: "Feche somente o Spotify", coderMode: "script", input: "" }], {
    executor,
    decide: async () => ({ action: "coder", tool: "", args: "", task: "Fechar somente o Spotify", response: "" }),
    coder: async input => { assert.match(input, /process_control|SCRIPT EFFECTFUL/); return { language: "javascript", code: 'console.log(jarvis.closeApp("spotify"));', explanation: "Encerrar o Spotify", capabilities: ["process_control"] }; },
  });
  const task = terminal(s, await collect(s.router.stream(s.id, "Feche o Spotify.")));
  assert.equal(s.calls.coder, 1); assert.deepEqual(terminated, ["spotify"]); assert.equal(task.plan.steps[0].execution.coderMode, "script");
});
test("abrir Spotify continua sendo Tool e não chama Coder", async () => {
  const s = setup([op("open-spotify", "open_app", { app: "spotify" })], {
    coder: async () => { throw new Error("Coder não deve ser chamado para open_app"); },
  });
  terminal(s, await collect(s.router.stream(s.id, "Abra o Spotify.")));
  assert.equal(s.calls.coder, 0); assert.equal(s.calls.launch, 1);
});
test("process_control aceita somente o template de encerramento e um alvo conhecido", async () => {
  const { ExecutionValidator } = await import("../src/security/execution.validator.ts");
  const { ResourceResolver } = await import("../src/security/resource.resolver.ts");
  const validator = new ExecutionValidator(new ResourceResolver(workspace, downloads));
  assert.deepEqual(validator.analyze({ language: "javascript", code: 'console.log(jarvis.closeApp("spotify"));', explanation: "", capabilities: ["process_control"] }), [{ action: "terminate_process", resource: "spotify" }]);
  for (const code of [
    'console.log(jarvis.closeApp("spotify")); console.log(jarvis.closeApp("notepad"));',
    'taskkill.exe /IM Spotify.exe /F',
    'console.log(jarvis.closeApp("calc"));',
  ]) assert.throws(() => validator.analyze({ language: "javascript", code, explanation: "", capabilities: ["process_control"] }), /process_control|template|encerramento|aplicativo/i);
  assert.throws(() => validator.analyze({ language: "javascript", code: 'console.log(jarvis.closeApp("spotify"));', explanation: "", capabilities: ["process_control", "process_execution"] }), /process_control|capacidade/i);
});
test("compute nunca pode encerrar processo", async () => {
  const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
  let calls = 0;
  const executor = new ScriptExecutor(files, { resolve: () => "", launch: () => "", terminate: () => { calls++; return ""; } });
  const result = await executor.execute({ language: "javascript", code: 'console.log(jarvis.closeApp("spotify"));', coderMode: "compute", input: "" }, ["process_control"]);
  assert.equal(result.success, false); assert.match(result.stderr, /PURE COMPUTE|capacidade externa|proibida/i); assert.equal(calls, 0);
});
test("PlanValidator não aceita compute para encerramento de aplicativo", async () => {
  const { PlanValidator } = await import("../src/task/plan.validator.ts");
  const s = setup([op("open")]);
  assert.throws(() => new PlanValidator(s.registry).normalize({ steps: [{ id: "close", kind: "coder", description: "Fechar Spotify", coderTask: "Feche o Spotify", coderMode: "compute", input: "", dependsOn: [], occurrence: 1, expect: null }] }, "task", "Feche o Spotify."), /coderMode=script|process_control/i);
});
test("dependentes são normalizados como skipped após falha terminal", async () => {
  const s = setup([op("read", "read_file", { resource: "workspace", path: "ausente.txt" }), op("transform", "open_app", { app: "notepad" }, { dependsOn: ["read"] })]);
  const task = terminal(s, await collect(s.workflow.startStream(s.id, "Leia e transforme ausente.txt")), "failed");
  assert.equal(task.plan.steps.find(step => step.id === "transform").status, "skipped"); assert.equal(task.plan.steps.find(step => step.id === "transform").reasonCode, "dependency_failed"); assert.equal(s.calls.launch, 0);
});
test("HTTP principal entrega plano, etapas e EOF, e GET restaura plano/histórico", { timeout: 3000 }, async () => {
  const s = setup([op("open")]); const app = express(); app.use(express.json());
  app.use(createConversationRoutes(new ConversationController(memory, s.agent, s.workflow, s.router)));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/conversations/${s.id}/messages`;
    const response = await fetch(url + "/stream", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Abra o Bloco de Notas." }), signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n\n").filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, "")));
    terminal(s, events); assert.equal(s.calls.launch, 1);
    assert.ok(events.findIndex(e => e.type === "task_planned") < events.findIndex(e => e.type === "step_started"));
    const restored = await (await fetch(url)).json(); assert.equal(restored.task.plan.steps[0].status, "completed"); assert.equal(restored.messages.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("Planner inválido falha limpo e não usa fallback incremental", async () => {
  const s = setup([], { plan: () => { throw new SyntaxError("JSON inválido"); } });
  terminal(s, await collect(s.workflow.startStream(s.id, "Abra o Bloco de Notas.")), "failed"); assert.equal(s.calls.decide, 0); assert.equal(s.calls.launch, 0);
});
test("limites de falhas e decisões encerram replan sem efeitos", async () => {
  let version = 0;
  const s = setup([op("read", "read_file", { resource: "workspace", path: "ausente.txt" })], {
    evaluate: () => ({ action: "modify_plan", reason: "Outro caminho", steps: [op("read" + ++version, "read_file", { resource: "workspace", path: "ausente" + version + ".txt" })] }),
  });
  const task = terminal(s, await collect(s.workflow.startStream(s.id, "Consulte arquivos ausentes")), "failed"); assert.ok(task.decisions <= 8); assert.equal(s.calls.launch, 0);
});
test("skip não libera dependência e não permite continue sobre falha", async () => {
  const s = setup([op("read", "read_file", { resource: "workspace", path: "ausente.txt" }), op("open", "open_app", { app: "notepad" }, { dependsOn: ["read"] })], {
    evaluate: input => ({ action: input.currentStep.id === "read" ? "skip" : "continue", reason: "Seguir" }),
  });
  terminal(s, await collect(s.workflow.startStream(s.id, "Leia ausente.txt")), "failed"); assert.equal(s.calls.launch, 0);
});
test("três arquivos diferentes não são duplicações", async () => {
  const s = setup([1, 2, 3].map(n => op("write" + n, "write_file", { resource: "workspace", path: "distinto" + n + ".txt", content: "teste" })));
  const task = terminal(s, await approveAll(s, await collect(s.workflow.startStream(s.id, "Crie três arquivos diferentes."))));
  assert.equal(task.steps.length, 3); for (let n = 1; n <= 3; n++) assert.equal(readFileSync(join(workspace, "distinto" + n + ".txt"), "utf8"), "teste");
});
test("Groq separa structured output do Planner e Evaluator e rejeita truncamento", async () => {
  const { GroqProvider } = await import("../src/ai/groq.provider.ts");
  const old = process.env.GROQ_API_KEY; process.env.GROQ_API_KEY = "test-local";
  try {
    const provider = new GroqProvider(); const requests = []; let truncated = false;
    provider.client.chat.completions.create = async (input, options) => { requests.push({ input, options }); return { choices: [{ finish_reason: truncated ? "length" : "stop", message: { content: JSON.stringify({ steps: [op("open")] }) } }] }; };
    const signal = new AbortController().signal;
    await provider.plan("context", signal); await provider.evaluate("context", signal);
    assert.equal(requests[0].input.response_format.json_schema.name, "task_plan"); assert.equal(requests[1].input.response_format.json_schema.name, "plan_evaluation");
    assert.equal(requests[0].options.signal, signal); truncated = true; await assert.rejects(provider.plan("context"));
  } finally { if (old === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = old; }
});
