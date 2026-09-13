import { consumeStream } from "./stream.js";
import { VoiceService } from "./voice.js";

const form = document.getElementById("chat-form");
const input = document.getElementById("prompt");
const messages = document.getElementById("messages");
const button = form.querySelector('button[type="submit"]');
const status = document.querySelector(".status");
const confirmation = document.getElementById("confirmation");
const confirmationText = document.getElementById("confirmation-text");
const confirmButton = document.getElementById("confirm-button");
const cancelButton = document.getElementById("cancel-button");
const newConversationButton = document.getElementById("new-conversation");
const voiceToggle = document.getElementById("voice-toggle");
const voiceStop = document.getElementById("voice-stop");
const voiceSelect = document.getElementById("voice-select");
const taskPanel = document.getElementById("task-panel");
const taskStatus = document.getElementById("task-status");
const taskDetails = document.getElementById("task-details");
const storageKey = "jarvis.conversationId";
const voiceService = new VoiceService();
const labels = {
  planning: "Planejando a próxima etapa…", running: "Executando…",
  waiting_permission: "Aguardando sua aprovação", completed: "Concluído",
  failed: "Não concluído", cancelled: "Cancelado",
};
let conversationId = null;
let currentTask = null;
let busy = false;
let pollTimer = null;

function renderVoiceControls(voices = voiceService.listVoices()) {
  if (voiceToggle) {
    voiceToggle.textContent = voiceService.enabled ? "Voz: ligada" : "Voz: desligada";
    voiceToggle.setAttribute?.("aria-pressed", String(voiceService.enabled));
  }
  if (voiceStop) voiceStop.disabled = !voiceService.synthesis;
  if (!voiceSelect) return;
  const selected = voiceService.voiceName;
  voiceSelect.replaceChildren();
  for (const voice of voices) {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    option.selected = voice.name === selected;
    voiceSelect.appendChild(option);
  }
  voiceSelect.disabled = !voices.length;
}

function addMessage(content, role) {
  const element = document.createElement("div");
  element.className = `message ${role}`;
  element.textContent = content;
  messages.appendChild(element);
  messages.scrollTop = messages.scrollHeight;
  return element;
}
function clearConversationView() {
  messages.replaceChildren();
  addMessage("Conversa iniciada. Como posso ajudar?", "assistant");
  renderTask(null);
}
function activeTask() {
  return currentTask && ["planning", "running", "waiting_permission"].includes(currentTask.status);
}
function setBusy(value) {
  busy = value;
  input.disabled = value || Boolean(activeTask());
  button.disabled = input.disabled;
  if (confirmButton) confirmButton.disabled = value;
  if (cancelButton) cancelButton.disabled = value;
  if (!value) schedulePoll();
}
function schedulePoll() {
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  if (!busy && currentTask && ["planning", "running"].includes(currentTask.status)) {
    pollTimer = setTimeout(async () => {
      try {
        const response = await checkResponse(await fetch(`/conversations/${conversationId}/tasks/${currentTask.id}`));
        const { task } = await response.json();
        renderTask(task);
        if (!["planning", "running"].includes(task.status)) await loadHistory();
      } catch (error) { status.textContent = error.message; }
      finally { setBusy(false); }
    }, 1500);
  }
}
function renderTask(task) {
  currentTask = task;
  if (!task) {
    if (confirmation) confirmation.classList.add("hidden");
    if (taskPanel) taskPanel.hidden = true;
    return;
  }
  if (taskPanel) taskPanel.hidden = false;
  if (taskStatus) taskStatus.textContent = labels[task.status] || task.status;
  status.textContent = activeTask() ? labels[task.status] : "● ONLINE";
  if (taskDetails) taskDetails.textContent = (task.plan ? `Plano v${task.plan.version}${task.plan.version > 1 ? " — ↻ Plano atualizado" : ""}\n\n` : "") + (task.plan?.steps || task.steps).map((step, index) => {
    const result = step.error || step.result?.output || "";
    const marker = ({ completed: "✓", running: "●", pending: "○", failed: "✕", skipped: "↷", skipped_duplicate: "↷" })[step.status] || "○";
    return `${marker} ${index + 1}. ${step.description} [${step.status}]\n${(result || step.reason || "").slice(0, 4000)}`;
  }).join("\n\n") || "Analisando seu pedido.";
  if (confirmation) confirmation.classList.toggle("hidden", task.status !== "waiting_permission");
  if (confirmationText && task.pending) {
    const step = task.steps.find((item) => item.id === task.pending.stepId);
    const action = step?.action;
    const review = action?.kind === "script"
      ? `Capacidades: ${action.script.capabilities.join(", ") || "cálculo apenas"}\n\n${action.script.code}`
      : JSON.stringify(action?.args, null, 2);
    confirmationText.textContent = `${task.pending.summary}\n\n${step?.description || ""}\n${review}\n\nVálida até ${new Date(task.pending.expiresAt).toLocaleTimeString()}.`;
  }
}
async function checkResponse(response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response;
}
async function loadHistory() {
  const response = await checkResponse(await fetch(`/conversations/${conversationId}/messages`));
  const history = await response.json();
  messages.replaceChildren();
  for (const message of history.messages) addMessage(message.content, message.role);
  renderTask(history.task ?? null);
}
async function initialize() {
  let saved = null;
  try { saved = localStorage.getItem(storageKey); } catch {}
  if (saved && /^[1-9]\d*$/.test(saved) && Number.isSafeInteger(Number(saved))) {
    const response = await fetch(`/conversations/${saved}/messages`);
    if (response.status !== 404) {
      await checkResponse(response);
      const history = await response.json();
      conversationId = Number(saved);
      messages.replaceChildren();
      for (const message of history.messages) addMessage(message.content, message.role);
      renderTask(history.task ?? null);
    }
  }
  if (conversationId === null) {
    const response = await checkResponse(await fetch("/conversations", { method: "POST" }));
    conversationId = (await response.json()).id;
    clearConversationView();
  }
  try { localStorage.setItem(storageKey, String(conversationId)); } catch {}
  if (!activeTask()) status.textContent = "● ONLINE";
}
newConversationButton?.addEventListener("click", async () => {
  if (busy || activeTask()) return;
  voiceService.stop();
  newConversationButton.disabled = true;
  try {
    const response = await checkResponse(await fetch("/conversations", { method: "POST" }));
    conversationId = (await response.json()).id;
    try { localStorage.setItem(storageKey, String(conversationId)); } catch {}
    clearConversationView();
    input.focus();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Não foi possível criar a conversa.";
  } finally {
    newConversationButton.disabled = false;
  }
});
async function receive(response, element) {
  await checkResponse(response);
  if (!response.body) throw new Error("O servidor não retornou um stream.");
  let receivedText = false;
  let assistantBuffer = "";
  await consumeStream(response.body, async (text) => {
    if (!text) return;
    assistantBuffer += text;
    if (!receivedText) { element.textContent = ""; receivedText = true; }
    status.textContent = "Respondendo...";
    element.textContent += text;
    messages.scrollTop = messages.scrollHeight;
    if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible") {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, (event) => {
    if (["tool_started", "tool_completed", "tool_failed"].includes(event.type)) {
      status.textContent = event.message;
      if (!receivedText) element.textContent = event.message;
    }
    if (["task", "status", "task_started", "confirmation_required", "task_completed", "task_failed", "task_planned", "step_started", "step_completed", "step_failed", "plan_updated"].includes(event.type) && event.task) {
      renderTask(event.task);
      if (!receivedText) element.textContent = labels[event.task.status] || "Processando...";
    }
  });
  if (assistantBuffer) voiceService.speak(assistantBuffer);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (busy || activeTask() || !prompt) return;
  setBusy(true);
  let element;
  try {
    if (conversationId === null) await initialize();
    if (activeTask()) return;
    voiceService.stop();
    input.value = "";
    addMessage(prompt, "user");
    element = addMessage("Processando...", "assistant");
    await receive(await fetch(`/conversations/${conversationId}/messages/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }),
    }), element);
  } catch (error) {
    const text = `Erro: ${error.message || "Erro desconhecido."}`;
    if (element) element.textContent += "\n" + text;
    else addMessage(text, "assistant");
    if (conversationId !== null) {
      try { await loadHistory(); addMessage(text, "assistant"); } catch {}
    }
  } finally {
    if (!activeTask()) status.textContent = "● ONLINE";
    setBusy(false);
    input.focus();
  }
});
async function decideApproval(allow) {
  if (busy || !currentTask?.pending) return;
  const task = currentTask;
  voiceService.stop();
  setBusy(true);
  const element = addMessage(allow ? "Retomando tarefa..." : "Cancelando...", "assistant");
  try {
    await receive(await fetch(`/conversations/${conversationId}/tasks/${task.id}/approval`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: task.pending.id, allow }),
    }), element);
  } catch (error) {
    element.textContent = `Erro: ${error.message}`;
    try { await loadHistory(); addMessage(`Erro: ${error.message}`, "assistant"); } catch {}
  } finally { setBusy(false); input.focus(); }
}
confirmButton?.addEventListener("click", () => decideApproval(true));
cancelButton?.addEventListener("click", () => decideApproval(false));
voiceToggle?.addEventListener("click", () => {
  voiceService.setEnabled(!voiceService.enabled);
  renderVoiceControls();
});
voiceStop?.addEventListener("click", () => voiceService.stop());
voiceSelect?.addEventListener("change", () => voiceService.setVoice(voiceSelect.value));
voiceService.onVoicesChanged(renderVoiceControls);
renderVoiceControls();
setBusy(true);
status.textContent = "Conectando...";
initialize().catch((error) => {
  status.textContent = "Falha na conexão";
  addMessage(`Erro: ${error.message}. Envie uma mensagem para tentar novamente.`, "assistant");
}).finally(() => setBusy(false));
