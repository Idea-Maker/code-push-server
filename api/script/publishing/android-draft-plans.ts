import * as fs from "fs";
import * as path from "path";
import { rootDir } from "./config";

export type AndroidDraftPlan = {
  fraction: number;
  notes: string;
};

const memory = new Map<string, AndroidDraftPlan>();
let loaded = false;

function filePath(): string {
  return path.join(rootDir, "data", "android-draft-plans.json");
}

function key(packageName: string, versionCode: number): string {
  return `${packageName}:${versionCode}`;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const file = filePath();
  if (!fs.existsSync(file)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, AndroidDraftPlan>;
    for (const [id, plan] of Object.entries(parsed)) {
      if (!plan || typeof plan.fraction !== "number" || typeof plan.notes !== "string") continue;
      memory.set(id, { fraction: plan.fraction, notes: plan.notes });
    }
  } catch {
    // Arquivo corrompido não impede o board; a preparação grava de novo.
  }
}

function persist(): void {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: Record<string, AndroidDraftPlan> = {};
  for (const [id, plan] of memory) body[id] = plan;
  fs.writeFileSync(file, JSON.stringify(body));
}

export function rememberAndroidDraft(packageName: string, versionCode: number, plan: AndroidDraftPlan): void {
  load();
  memory.set(key(packageName, versionCode), plan);
  persist();
}

export function readAndroidDraft(packageName: string, versionCode: number): AndroidDraftPlan | null {
  load();
  return memory.get(key(packageName, versionCode)) ?? null;
}

export function forgetAndroidDraft(packageName: string, versionCode: number): void {
  load();
  if (!memory.delete(key(packageName, versionCode))) return;
  persist();
}
