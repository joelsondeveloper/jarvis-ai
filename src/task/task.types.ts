import type { CoderResult } from "../ai/qwen-coder.provider.js";
import type { ToolResult } from "../tools/tool.js";
import type { TaskPlan } from "./plan.types.js";
import type { AuthorizationContext } from "../security/permission.manager.js";

export type TaskStatus = "planning" | "running" | "waiting_permission" | "failed" | "completed" | "cancelled";
export type TaskStepStatus = "pending" | "running" | "completed" | "failed";
export type TaskAction =
  | { kind: "tool"; name: string; args: Record<string, unknown>; fingerprint?: string }
  | { kind: "script"; script: CoderResult; coderMode?: "compute" | "script"; input?: string };
export type TaskStep = {
  id: string; description: string; status: TaskStepStatus; attempts: number;
  planStepId?: string; signature?: string; occurrence?: number;
  action: TaskAction; result?: { success: boolean; output: string; toolResult?: ToolResult }; error?: string;
};
export type PendingApproval = {
  id: string; stepId: string; expiresAt: string; summary: string; action: string; resource?: string;
};
export type TaskState = {
  id: string; conversationId: number; userRequest: string; status: TaskStatus;
  authorization: AuthorizationContext;
  plan?: TaskPlan; planVersions?: TaskPlan[]; formatVersion?: 2;
  currentStep: number; steps: TaskStep[]; decisions: number; consecutiveFailures: number;
  pending?: PendingApproval; response?: string; createdAt: string; updatedAt: string;
  error?: { code: string; message: string };
};
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "task"; task: TaskState }
  | { type: "status" | "task_started" | "confirmation_required" | "task_completed" | "task_failed" | "task_planned" | "plan_updated" | "step_started" | "step_completed" | "step_failed"; task: TaskState }
  | { type: "tool_started" | "tool_completed" | "tool_failed"; tool: string; taskId: string; stepId: string; message: string }
  | { type: "done" };
