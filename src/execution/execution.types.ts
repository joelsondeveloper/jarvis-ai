export type ScriptLanguage =
  | "javascript"
  | "python"
  | "powershell";

export type ScriptExecutionRequest = {
  language: ScriptLanguage;
  code: string;
  coderMode?: "compute" | "script";
  input?: string;
  timeoutMs?: number;
  authorization?: import("../security/permission.manager.js").AuthorizationContext;
  approvedRequests?: import("../security/permission.manager.js").PermissionRequest[];

  allowedPaths?: {
    read?: string[];
    write?: string[];
  }
};

export type ScriptExecutionResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
};
