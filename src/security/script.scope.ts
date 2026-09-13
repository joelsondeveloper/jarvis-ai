import { applicationId } from "./authorization.js";
import type { CoderResult } from "../ai/qwen-coder.provider.js";

/** Whole-program templates only: never infer safety from a matching substring. */
export function scriptApplication(script: Pick<CoderResult, "language" | "code">): string | undefined {
  const code = script.code.trim();
  const match = script.language === "javascript"
    ? /^(?:console\.log\(\s*)?(?:jarvis\.openApp\(\s*["']([^"']+)["']\s*\)|require\(["'](?:node:)?child_process["']\)\.execFileSync\(\s*["']([^"']+)["']\s*,\s*\[\s*\]\s*\))\s*\)?\s*;?$/.exec(code)
    : script.language === "powershell"
      ? /^Start-Process\s+(?:-FilePath\s+)?["']?([a-zA-Z0-9.]+)["']?(?:\s+-PassThru)?(?:\s+-ErrorAction\s+Stop)?\s*;?$/i.exec(code)
      : /^import subprocess\s*\nsubprocess\.Popen\(\[["']([^"']+)["']\]\)\s*$/.exec(code);
  return match ? applicationId(match[1] ?? match[2] ?? "") : undefined;
}

export function scriptTermination(script: Pick<CoderResult, "language" | "code">): string | undefined {
  if (script.language !== "javascript") return undefined;
  const match = /^console\.log\(\s*jarvis\.closeApp\(\s*["']([^"']+)["']\s*\)\s*\)\s*;?$/.exec(script.code.trim());
  return match ? applicationId(match[1]!) : undefined;
}
