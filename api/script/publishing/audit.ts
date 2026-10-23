import * as fs from "fs";
import * as path from "path";
import { rootDir } from "./config";
import type { ActionResult } from "./types";

export type AuditEntry = {
  at: string;
  action: string;
  appId: string;
  appName: string;
  platform: string;
  ok: boolean;
  message: string;
};

function filePath(): string {
  return path.join(rootDir, "data", "audit.jsonl");
}

export function writeAudit(entry: AuditEntry): void {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function recordResult(action: string, result: ActionResult): void {
  writeAudit({
    at: new Date().toISOString(),
    action,
    appId: result.appId,
    appName: result.appName,
    platform: result.platform,
    ok: result.ok,
    message: result.message,
  });
}

export function readAudit(limit = 30): AuditEntry[] {
  const file = filePath();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .reverse()
    .map((line) => JSON.parse(line) as AuditEntry);
}
