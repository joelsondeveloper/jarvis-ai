export async function consumeStream(body, onText, onEvent = () => {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "error") throw new Error(event.message || "Erro ao gerar resposta.");
        if (event.type === "text") await onText(event.text);
        else if (event.type !== "done") await onEvent(event);
        if (event.type === "done") { completed = true; break; }
      }
      if (done) break;
    }
    if (!completed) throw new Error("A conexão foi interrompida antes de concluir a resposta.");
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}