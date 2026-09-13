import type { TaskPlan } from "./plan.types.js";

/** Preserve real effects; terminal tasks cannot keep runnable future work. */
export function closePlan(plan: TaskPlan, status: "failed" | "cancelled"): void {
  plan.status = status;
  for (const step of plan.steps) {
    if (step.status === "running") { step.status = "failed"; step.error ??= "Execução interrompida; resultado pode ser parcial."; }
    if (step.status !== "pending") continue;
    const dependencyFailed = step.dependsOn.some(id => plan.steps.some(prior => prior.id === id && ["failed", "skipped"].includes(prior.status)));
    step.status = "skipped";
    step.reasonCode = dependencyFailed ? "dependency_failed" : status === "cancelled" ? "task_cancelled" : "task_failed";
    step.reason = dependencyFailed ? "Não executada porque uma dependência falhou ou foi pulada." : "Não executada porque a tarefa foi encerrada.";
  }
}
