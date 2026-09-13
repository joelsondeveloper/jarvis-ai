import type { Request, Response } from "express";
import { AgentService } from "../agent/agent.service.js";
import { MemoryService } from "../memory/memory.service.js";
import { TaskOrchestrator, WorkflowError } from "../orchestrator/task.orchestrator.js";
import type { MessageRouter } from "../conversation/message.router.js";

type Event = { type: string; text?: string };
export class ConversationController {
  private readonly activeConversations = new Set<number>();
  constructor(
    private readonly memory: MemoryService,
    private readonly agent: AgentService,
    private readonly orchestrator?: TaskOrchestrator,
    private readonly router?: MessageRouter,
  ) {}

  private conversationId(req: Request, res: Response): number | undefined {
    const raw = req.params.id;
    const id = Number(raw);
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id)) {
      res.status(400).json({ error: "ID de conversa inválido." }); return;
    }
    if (!this.memory.hasConversation(id)) {
      res.status(404).json({ error: "Conversa não encontrada." }); return;
    }
    return id;
  }
  private prompt(req: Request, res: Response): string | undefined {
    const value: unknown = req.body?.prompt;
    if (typeof value !== "string" || !value.trim() || value.length > 10_000) {
      res.status(400).json({ error: "Envie uma mensagem de 1 a 10000 caracteres." }); return;
    }
    return value.trim();
  }
  private idle(id: number): void {
    if (this.activeConversations.has(id)) throw new WorkflowError("Aguarde a resposta anterior desta conversa.");
  }
  private error(res: Response, error: unknown): void {
    if (error instanceof WorkflowError) res.status(error.status).json({ error: error.message });
    else {
      console.error(error);
      res.status(502).json({ error: "Erro ao gerar resposta. Tente novamente." });
    }
  }
  create = (_req: Request, res: Response): void => {
    res.status(201).json({ id: this.memory.createConversation() });
  };
  getMessages = async (req: Request, res: Response): Promise<void> => {
    const id = this.conversationId(req, res);
    if (id === undefined) return;
    res.json({ messages: await this.memory.getMessages(id), task: this.orchestrator?.latest(id) ?? null });
  };
  getTask = (req: Request, res: Response): void => {
    const id = this.conversationId(req, res);
    if (id === undefined) return;
    try {
      if (!this.orchestrator) throw new WorkflowError("Orquestrador indisponível.", 503);
      res.json({ task: this.orchestrator.get(id, String(req.params.taskId)) });
    } catch (error) { this.error(res, error); }
  };
  sendMessage = async (req: Request, res: Response): Promise<void> => {
    const id = this.conversationId(req, res);
    if (id === undefined) return;
    const prompt = this.prompt(req, res);
    if (prompt === undefined) return;
    try {
      this.idle(id);
      this.orchestrator?.assertCanStart(id);
    } catch (error) { this.error(res, error); return; }
    this.activeConversations.add(id);
    try {
      if (!this.orchestrator) {
        res.json({ response: await this.agent.process(id, prompt) });
      } else {
        let response = "";
        for await (const event of this.router ? this.router.stream(id, prompt) : this.orchestrator.startStream(id, prompt)) {
          if (event.type === "text") response += event.text;
        }
        res.json({ response, task: this.orchestrator.latest(id) });
      }
    } catch (error) { this.error(res, error); }
    finally { this.activeConversations.delete(id); }
  };
  streamMessage = async (req: Request, res: Response): Promise<void> => {
    const id = this.conversationId(req, res);
    if (id === undefined) return;
    const prompt = this.prompt(req, res);
    if (prompt === undefined) return;
    try {
      this.idle(id);
      this.orchestrator?.assertCanStart(id);
    } catch (error) { this.error(res, error); return; }
    const events = this.router ? this.router.stream(id, prompt) : this.orchestrator
      ? this.orchestrator.startStream(id, prompt)
      : this.agent.processStream(id, prompt);
    await this.stream(id, res, events);
  };
  approveTask = async (req: Request, res: Response): Promise<void> => {
    const id = this.conversationId(req, res);
    if (id === undefined) return;
    const { approvalId, allow } = req.body ?? {};
    if (typeof approvalId !== "string" || approvalId.length > 100 || typeof allow !== "boolean") {
      res.status(400).json({ error: "Envie approvalId e allow (booleano)." }); return;
    }
    try {
      this.idle(id);
      if (!this.orchestrator) throw new WorkflowError("Orquestrador indisponível.", 503);
      this.orchestrator.checkApproval(id, String(req.params.taskId), approvalId);
    } catch (error) { this.error(res, error); return; }
    await this.stream(id, res, this.orchestrator!.resumeStream(id, String(req.params.taskId), approvalId, allow));
  };
  private async stream(id: number, res: Response, events: AsyncIterable<Event>): Promise<void> {
    this.activeConversations.add(id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    try {
      for await (const event of events) {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      console.error(error);
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "error", message: "Erro ao gerar resposta. Tente novamente." })}\n\n`);
    } finally {
      this.activeConversations.delete(id);
      res.end();
    }
  }
}
