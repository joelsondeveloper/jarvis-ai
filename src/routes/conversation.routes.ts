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

  router.post(
  "/conversations/:id/messages/stream",
  controller.streamMessage,
);

  router.get(
    "/conversations/:id/messages",
    controller.getMessages,
  );

  router.get("/conversations/:id/tasks/:taskId", controller.getTask);
  router.post("/conversations/:id/tasks/:taskId/approval", controller.approveTask);

  return router;
}