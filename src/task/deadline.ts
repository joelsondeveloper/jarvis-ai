export class TaskTimeoutError extends Error {
  readonly code = "TASK_STAGE_TIMEOUT";
  constructor(readonly stage: string) { super(`Tempo limite atingido: ${stage}. Confira os resultados antes de tentar novamente.`); }
}

/** The continuation is outside the raced promise, so late results cannot advance a task. */
export async function withDeadline<T>(stage: string, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new TaskTimeoutError(stage);
          reject(error);
          controller.abort(error);
        }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
