import { homedir } from "node:os";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { lstatSync, realpathSync, mkdirSync } from "node:fs";

export type ResourceType = "downloads" | "workspace";

export class ResourceResolver {
  constructor(
    private readonly workspacePath = resolve(process.cwd(), "workspace"),
    private readonly downloadsPath = join(homedir(), "Downloads"),
  ) {
    mkdirSync(workspacePath, { recursive: true });
  }

  resolve(resource: ResourceType): string {
    if (resource === "workspace") return this.workspacePath;
    if (resource === "downloads") return this.downloadsPath;
    throw new Error("Recurso não permitido.");
  }

  file(resource: ResourceType, input: string, write = false): string {
    if (write && resource !== "workspace") throw new Error("Alterações são permitidas somente na workspace.");
    if (typeof input !== "string" || input.length > 1024 || /[:\x00]/.test(input) || isAbsolute(input)) {
      throw new Error("Informe um caminho relativo válido.");
    }
    const root = realpathSync(this.resolve(resource));
    const target = resolve(root, input || ".");
    const inside = (path: string) => {
      const rel = relative(root, path);
      return rel !== ".." && !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && !isAbsolute(rel);
    };
    if (!inside(target)) throw new Error("Caminho fora do recurso autorizado.");
    if (write && target === root) throw new Error("Não é permitido alterar a raiz do recurso.");
    let current = target;
    while (!lstatSync(current, { throwIfNoEntry: false })) {
      const parent = dirname(current);
      if (parent === current) throw new Error("Caminho inválido.");
      current = parent;
    }
    if (lstatSync(current).isSymbolicLink() || !inside(realpathSync(current))) {
      throw new Error("Links para fora do recurso não são permitidos.");
    }
    // Reject symlink/junction ancestors too, including links inside the root.
    current = target;
    while (current !== root) {
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Links simbólicos não são permitidos.");
      current = dirname(current);
    }
    return target;
  }
}