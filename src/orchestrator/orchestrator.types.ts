export type OrchestratorAction = "respond" | "tool" | "coder" | "complete";
export type AgentType = "conversation" | "coder";
export type OrchestratorDecision = {
  action: OrchestratorAction;
  task: string;
  tool: string;
  args: string;
  response: string;
};

export function parseDecision(input: unknown): OrchestratorDecision {
  if (!input || typeof input !== "object") throw new Error("Decisão inválida.");
  const value = input as Record<string, unknown>;
  if (!["respond", "tool", "coder", "complete"].includes(String(value.action))) throw new Error("Ação inválida.");
  for (const field of ["task", "tool", "args", "response"]) {
    if (typeof value[field] !== "string" || value[field].length > 80_000) throw new Error("Campo de decisão inválido: " + field);
  }
  return value as OrchestratorDecision;
}