import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { ResourceResolver, type ResourceType } from "../security/resource.resolver.js";
import { ToolRegistry } from "./tool.registry.js";
import { guardedTool, objectInput } from "./tool.js";

export const FILE_TOOLS = ["list_files", "read_file", "write_file", "delete_file"] as const;
export type FileToolName = typeof FILE_TOOLS[number];
export type FileArgs = { resource: ResourceType; path: string; content?: string };
const MAX_BYTES = 64 * 1024;

export class FileTools {
  constructor(readonly resources: ResourceResolver) {}

  validate(name: string, input: unknown): FileArgs {
    if (!FILE_TOOLS.includes(name as FileToolName)) throw new Error("Ferramenta desconhecida.");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Argumentos inválidos.");
    const args = input as Record<string, unknown>;
    if (args.resource !== "workspace" && args.resource !== "downloads") throw new Error("Recurso inválido.");
    if (typeof args.path !== "string") throw new Error("Caminho inválido.");
    const result: FileArgs = { resource: args.resource, path: args.path };
    if (name === "write_file") {
      if (typeof args.content !== "string" || Buffer.byteLength(args.content) > MAX_BYTES) {
        throw new Error("Conteúdo deve ser texto com no máximo 64 KiB.");
      }
      result.content = args.content;
    }
    this.resources.file(result.resource, result.path, this.mutates(name));
    return result;
  }

  mutates(name: string): boolean { return name === "write_file" || name === "delete_file"; }

  fingerprint(name: string, args: FileArgs): string {
    const path = this.resources.file(args.resource, args.path, this.mutates(name));
    if (!existsSync(path)) return "missing";
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("A operação aceita somente arquivos de até 64 KiB.");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  run(name: string, input: unknown): unknown {
    const args = this.validate(name, input);
    const path = this.resources.file(args.resource, args.path, this.mutates(name));
    if (name === "list_files") {
      const entries = readdirSync(path, { withFileTypes: true });
      return { resource: args.resource, path: args.path, total: entries.length,
        entries: entries.slice(0, 200).map((entry) => ({
          name: entry.name, type: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "file",
        })), truncated: entries.length > 200 };
    }
    if (name === "read_file") {
      if (!statSync(path).isFile() || statSync(path).size > MAX_BYTES) throw new Error("Leia um arquivo de até 64 KiB.");
      return { resource: args.resource, path: args.path, content: readFileSync(path, "utf8") };
    }
    this.fingerprint(name, args);
    if (name === "write_file") {
      writeFileSync(path, args.content!, "utf8");
      return { path, written: true, bytes: Buffer.byteLength(args.content!) };
    }
    unlinkSync(path); // Explicit file only; never recursively removes directories.
    return { path, deleted: true };
  }

  registry(): ToolRegistry {
    const registry = new ToolRegistry();
    for (const name of FILE_TOOLS) {
      const properties = { resource: { type: "string", enum: ["workspace", "downloads"] }, path: { type: "string" }, ...(name === "write_file" ? { content: { type: "string" } } : {}) };
      registry.register(guardedTool({
        definition: {
          type: "function", name,
          description: ({
            list_files: "Lista até 200 entradas de um diretório.",
            read_file: "Lê um arquivo de texto de até 64 KiB.",
            write_file: "Cria ou sobrescreve um arquivo na workspace; pedido explícito autoriza somente o arquivo solicitado, fora do escopo requer aprovação.",
            delete_file: "Exclui um único arquivo na workspace; requer aprovação.",
          })[name],
          parameters: { type: "object", additionalProperties: false, properties, required: name === "write_file" ? ["resource", "path", "content"] : ["resource", "path"] },
        },
        validate: input => ({ ...this.validate(name, objectInput(input, properties, name === "write_file" ? ["resource", "path", "content"] : ["resource", "path"])) }),
        permissions: input => {
          const args = this.validate(name, input);
          return [{ action: name === "list_files" ? "read_file" : name, resource: this.resources.file(args.resource, args.path, this.mutates(name)) }];
        },
        ...(this.mutates(name) ? { fingerprint: (input: unknown) => this.fingerprint(name, this.validate(name, input)) } : {}),
        run: args => this.run(name, args),
      }));
    }
    return registry;
  }
}
