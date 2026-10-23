import type { BoardApp, Cell, CellStatus, Platform } from "./types";

const LABELS: Record<CellStatus, string> = {
  indisponivel: "Não configurado",
  sem_build: "Sem build",
  pronta: "Pronta para revisão",
  em_revisao: "Em revisão",
  aprovada: "Aprovada",
  rejeitada: "Rejeitada",
  liberada: "No ar",
  pausada: "Rollout pausado",
  erro: "Falhou a leitura",
};

export function cell(input: {
  platform: Platform;
  status: CellStatus;
  version?: string;
  detail?: string;
  label?: string;
  canReview?: boolean;
  canRelease?: boolean;
  canHalt?: boolean;
  inRollout?: boolean;
  releaseUncertain?: boolean;
  lastError?: string | null;
}): Cell {
  return {
    platform: input.platform,
    status: input.status,
    label: input.label ?? LABELS[input.status],
    detail: input.detail ?? "",
    version: input.version && input.version.length > 0 ? input.version : "—",
    canReview: input.canReview ?? false,
    canRelease: input.canRelease ?? false,
    canHalt: input.canHalt ?? false,
    inRollout: input.inRollout ?? false,
    releaseUncertain: input.releaseUncertain ?? false,
    lastError: input.lastError ?? null,
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

export function formatAndroidReleaseName(name: string | undefined, versionCode: number): string {
  const build = String(versionCode);
  let raw = name?.trim() ?? "";
  if (!raw || raw === build) return build;
  const wrappedCode = `(${build})`;
  if (raw.endsWith(wrappedCode)) {
    raw = raw.slice(0, raw.length - wrappedCode.length).trim() || raw;
  }
  const swapped = raw.match(/^(\d+)\s*\((\d+\.\d+(?:\.\d+)*)\)$/);
  if (swapped && swapped[1] === build) return `${swapped[2]} (${build})`;
  if (/^\d+\.\d+(?:\.\d+)*$/.test(raw)) return `${raw} (${build})`;
  if (raw.endsWith(wrappedCode)) return raw;
  return formatAppBuild(raw, build);
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
    if (!item.detail || item.status === "liberada" || item.status === "indisponivel") continue;
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
