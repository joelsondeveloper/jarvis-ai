import { toolPermissionError, type Tool } from "./tool.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(
        `A ferramenta "${tool.definition.name}" já está registrada.`,
      );
    }

    this.tools.set(
      tool.definition.name,
      { ...tool, async execute(input, context) {
        try {
          const args = tool.validate(input);
          const denied = toolPermissionError(tool.permissions(args), context);
          if (denied) return denied;
          return await tool.execute(args, context);
        } catch (error) {
          return { success: false, error: { code: "INVALID_TOOL_INPUT", message: error instanceof Error ? error.message : "Argumentos inválidos." } };
        }
      } },
    );
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): Tool["definition"][] {
    return Array.from(this.tools.values(), (tool) => structuredClone(tool.definition));
  }
}
