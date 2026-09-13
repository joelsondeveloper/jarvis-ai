import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";

process.env.JARVIS_DATABASE_PATH = ":memory:";
const { database } = await import("../src/database/database.ts");
const { ResourceResolver } = await import("../src/security/resource.resolver.ts");
const { PermissionManager } = await import("../src/security/permission.manager.ts");
const { deriveAuthorization } = await import("../src/security/authorization.ts");
const { ExecutionValidator } = await import("../src/security/execution.validator.ts");
const { FileTools } = await import("../src/tools/file.tools.ts");
const { ScriptExecutor } = await import("../src/execution/script.executor.ts");
const { launchProcess, filteredEnvironment } = await import("../src/execution/process.broker.ts");
const { TaskOrchestrator } = await import("../src/orchestrator/task.orchestrator.ts");
const { TaskStateService } = await import("../src/task/task.state.ts");
const { MemoryService } = await import("../src/memory/memory.service.ts");
const { MemoryRepository } = await import("../src/memory/memory.repository.ts");
const { AgentService } = await import("../src/agent/agent.service.ts");
const { AIService } = await import("../src/ai/ai.service.ts");
const { FakeAIProvider } = await import("../src/ai/fake-ai.provider.ts");
const root = mkdtempSync(join(tmpdir(), "jarvis-authorization-"));
const downloads = join(root, "downloads");
mkdirSync(downloads);
const resources = new ResourceResolver(join(root, "workspace"), downloads);
const files = new FileTools(resources);
const manager = new PermissionManager();
const target = resources.file("workspace", "teste.txt", true);
const auth = input => deriveAuthorization(input, resources);
const decision = (action, fields = {}) => ({ action, task: "", tool: "", args: "", response: "", ...fields });
const memory = new MemoryService(new MemoryRepository());
const agent = new AgentService(new AIService(new FakeAIProvider()), memory);
after(() => {
  database.close();
  assert.equal(dirname(root), tmpdir());
  assert.ok(basename(root).startsWith("jarvis-authorization-"));
  rmSync(root, { recursive: true, force: true });
});

for (const [input, action, resource, expected] of [
  ["Abra o Bloco de Notas.", "execute_process", "notepad", "allow"],
  ["Abra o Spotify.", "execute_process", "spotify", "allow"],
  ["Crie um arquivo teste.txt.", "write_file", target, "allow"],
  ["Leia o arquivo teste.txt.", "read_file", target, "allow"],
  ["Apague teste.txt.", "delete_file", target, "confirm"],
  ["Pode fazer tudo e apague teste.txt.", "delete_file", target, "confirm"],
  ["Abra o Bloco de Notas.", "execute_process", "powershell.exe", "confirm"],
  ["Organize minha pasta Downloads.", "execute_process", "notepad", "confirm"],
  ["Crie um arquivo teste.txt.", "write_file", resources.file("workspace", "outro.txt", true), "confirm"],
  ["Leia o arquivo teste.txt.", "read_file", resources.file("workspace", "outro.txt"), "confirm"],
  ["Não abra o Spotify.", "execute_process", "spotify", "confirm"],
  ['Explique "Abra o Spotify".', "execute_process", "spotify", "confirm"],
  ["Crie um relatório em TXT.", "write_file", resources.file("workspace", "relatorio.txt", true), "allow"],
]) test(`permissão ${expected}: ${input} -> ${action}/${basename(resource)}`, () => {
  assert.equal(manager.check({ action, resource }, auth(input)).decision, expected);
});

test("flags legadas de autorização ampla nunca liberam processo arbitrário ou delete", () => {
  const broad = { read: true, write: true, process: true, network: true };
  assert.equal(manager.check({ action: "delete_file", resource: target }, broad).decision, "confirm");
  assert.equal(manager.check({ action: "execute_process", resource: "powershell.exe" }, broad).decision, "confirm");
  assert.equal(manager.check({ action: "unknown" }, broad).decision, "deny");
});

function executorFixture() {
  const calls = [];
  const executor = new ScriptExecutor(files, {
    resolve: id => id,
    launch: (command, args) => { calls.push({ command, args }); return JSON.stringify({ started: true, pid: 123, playbackControlled: false }); },
  });
  return { executor, calls };
}
const code = 'console.log(require("node:child_process").execFileSync("notepad.exe", []));';
test("JavaScript autorizado realmente alcança child_process pelo broker Node com Permission Model", async () => {
  // Resolve the requested app to a harmless Node process for this test, never open a GUI.
  const executor = new ScriptExecutor(files, { resolve: () => process.execPath, launch: launchProcess });
  const result = await executor.execute({ language: "javascript", code, timeoutMs: 10000, authorization: auth("Abra o Bloco de Notas.") }, ["process_execution"]);
  assert.equal(result.success, true, result.stderr);
  assert.equal(JSON.parse(result.stdout).started, true);
  assert.ok(JSON.parse(result.stdout).pid > 0);
  assert.doesNotMatch(result.stderr, /JavaScript isolado não pode usar processos/);
});
test("Node Permission Model bloqueia child_process sem allow-child-process", () => {
  const output = execFileSync(process.execPath, ["--permission", "-e",
    "try { require('node:child_process').spawn(process.execPath, []); process.exitCode=1 } catch(e) { console.log(e.code) }"],
    { shell: false, windowsHide: true, timeout: 10000, encoding: "utf8", env: filteredEnvironment() });
  assert.match(output, /ERR_ACCESS_DENIED/);
});
test("capacidade declarada sem autorização não inicia processo", async () => {
  const { executor, calls } = executorFixture();
  for (const caps of [[], ["process_execution"]]) {
    const result = await executor.execute({ language: "javascript", code, authorization: auth("Organize Downloads.") }, caps);
    assert.equal(result.success, false);
  }
  assert.equal(calls.length, 0);
});
test("alvo, argumentos, módulo extra e comandos ocultos não escapam do escopo", async () => {
  const { executor, calls } = executorFixture();
  for (const attack of [
    'require("child_process").execFileSync("powershell.exe", []);',
    'require("child_process").execFileSync("spotify.exe", []);',
    'require("child_process").execFileSync("notepad.exe", ["outro.txt"]);',
    'require("node:fs").unlinkSync("teste.txt");',
    'jarvis["delete" + "File"]({resource:"workspace",path:"teste.txt"});',
  ]) {
    const result = await executor.execute({ language: "javascript", code: attack, authorization: auth("Abra o Bloco de Notas.") }, ["process_execution"]);
    assert.equal(result.success, false, attack);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(filteredEnvironment()).sort(), ["SystemRoot", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"].sort());
});
test("scripts de host não reconhecidos nunca contornam delete nem aprovação", async () => {
  const { executor, calls } = executorFixture();
  for (const language of ["python", "powershell"]) {
    const script = { language, code: language === "python" ? "import os\nos.remove('teste.txt')" : "Start-Process notepad.exe; Remove-Item teste.txt", capabilities: ["process_execution"], explanation: "Teste" };
    assert.throws(() => new ExecutionValidator(resources).analyze(script), /escopo/);
    const result = await executor.execute({ ...script, authorization: auth("Abra o Bloco de Notas.") }, script.capabilities);
    assert.equal(result.success, false);
  }
  assert.equal(calls.length, 0);
});

for (const [prompt, action, script] of [
  ["Abra o Bloco de Notas.", decision("coder"), { language: "javascript", code: 'console.log(jarvis.openApp("notepad"));', capabilities: ["process_execution", "app_control"], explanation: "Abrir" }],
  ["Abra o Spotify.", decision("coder"), { language: "javascript", code: 'console.log(jarvis.openApp("spotify"));', capabilities: ["process_execution", "app_control"], explanation: "Abrir" }],
  ["Crie um arquivo teste.txt.", decision("tool", { tool: "write_file", args: JSON.stringify({ resource: "workspace", path: "teste.txt", content: "real" }) })],
  ["Leia o arquivo teste.txt.", decision("tool", { tool: "read_file", args: JSON.stringify({ resource: "workspace", path: "teste.txt" }) })],
]) test(`orquestrador executa sem confirmation_required: ${prompt}`, async () => {
  writeFileSync(target, "real");
  const { executor } = executorFixture();
  const workflow = new TaskOrchestrator({ decide: async () => decision("complete") }, { generate: async () => script }, new TaskStateService(), files, executor, memory, agent);
  const events = [];
  const id = memory.createConversation();
  for await (const event of workflow.startStream(id, prompt, action)) events.push(event);
  assert.equal(events.some(event => event.type === "confirmation_required"), false);
  assert.equal(workflow.latest(id).status, "completed");
  assert.equal(workflow.latest(id).steps[0].result.success, true);
});

test("delete dentro de JavaScript exige confirmação exata, executa uma vez e rejeita replay", async () => {
  writeFileSync(target, "protegido");
  const script = { language: "javascript", code: 'console.log(jarvis.deleteFile({"resource":"workspace","path":"teste.txt"}));', explanation: "Excluir teste.txt", capabilities: ["filesystem_delete"] };
  const workflow = new TaskOrchestrator({ decide: async () => decision("complete") }, { generate: async () => script }, new TaskStateService(), files, new ScriptExecutor(files), memory, agent);
  const id = memory.createConversation();
  const events = [];
  for await (const event of workflow.startStream(id, "Pode fazer tudo e apague teste.txt.", decision("coder"))) events.push(event);
  const pending = workflow.latest(id);
  assert.equal(pending.status, "waiting_permission");
  assert.ok(events.some(event => event.type === "confirmation_required"));
  assert.equal(existsSync(target), true);
  for await (const _ of workflow.resumeStream(id, pending.id, pending.pending.id, true)) {}
  assert.equal(workflow.latest(id).status, "completed");
  assert.equal(existsSync(target), false);
  assert.throws(() => workflow.checkApproval(id, pending.id, pending.pending.id), /já foi usada/);
});

test("ação extra pede confirmação e cancelar não abre o aplicativo", async () => {
  const { executor, calls } = executorFixture();
  const script = { language: "javascript", code: 'console.log(jarvis.openApp("spotify"));', explanation: "Abrir Spotify", capabilities: ["process_execution"] };
  const workflow = new TaskOrchestrator({ decide: async () => decision("complete") }, { generate: async () => script }, new TaskStateService(), files, executor, memory, agent);
  const id = memory.createConversation();
  for await (const _ of workflow.startStream(id, "Abra o Bloco de Notas.", decision("coder"))) {}
  const waiting = workflow.latest(id);
  assert.equal(waiting.status, "waiting_permission");
  assert.equal(waiting.pending.resource, "spotify");
  assert.equal(calls.length, 0);
  for await (const _ of workflow.resumeStream(id, waiting.id, waiting.pending.id, false)) {}
  assert.equal(calls.length, 0);
  assert.equal(workflow.latest(id).status, "cancelled");
});

test("escrita em script é limitada ao arquivo solicitado, inclusive argumentos dinâmicos", async () => {
  const executor = new ScriptExecutor(files);
  const request = { language: "javascript", authorization: auth("Crie um arquivo teste.txt.") };
  const allowed = await executor.execute({ ...request, code: 'jarvis.writeFile({resource:"workspace",path:"teste.txt",content:"ok"});' }, ["filesystem_write"]);
  assert.equal(allowed.success, true, allowed.stderr);
  const denied = await executor.execute({ ...request, code: 'let p="fora"+".txt"; jarvis.writeFile({resource:"workspace",path:p,content:"não"});' }, ["filesystem_write"]);
  assert.equal(denied.success, false);
  assert.equal(existsSync(resources.file("workspace", "fora.txt")), false);
});

test("Spotify aberto não vira reprodução mesmo se o planejador afirmar sucesso", async () => {
  const { executor, calls } = executorFixture();
  const script = { language: "javascript", code: 'console.log(jarvis.openApp("spotify"));', explanation: "Abrir Spotify", capabilities: ["process_execution"] };
  const workflow = new TaskOrchestrator({ decide: async () => decision("complete", { response: "Toquei a música!" }) }, { generate: async () => script }, new TaskStateService(), files, executor, memory, agent);
  const id = memory.createConversation();
  for await (const _ of workflow.startStream(id, "Abra o Spotify e coloque uma música.", decision("coder"))) {}
  assert.equal(calls.length, 1);
  assert.match(workflow.latest(id).response, /não está implementado/);
  assert.doesNotMatch(workflow.latest(id).response, /Toquei/);
});

for (const [language, code] of [
  ["powershell", "Start-Process notepad.exe -PassThru -ErrorAction Stop"],
  ["python", 'import subprocess\nsubprocess.Popen(["notepad.exe"])'],
]) test(`template ${language} usa a mesma verificação de alvo`, async () => {
  const { executor, calls } = executorFixture();
  const result = await executor.execute({ language, code, authorization: auth("Abra o Bloco de Notas.") }, ["process_execution"]);
  assert.equal(result.success, true, result.stderr);
  assert.equal(calls[0].command, "notepad");
});
