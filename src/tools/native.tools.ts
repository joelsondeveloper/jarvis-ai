import { existsSync, statSync, renameSync } from "node:fs";
import { isAbsolute, relative, basename, dirname, join, extname } from "node:path";
import { applicationId } from "../security/authorization.js";
import { FileTools } from "./file.tools.js";
import { guardedTool, objectInput } from "./tool.js";
import { SystemRuntime } from "./system.runtime.js";

/** One catalog: existing file tools plus native capabilities. No new dispatcher. */
export function createRuntimeTools(files: FileTools, system = new SystemRuntime()) {
  const registry = files.registry();
  const pathProperties = { resource: { type: "string", enum: ["workspace", "downloads"] }, path: { type: "string" } };
  const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
  const location = (input: unknown, write = false) => {
    const args = objectInput(input, pathProperties, ["path"]);
    if (isAbsolute(String(args.path))) {
      for (const resource of ["workspace", "downloads"] as const) {
        if (args.resource && args.resource !== resource) continue;
        try {
          const path = relative(files.resources.resolve(resource), String(args.path));
          const absolute = files.resources.file(resource, path, write);
          return { resource, path, absolute };
        } catch { /* Try the other allowed root. */ }
      }
      throw new Error("Caminho fora dos recursos autorizados.");
    }
    const resource = args.resource === "downloads" ? "downloads" : "workspace";
    const path = String(args.path);
    return { resource, path, absolute: files.resources.file(resource, path, write) };
  };
  const canonicalLocation = (input: unknown, write = false) => {
    const { resource, path } = location(input, write);
    return { resource, path };
  };

  registry.register(guardedTool({
    definition: { type: "function", name: "list_directory", description: "Lista até 200 entradas de um diretório permitido. Downloads é somente leitura.", parameters: schema(pathProperties, ["resource", "path"]) },
    validate: input => canonicalLocation(input),
    permissions: input => [{ action: "read_file", resource: location(input).absolute }],
    run: input => files.run("list_files", canonicalLocation(input)),
  }));
  for (const name of ["file_exists", "get_file_info"] as const) registry.register(guardedTool({
    definition: { type: "function", name, description: name === "file_exists" ? "Verifica existência de arquivo ou diretório permitido." : "Consulta tipo, tamanho e datas de arquivo/diretório sem ler o conteúdo.", parameters: schema(pathProperties, ["resource", "path"]) },
    validate: input => canonicalLocation(input),
    permissions: input => [{ action: "read_file", resource: location(input).absolute }],
    run: input => {
      const { absolute: path } = location(input);
      if (name === "file_exists") return { path, exists: existsSync(path) };
      const stat = statSync(path);
      return { path, type: stat.isDirectory() ? "directory" : "file", size: stat.size, modifiedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString() };
    },
  }));

  for (const name of ["move_file", "rename_file"] as const) {
    const properties = { ...pathProperties, ...(name === "move_file" ? { destinationPath: { type: "string" }, destinationResource: { type: "string", enum: ["workspace"] } } : { newName: { type: "string" } }) };
    const required = ["resource", "path", name === "move_file" ? "destinationPath" : "newName"];
    const validate = (input: unknown, planning = false): Record<string, unknown> => {
      const args = objectInput(input, properties, required);
      const source = location({ resource: args.resource, path: args.path }, true);
      if (!planning && !statSync(source.absolute).isFile()) throw new Error("Somente arquivos podem ser movidos ou renomeados.");
      if (name === "rename_file" && (basename(String(args.newName)) !== args.newName || /[\\/:]/.test(String(args.newName)))) throw new Error("Novo nome deve ser apenas um nome de arquivo.");
      const destination = name === "move_file" ? String(args.destinationPath) : join(dirname(source.path), String(args.newName));
      const target = files.resources.file("workspace", destination, true);
      if (!planning && existsSync(target)) throw new Error("Destino já existe; sobrescrita em movimento/renomeação é bloqueada.");
      return { ...args, resource: source.resource, path: source.path };
    };
    const paths = (input: unknown) => {
      const args = validate(input);
      return { source: files.resources.file("workspace", String(args.path), true),
        destination: files.resources.file("workspace", name === "move_file" ? String(args.destinationPath) : join(dirname(String(args.path)), String(args.newName)), true) };
    };
    registry.register(guardedTool({
      definition: { type: "function", name, description: "Move/renomeia um arquivo dentro da workspace, sem sobrescrever destino. Origem e destino precisam estar autorizados.", parameters: schema(properties, required) },
      validate,
      validatePlan: input => validate(input, true),
      permissions: input => { const p = paths(input); return [{ action: "move_file", resource: JSON.stringify([p.source, p.destination]) }]; },
      fingerprint: input => { const p = paths(input); const stat = statSync(p.source); return JSON.stringify([p.source, p.destination, stat.ino, stat.size, stat.mtimeMs]); },
      run: input => { const p = paths(input); renameSync(p.source, p.destination); return { ...p, moved: true }; },
    }));
  }

  const appProperties = { app: { type: "string", enum: ["notepad", "spotify", "Bloco de Notas", "bloco de notas", "notepad.exe", "spotify.exe"] } };
  const appArgs = (input: unknown) => {
    const args = objectInput(input, appProperties, ["app"]);
    const app = applicationId(String(args.app));
    if (!app) throw new Error("Aplicativo não cadastrado.");
    return { app };
  };
  registry.register(guardedTool({
    definition: { type: "function", name: "open_app", description: "Abre Bloco de Notas ou Spotify instalado/localizável. Retorna processo real. Não controla interface nem música; não instala programas.", parameters: schema(appProperties, ["app"]) },
    validate: appArgs,
    permissions: input => [{ action: "execute_process", resource: appArgs(input).app }],
    run: (input, context) => system.openApp(appArgs(input).app, context.signal),
  }));
  const document = (input: unknown, planning = false) => {
    const args = canonicalLocation(input);
    const path = location(args).absolute;
    if ((!planning && !statSync(path).isFile()) || ![".txt", ".md", ".json", ".csv", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".docx", ".xlsx"].includes(extname(path).toLowerCase())) throw new Error("Tipo de documento não permitido para abertura. Executáveis, scripts e atalhos são bloqueados.");
    return args;
  };
  registry.register(guardedTool({
    definition: { type: "function", name: "open_file", description: "Abre documento permitido no aplicativo padrão do Windows. Aceita path absoluto dentro das raízes ou resource/path relativos. Não abre scripts, executáveis ou atalhos.", parameters: schema(pathProperties, ["path"]) },
    validate: document,
    validatePlan: input => document(input, true),
    permissions: input => [{ action: "open_file", resource: location(document(input)).absolute }],
    run: input => system.openFile(location(document(input)).absolute),
  }));
  for (const name of ["get_system_info", "get_running_processes"] as const) registry.register(guardedTool({
    definition: { type: "function", name, description: name === "get_system_info" ? "Consulta SO, arquitetura, memória, CPUs e uptime sem variáveis de ambiente." : "Lista nomes e PIDs de até 200 processos, sem linha de comando, credenciais ou controle de processos.", parameters: schema({}, []) },
    validate: input => objectInput(input, {}, []),
    permissions: () => [{ action: "query_system", resource: name }],
    run: () => name === "get_system_info" ? system.systemInfo() : system.runningProcesses(),
  }));
  return registry;
}
