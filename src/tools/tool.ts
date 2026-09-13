import { PermissionManager, type AuthorizationContext, type PermissionRequest } from "../security/permission.manager.js";

export type ToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolContext = {
  conversationId: number;
  taskId?: string;
  authorization?: AuthorizationContext;
  approvedRequests?: PermissionRequest[];
  workspace?: string;
  signal?: AbortSignal;
};

export type ToolResult = { success: true; data: unknown } | { success: false; data?: unknown; error: { code: string; message: string } };

export type Tool = {
  definition: ToolDefinition;
  validate(args: unknown): Record<string, unknown>;
  validatePlan?(args: unknown): Record<string, unknown>;
  permissions(args: unknown): PermissionRequest[];
  fingerprint?(args: unknown): string;

  execute(
    args: unknown,
    context: ToolContext,
  ): Promise<ToolResult>;
};

export function toolPermissionError(requests: PermissionRequest[], context: ToolContext): Extract<ToolResult, { success: false }> | undefined {
  if (context.signal?.aborted) return { success: false, error: { code: "ABORTED", message: "Operação cancelada." } };
  for (const request of requests) {
    const permission = new PermissionManager().check(request, context.authorization);
    const confirmed = context.taskId && context.approvedRequests?.some(item => item.action === request.action && item.resource === request.resource);
    if (permission.decision === "deny" || (permission.decision !== "allow" && !confirmed)) {
      return { success: false, error: { code: permission.decision === "deny" ? "PERMISSION_DENIED" : "CONFIRMATION_REQUIRED", message: permission.reason } };
    }
  }
  return undefined;
}

/** All registered runtime tools use the same policy, including direct execute calls. */
export function guardedTool(spec: Omit<Tool, "execute"> & { run(args: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown }): Tool {
  return {
    definition: spec.definition, validate: spec.validate, permissions: spec.permissions,
    ...(spec.validatePlan ? { validatePlan: spec.validatePlan } : {}),
    ...(spec.fingerprint ? { fingerprint: spec.fingerprint } : {}),
    async execute(input, context) {
      try {
        const args = spec.validate(input);
        const denied = toolPermissionError(spec.permissions(args), context);
        if (denied) return denied;
        return { success: true, data: await spec.run(args, context) };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "TOOL_ERROR";
        return { success: false, ...(error && typeof error === "object" && "details" in error ? { data: error.details } : {}),
          error: { code, message: error instanceof Error ? error.message : "Falha na ferramenta." } };
      }
    },
  };
}

/** JSON-schema subset used by the registered tools; reject unknown keys before I/O. */
export function objectInput(input: unknown, properties: Record<string, { type: string; enum?: readonly string[] }>, required: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Argumentos devem ser um objeto.");
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new Error("Argumento desconhecido.");
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error("Argumento obrigatório: " + key);
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key]!;
    if (typeof value !== property.type || (typeof value === "string" && value.length > 65536) || (property.enum && !property.enum.includes(String(value)))) throw new Error("Argumento inválido: " + key);
  }
  return args;
}
