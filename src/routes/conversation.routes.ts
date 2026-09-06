import { Router } from "express";
import { ConversationController } from "../controllers/conversation.controller.js";

export function createConversationRoutes(
  controller: ConversationController,
): Router {
  const router = Router();

  router.post(
    "/conversations",
    controller.create,
  );

  router.post(
    "/conversations/:id/messages",
    controller.sendMessage,
  );

  router.get(
    "/conversations/:id/messages",
    controller.getMessages,
  );

  return router;
}