import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as os from "node:os";
import { filteredEnvironment } from "../execution/process.broker.js";
import { ApplicationLauncher } from "../execution/application.launcher.js";

const execFileAsync = promisify(execFile);
export class SystemRuntime {
  constructor(private readonly applications = new ApplicationLauncher()) {}
  async openApp(app: string, signal?: AbortSignal): Promise<unknown> { return this.applications.open(app, signal); }
  async openFile(path: string): Promise<unknown> {
    if (process.platform !== "win32") throw new Error("Abertura pelo aplicativo padrão implementada somente no Windows.");
    // Fixed trusted program. The document path is data, never interpolated into commands.
    const result = await execFileAsync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:JARVIS_DOCUMENT -ErrorAction Stop; Write-Output 'opened'"],
      { shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096, env: { ...filteredEnvironment(), JARVIS_DOCUMENT: path } });
    if (result.stdout.trim() !== "opened") throw new Error("O Windows não confirmou o encaminhamento ao aplicativo padrão.");
    return { path, opened: true, meaning: "Encaminhado ao aplicativo padrão; não comprova renderização na tela." };
  }
  systemInfo(): unknown {
    return { platform: os.platform(), release: os.release(), arch: os.arch(), hostname: os.hostname(),
      totalMemory: os.totalmem(), freeMemory: os.freemem(), cpuCount: os.cpus().length, uptimeSeconds: os.uptime() };
  }
  async runningProcesses(): Promise<unknown> {
    if (process.platform !== "win32") throw new Error("Listagem de processos implementada somente no Windows.");
    const result = await execFileAsync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"), ["/FO", "CSV", "/NH"],
      { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, env: filteredEnvironment() });
    const entries = result.stdout.split(/\r?\n/).flatMap(line => {
      const match = /^"((?:[^"]|"")*)","(\d+)"/.exec(line);
      return match ? [{ name: match[1]!.replace(/""/g, '"'), pid: Number(match[2]) }] : [];
    });
    return { processes: entries.slice(0, 200), total: entries.length, truncated: entries.length > 200 };
  }
}
