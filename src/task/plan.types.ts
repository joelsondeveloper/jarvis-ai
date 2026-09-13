import type { TaskStep } from "./task.types.js";
export type PlanStep = {
  evaluated?: boolean;
  id: string; description: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "skipped_duplicate";
  execution: { kind: "tool"; toolName: string; arguments: Record<string, unknown> } | { kind: "coder"; task: string; coderMode?: "compute" | "script"; input?: string };
  dependsOn: string[]; occurrence: number; attempts: number;
  expect?: { path: string; value: unknown };
  result?: TaskStep["result"]; error?: string; reason?: string;
  reasonCode?: string;
};
export type TaskPlan = { id: string; taskId: string; version: number; goal: string;
  status: "active" | "replanning" | "completed" | "failed" | "cancelled";
  steps: PlanStep[]; createdAt: string; updatedAt: string };
export type PlanProvider = {
  plan(input: string, signal?: AbortSignal): Promise<unknown>;
  evaluate(input: string, signal?: AbortSignal): Promise<unknown>;
};
