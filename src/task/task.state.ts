import { randomUUID } from "node:crypto";
import { closePlan } from "./terminal.plan.js";
import { database } from "../database/database.js";
import type { TaskState } from "./task.types.js";
import type { AuthorizationContext } from "../security/permission.manager.js";

export class TaskStateService {
  constructor() {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_conversation ON tasks(conversation_id);
    `);
  }

  recoverInterrupted(): void {
    for (const row of database.prepare("SELECT data FROM tasks").all() as { data: string }[]) {
      const task = JSON.parse(row.data) as TaskState;
      if (task.status === "running" || task.status === "planning") {
        task.status = "failed";
        if (task.plan) {
          closePlan(task.plan, "failed");
          task.plan.status = "failed";
          for (const step of task.plan.steps) if (step.status === "running") {
            step.status = "failed"; step.error = "Execução interrompida; resultado pode ser parcial.";
          }
        }
        task.response = "O servidor reiniciou durante a tarefa. Confira os resultados antes de tentar novamente; ações não foram repetidas automaticamente.";
        for (const step of task.steps) {
          if (step.status === "running") { step.status = "failed"; step.error = "Execução interrompida; resultado pode ser parcial."; }
        }
        this.save(task);
      }
    }
  }

  create(conversationId: number, userRequest: string, authorization: AuthorizationContext = { read: false, write: false, process: false, network: false }): TaskState {
    const now = new Date().toISOString();
    const task: TaskState = {
      id: randomUUID(), conversationId, userRequest, status: "planning",
      currentStep: 0, steps: [], decisions: 0, consecutiveFailures: 0, authorization, createdAt: now, updatedAt: now,
    };
    this.save(task);
    return task;
  }

  save(task: TaskState): void {
    task.updatedAt = new Date().toISOString();
    if (task.plan) task.plan.updatedAt = task.updatedAt;
    database.prepare(`
      INSERT INTO tasks (id, conversation_id, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(task.id, task.conversationId, JSON.stringify(task));
  }

  get(id: string): TaskState | undefined {
    const row = database.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TaskState : undefined;
  }

  latest(conversationId: number): TaskState | undefined {
    const row = database.prepare("SELECT data FROM tasks WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(conversationId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TaskState : undefined;
  }
}
