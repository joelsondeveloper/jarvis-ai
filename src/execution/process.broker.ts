import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { applicationId } from "../security/authorization.js";

export function filteredEnvironment(): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "",
    APPDATA: process.env.APPDATA ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "", USERPROFILE: process.env.USERPROFILE ?? "" };
}

export function resolveApplication(name: string): string {
  const id = applicationId(name);
  const candidates = id === "notepad"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe")]
    : id === "spotify" ? [
      process.env.APPDATA && join(process.env.APPDATA, "Spotify", "Spotify.exe"),
      process.env.ProgramFiles && join(process.env.ProgramFiles, "Spotify", "Spotify.exe"),
    ] : [];
  const path = candidates.find((candidate): candidate is string => Boolean(candidate && isAbsolute(candidate) && existsSync(candidate)));
  if (!path) throw new Error("Aplicativo não instalado ou não localizável: " + name);
  const resolved = realpathSync(path);
  if (/[\\/]WindowsApps[\\/]/i.test(resolved)) throw new Error("Aplicativo empacotado requer ativação pelo Windows.");
  return resolved;
}

// Only trusted launcher code runs in Node. Generated code never gets the unrestricted
// child_process module: Node 22's permission flag alone cannot constrain its targets.
const LAUNCHER = `const {spawn}=require('node:child_process');
const spec=JSON.parse(process.argv[1]);
const child=spawn(spec.command,spec.args,{shell:false,detached:true,stdio:'ignore',windowsHide:false,env:process.env});
child.once('error',e=>{console.error(e.message);process.exitCode=1});
child.once('spawn',()=>{console.log(JSON.stringify({pid:child.pid,started:true,playbackControlled:false}));child.unref()});`;

export function launchProcess(command: string, args: string[], timeoutMs: number): string {
  if (!isAbsolute(command)) throw new Error("Executável deve ter caminho absoluto.");
  return execFileSync(process.execPath, ["--permission", "--allow-child-process", "-e", LAUNCHER, JSON.stringify({ command, args })], {
    shell: false, windowsHide: true, timeout: Math.min(timeoutMs, 10000), maxBuffer: 16000,
    encoding: "utf8", env: filteredEnvironment(),
  });
}

/** Fixed, allowlisted process termination used only by the validated closeApp bridge. */
export function terminateApplication(name: string, timeoutMs: number): string {
  const app = applicationId(name);
  const image = app === "spotify" ? "Spotify.exe" : app === "notepad" ? "notepad.exe" : undefined;
  if (!image) throw new Error("Aplicativo não autorizado para encerramento.");
  // Match the exact allowlisted image. Do not recurse into a process tree: a
  // child may belong to another component and is outside the user's request.
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  const output = execFileSync(taskkill, ["/IM", image, "/F"], {
    shell: false, windowsHide: true, timeout: Math.min(timeoutMs, 10000), maxBuffer: 8192, encoding: "utf8", env: filteredEnvironment(),
  });
  return JSON.stringify({ app, image, terminated: true, output: output.trim().slice(0, 2000) });
}
