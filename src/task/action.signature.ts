import { createHash } from "node:crypto";
import { normalize } from "node:path";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export function actionSignature(tool: string, args: Record<string, unknown>): string {
  const normalized = { ...args };
  for (const key of ["path", "destinationPath"]) if (typeof normalized[key] === "string") {
    normalized[key] = normalize(normalized[key] as string);
    if (process.platform === "win32") normalized[key] = (normalized[key] as string).toLowerCase();
  }
  return createHash("sha256").update((tool === "list_files" ? "list_directory" : tool) + ":" + canonical(normalized)).digest("hex");
}
export function notepadRepeatCount(input: string): number {
  const match = /^\s*abra\s+(três|tres|dois|duas|quatro|cinco|seis|[2-6])\s+(?:blocos|blocinhos)\s+de\s+notas[.!]?\s*$/i.exec(input);
  if (!match) return 1;
  return ({ três: 3, tres: 3, dois: 2, duas: 2, quatro: 4, cinco: 5, seis: 6 } as Record<string, number>)[match[1]!.toLowerCase()] ?? Number(match[1]);
}
