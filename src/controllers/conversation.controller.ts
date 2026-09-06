import type { Request, Response } from "express";
import { AgentService } from "../agent/agent.service.js";
import { MemoryService } from "../memory/memory.service.js";

export class ConversationController {
  constructor(
    private readonly memory: MemoryService,
    private readonly agent: AgentService,
  ) {}

  create = (_req: Request, res: Response): void => {
    const conversationId =
      this.memory.createConversation();

    res.status(201).json({
      id: conversationId,
    });
  };

  sendMessage = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const conversationId = Number(req.params.id);
    const { prompt } = req.body;

    const response = await this.agent.process(
      conversationId,
      prompt,
    );

    res.json({
      response,
    });
  };

  getMessages = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const conversationId = Number(req.params.id);

    const messages =
      await this.memory.getMessages(conversationId);

    res.json({
      messages,
    });
  };
}