import type { BoardApp, Cell, CellStatus, Platform } from "./types";

const LABELS: Record<CellStatus, string> = {
  indisponivel: "Não configurado",
  sem_build: "Sem build",
  pronta: "Pronta para revisão",
  em_revisao: "Em revisão",
  aprovada: "Aprovada",
  rejeitada: "Rejeitada",
  liberada: "No ar 100%",
  pausada: "Rollout pausado",
  erro: "Falhou a leitura",
};

export function cell(input: {
  platform: Platform;
  status: CellStatus;
  version?: string;
  detail?: string;
  label?: string;
  canPrepare?: boolean;
  canReview?: boolean;
  canRelease?: boolean;
  canHalt?: boolean;
  inRollout?: boolean;
  releaseUncertain?: boolean;
  needsConsolePublish?: boolean;
  consoleUrl?: string | null;
  lastError?: string | null;
  pendingVersion?: string | null;
  plannedFraction?: number | null;
}): Cell {
  return {
    platform: input.platform,
    status: input.status,
    label: input.label ?? LABELS[input.status],
    detail: input.detail ?? "",
    version: input.version && input.version.length > 0 ? input.version : "—",
    canPrepare: input.canPrepare ?? false,
    canReview: input.canReview ?? false,
    canRelease: input.canRelease ?? false,
    canHalt: input.canHalt ?? false,
    inRollout: input.inRollout ?? false,
    releaseUncertain: input.releaseUncertain ?? false,
    needsConsolePublish: input.needsConsolePublish ?? false,
    consoleUrl: input.consoleUrl ?? null,
    lastError: input.lastError ?? null,
    pendingVersion: input.pendingVersion ?? null,
    plannedFraction: input.plannedFraction ?? null,
  };
}

export function unavailable(platform: Platform, detail: string): Cell {
  return cell({ platform, status: "indisponivel", detail });
}

export function formatAppBuild(appVersion: string | null | undefined, buildId: string | null | undefined): string {
  const app = appVersion?.trim() ?? "";
  const build = buildId?.trim() ?? "";
  if (app && build && app !== build) {
    if (app.endsWith(`(${build})`)) return app;
    return `${app} (${build})`;
  }
  return app || build || "—";
}

/** Extrai o versionName (ex.: 6.5.2) de nomes vindos do Play. */
export function extractAndroidMarketingVersion(name: string | undefined, versionCode: number): string | null {
  const build = String(versionCode);
  let raw = name?.trim() ?? "";
  if (!raw || raw === build) return null;

  const codeFirst = raw.match(/^(\d+)\s*\((\d+\.\d+(?:\.\d+)*)\)$/);
  if (codeFirst && codeFirst[1] === build) return codeFirst[2];

  const versionFirst = raw.match(/^(\d+\.\d+(?:\.\d+)*)\s*\((\d+)\)$/);
  if (versionFirst && versionFirst[2] === build) return versionFirst[1];

  const wrappedCode = `(${build})`;
  if (raw.endsWith(wrappedCode)) {
    raw = raw.slice(0, raw.length - wrappedCode.length).trim();
  }
  if (/^\d+\.\d+(?:\.\d+)*$/.test(raw)) return raw;
  return raw && raw !== build ? raw : null;
}

/** Padrão Android: "versionCode (versionName)", ex.: "235423453 (6.5.2)". */
export function formatAndroidReleaseName(name: string | undefined, versionCode: number): string {
  const build = String(versionCode);
  const marketing = extractAndroidMarketingVersion(name, versionCode);
  return marketing ? `${build} (${marketing})` : build;
}

export function versionLabel(android: Cell, ios: Cell): string {
  const androidVersion = android.version !== "—" ? android.version : "";
  const iosVersion = ios.version !== "—" ? ios.version : "";
  if (androidVersion && iosVersion && androidVersion !== iosVersion) {
    return `Android ${androidVersion} · iOS ${iosVersion}`;
  }
  return androidVersion || iosVersion || "—";
}

export function noteFor(android: Cell, ios: Cell): string {
  const parts: string[] = [];
  for (const item of [android, ios]) {
    const store = item.platform === "android" ? "Android" : "iOS";
    if (item.lastError) {
      parts.push(`${store}: ${item.lastError}`);
      continue;
    }
    if (!item.detail || item.status === "indisponivel") continue;
    if (item.status === "liberada" && !item.canPrepare && !item.canReview) continue;
    parts.push(`${store}: ${item.detail}`);
  }
  return parts.join(" · ");
}

export function decorate(
  id: string,
  name: string,
  project: string,
  android: Cell,
  ios: Cell,
  refreshedAt: string | null,
): BoardApp {
  return {
    id,
    name,
    project,
    version: versionLabel(android, ios),
    android,
    ios,
    note: noteFor(android, ios),
    refreshedAt,
  };
}
