import * as fs from "fs";
import * as path from "path";
import type { AppConfig } from "./types";

export const rootDir = path.resolve(__dirname, "../../..");

export type StoreMode = "demo" | "live";

export function storeMode(): StoreMode {
  const requested = (process.env.STORE_MODE ?? "auto").toLowerCase();
  if (requested === "demo") return "demo";
  if (requested === "live") return "live";
  return hasPlayCredentials() || hasAppleCredentials() ? "live" : "demo";
}

export function hasPlayCredentials(): boolean {
  return Boolean(process.env.PLAY_SERVICE_ACCOUNT_JSON?.trim());
}

export type PlayServiceAccount = {
  client_email: string;
  private_key: string;
};

export function playCredentials(): { keyFile: string } | { credentials: PlayServiceAccount } {
  const raw = process.env.PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) throw new Error("Defina PLAY_SERVICE_ACCOUNT_JSON com o JSON da conta de serviço.");
  if (!raw.startsWith("{")) return { keyFile: raw };
  return { credentials: parseServiceAccount(raw) };
}

function parseServiceAccount(raw: string): PlayServiceAccount {
  const candidates = raw.includes("\n") ? [raw, raw.replace(/\r?\n/g, "\\n")] : [raw];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) break;
      const account = parsed as { client_email?: unknown; private_key?: unknown };
      if (typeof account.client_email !== "string" || typeof account.private_key !== "string") {
        throw new Error("PLAY_SERVICE_ACCOUNT_JSON precisa ter client_email e private_key.");
      }
      return { ...(parsed as PlayServiceAccount), client_email: account.client_email, private_key: account.private_key };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PLAY_SERVICE_ACCOUNT_JSON")) throw error;
    }
  }
  throw new Error("PLAY_SERVICE_ACCOUNT_JSON não é um JSON válido da conta de serviço.");
}

const PEM_LABELS: Record<string, string> = {
  PRIVATEKEY: "PRIVATE KEY",
  ECPRIVATEKEY: "EC PRIVATE KEY",
  RSAPRIVATEKEY: "RSA PRIVATE KEY",
};

export function readPrivateKey(configured: string): string {
  if (configured.includes("BEGIN")) return normalizePrivateKey(configured);
  const keyPath = path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);
  return fs.readFileSync(keyPath, "utf8");
}

export function privateKeyFileName(configured: string): string | undefined {
  if (configured.includes("BEGIN")) return undefined;
  const keyPath = path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);
  return path.basename(keyPath);
}

function normalizePrivateKey(raw: string): string {
  const withNewlines = raw.replace(/\\n/g, "\n").trim();
  if (withNewlines.includes("\n")) {
    return withNewlines.endsWith("\n") ? withNewlines : `${withNewlines}\n`;
  }
  const stripped = withNewlines.replace(/\s+/g, "");
  const match = stripped.match(/^-----BEGIN([A-Z0-9]+?)-----([A-Za-z0-9+/=]+)-----END\1-----$/);
  const label = match ? PEM_LABELS[match[1]] : undefined;
  if (!match || !label) {
    throw new Error("ASC_PRIVATE_KEY precisa ser o conteúdo da chave .p8 ou o caminho do arquivo.");
  }
  const body = match[2].replace(/.{1,64}/g, "$&\n").trim();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function hasAppleCredentials(): boolean {
  return Boolean(
    process.env.ASC_ISSUER_ID?.trim() &&
      process.env.ASC_KEY_ID?.trim() &&
      process.env.ASC_PRIVATE_KEY?.trim(),
  );
}

export function reviewFraction(): number {
  const value = Number(process.env.PLAY_REVIEW_FRACTION ?? "0.01");
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error("PLAY_REVIEW_FRACTION precisa ser um número entre 0 e 1, por exemplo 0.01.");
  }
  return value;
}

export function notesLanguage(): string {
  return process.env.PLAY_NOTES_LANGUAGE?.trim() || "pt-BR";
}

export function playApiRoot(): string {
  return withoutTrailingSlash(
    process.env.PLAY_API_URL?.trim() ||
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications",
  );
}

export function playAuthScope(): string {
  return (
    process.env.PLAY_AUTH_SCOPE?.trim() || "https://www.googleapis.com/auth/androidpublisher"
  );
}

export function appStoreApiBase(): string {
  return withoutTrailingSlash(
    process.env.ASC_API_URL?.trim() || "https://api.appstoreconnect.apple.com",
  );
}

export function appStoreAudience(): string {
  return process.env.ASC_JWT_AUDIENCE?.trim() || "appstoreconnect-v1";
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function defaultReleaseNotes(): string {
  return process.env.DEFAULT_RELEASE_NOTES?.trim() || "Melhorias e correções.";
}

export function releaseNotesFor(app: AppConfig, typed?: string): string {
  const own = app.releaseNotes?.trim();
  const fallback = defaultReleaseNotes();
  const chosen = typed?.trim();
  if (chosen && chosen !== fallback) return chosen;
  return own || chosen || fallback;
}

export function androidTrack(app: AppConfig): string {
  return app.androidTrack?.trim() || "production";
}

function appsPath(): string {
  const configured = process.env.APPS_FILE?.trim() || path.join(rootDir, "config", "apps.json");
  return path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);
}

export function loadApps(): AppConfig[] {
  const file = appsPath();
  if (!fs.existsSync(file)) {
    const example = path.join(rootDir, "config", "apps.example.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(example, file);
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("apps" in parsed) || !Array.isArray(parsed.apps)) {
    throw new Error(`${file} precisa de um objeto com a lista apps.`);
  }

  const ids = new Set<string>();
  return parsed.apps.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`App na posição ${index} está inválido.`);
    }
    const app = entry as AppConfig;
    const id = app.id?.trim();
    const name = app.name?.trim();
    if (!id || !name) throw new Error(`App na posição ${index} precisa de id e name.`);
    if (ids.has(id)) throw new Error(`id repetido: ${id}`);
    ids.add(id);
    const androidPackage = app.androidPackage?.trim() || undefined;
    const iosAppId = app.iosAppId?.trim() || undefined;
    const project = typeof app.project === "string" ? app.project.trim() : "";
    if (!project) throw new Error(`${id} precisa de project, por exemplo WL ou ADS.`);
    if (!androidPackage && !iosAppId) {
      throw new Error(`${id} precisa de androidPackage ou iosAppId.`);
    }
    return {
      id,
      name,
      project,
      androidPackage,
      androidTrack: app.androidTrack?.trim() || undefined,
      iosAppId,
      releaseNotes: app.releaseNotes?.trim() || undefined,
    };
  });
}
