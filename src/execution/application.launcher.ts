import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, isAbsolute } from "node:path";
import { applicationId } from "../security/authorization.js";
import { filteredEnvironment, resolveApplication } from "./process.broker.js";

const runFile = promisify(execFile);
const powershell = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
export type LaunchMethod = "win32" | "protocol" | "aumid";
export type AppLaunchResult = { app: string; launchMethod: LaunchMethod; started: true; playbackControlled: false; pid?: number; activationRequested?: boolean };
export interface ApplicationPlatform {
  win32(app: string): string | undefined;
  protocolRegistered(signal?: AbortSignal): Promise<boolean>;
  spotifyAumid(signal?: AbortSignal): Promise<string | undefined>;
  launchWin32(path: string, signal?: AbortSignal): Promise<number>;
  activate(target: string, signal?: AbortSignal): Promise<void>;
}
const spotifyAumid = /^SpotifyAB\.SpotifyMusic_zpdnekdrzrea0![a-z0-9._-]+$/i;

async function trustedPowerShell(code: string, signal?: AbortSignal, target?: string): Promise<string> {
  const result = await runFile(powershell(), ["-NoProfile", "-NonInteractive", "-Command", code], {
    shell: false, windowsHide: true, timeout: 5000, maxBuffer: 8192,
    env: { ...filteredEnvironment(), ...(target ? { JARVIS_ACTIVATION_TARGET: target } : {}) },
    ...(signal ? { signal } : {}),
  });
  return result.stdout.trim();
}

const windowsPlatform: ApplicationPlatform = {
  win32(app) { try { return resolveApplication(app); } catch { return undefined; } },
  async protocolRegistered(signal) {
    return await trustedPowerShell("$ErrorActionPreference='Stop'; $keys=@('Registry::HKEY_CURRENT_USER\\Software\\Classes\\spotify','Registry::HKEY_LOCAL_MACHINE\\Software\\Classes\\spotify'); foreach($key in $keys){ if(Test-Path -LiteralPath $key){ $item=Get-Item -LiteralPath $key; if($item.GetValueNames() -contains 'URL Protocol'){ Write-Output 'registered'; break } } }", signal) === "registered";
  },
  async spotifyAumid(signal) {
    const value = await trustedPowerShell("$ErrorActionPreference='Stop'; Get-StartApps | Where-Object { $_.AppID -like 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!*' } | Select-Object -First 1 -ExpandProperty AppID", signal);
    return spotifyAumid.test(value) ? value : undefined;
  },
  async launchWin32(path, signal) {
    // Only fixed trusted Node code can spawn; generated/model text is not evaluated.
    const launcher = "const {spawn}=require('node:child_process');const p=spawn(process.argv[1],[],{shell:false,detached:true,stdio:'ignore',windowsHide:false,env:process.env});p.once('error',()=>{process.exitCode=1});p.once('spawn',()=>{console.log(p.pid);p.unref()});";
    const result = await runFile(process.execPath, ["--permission", "--allow-child-process", "-e", launcher, path], {
      shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096, env: filteredEnvironment(), ...(signal ? { signal } : {}),
    });
    const pid = Number(result.stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("O lançador não retornou um processo válido.");
    return pid;
  },
  async activate(target, signal) {
    if (target !== "spotify:" && !(/^shell:AppsFolder\\/.test(target) && spotifyAumid.test(target.slice("shell:AppsFolder\\".length)))) throw new Error("Alvo de ativação não autorizado.");
    // Shell association is requested through a fixed program. Model arguments never
    // become PowerShell source, cmd.exe arguments, or a shell:true invocation.
    const result = await trustedPowerShell("$ErrorActionPreference='Stop'; Start-Process -FilePath $env:JARVIS_ACTIVATION_TARGET -ErrorAction Stop; Write-Output 'activated'", signal, target);
    if (result !== "activated") throw new Error("Windows não confirmou a solicitação de ativação.");
  },
};

export class AppNotLaunchableError extends Error {
  readonly code = "app_not_launchable";
  readonly details;
  constructor(app: string) {
    super(`Não foi possível iniciar o aplicativo ${app} pelas estratégias cadastradas.`);
    this.details = { app, launchMethod: null };
  }
}

export class ApplicationLauncher {
  constructor(private readonly platform: ApplicationPlatform = windowsPlatform) {}
  async open(name: string, signal?: AbortSignal): Promise<AppLaunchResult> {
    const app = applicationId(name);
    if (!app) throw new AppNotLaunchableError("não cadastrado");
    signal?.throwIfAborted();
    const path = this.platform.win32(app);
    if (path && isAbsolute(path) && !/[\\/]WindowsApps[\\/]/i.test(path)) {
      try {
        const pid = await this.platform.launchWin32(path, signal);
        return { app, launchMethod: "win32", pid, started: true, playbackControlled: false };
      } catch { signal?.throwIfAborted(); }
    }
    if (app === "spotify") {
      try {
        if (await this.platform.protocolRegistered(signal)) {
          await this.platform.activate("spotify:", signal);
          return { app, launchMethod: "protocol", activationRequested: true, started: true, playbackControlled: false };
        }
      } catch { signal?.throwIfAborted(); }
      try {
        const aumid = await this.platform.spotifyAumid(signal);
        if (aumid && spotifyAumid.test(aumid)) {
          await this.platform.activate("shell:AppsFolder\\" + aumid, signal);
          return { app, launchMethod: "aumid", activationRequested: true, started: true, playbackControlled: false };
        }
      } catch { signal?.throwIfAborted(); }
    }
    throw new AppNotLaunchableError(app);
  }
}
