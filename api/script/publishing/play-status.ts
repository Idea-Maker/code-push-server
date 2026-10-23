import { cell, formatAndroidReleaseName, unavailable } from "./cells";
import type { Cell } from "./types";

export type RawRelease = {
  name?: string;
  versionCodes?: string[];
  status?: string;
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
  countryTargeting?: unknown;
  inAppUpdatePriority?: number;
};

export function mapAndroidStatus(input: {
  configured: boolean;
  latestVersionCode: number | null;
  releases: RawRelease[];
}): Cell {
  if (!input.configured) {
    return unavailable("android", "Este app não tem androidPackage.");
  }
  if (input.latestVersionCode === null) {
    return cell({
      platform: "android",
      status: "sem_build",
      detail: "Nenhum AAB encontrado no Play.",
    });
  }

  const latest = input.latestVersionCode;
  const match = input.releases.find((release) =>
    (release.versionCodes ?? []).some((code) => Number(code) === latest),
  );
  if (!match) {
    return cell({
      platform: "android",
      status: "pronta",
      version: String(latest),
      canReview: true,
      detail: "Bundle enviado pelo CI, ainda fora da faixa.",
    });
  }

  const version = formatAndroidReleaseName(match.name, latest);
  if (match.status === "draft") {
    return cell({
      platform: "android",
      status: "pronta",
      version,
      canReview: true,
      detail: "Release em rascunho.",
    });
  }
  if (match.status === "halted") {
    return cell({
      platform: "android",
      status: "pausada",
      version,
      canRelease: true,
      detail: "Pausado. Só entra em Liberar se o aplicativo estiver marcado.",
    });
  }
  if (match.status === "completed") {
    return cell({ platform: "android", status: "liberada", version, label: "No ar" });
  }
  if (match.status === "inProgress") {
    const fraction = match.userFraction ?? 0;
    const pct = formatPercent(fraction);
    const uncertain = fraction <= 0.02;
    return cell({
      platform: "android",
      status: "aprovada",
      version,
      label: uncertain ? `Rollout ${pct} · pode estar em revisão` : `Rollout ${pct}`,
      canRelease: fraction < 1,
      canHalt: true,
      inRollout: true,
      releaseUncertain: uncertain,
      detail: uncertain
        ? "Já está em rollout. Liberar aumenta a porcentagem. Se a Google ainda estiver revisando, esse aplicativo falha e os outros seguem."
        : "Já está em rollout. Liberar aumenta a porcentagem. A Play não deixa reduzir.",
    });
  }

  return cell({
    platform: "android",
    status: "pronta",
    version,
    canReview: true,
    detail: `Status ${match.status ?? "desconhecido"} no Play.`,
  });
}

export function withReviewRelease(
  releases: RawRelease[],
  latest: number,
  notes: string,
  fraction: number,
  language: string,
  replaceNotes = false,
): RawRelease[] {
  const code = String(latest);
  const note = [{ language, text: notes }];
  const rollout = fraction >= 1 ? { status: "completed" as const } : { status: "inProgress" as const, userFraction: fraction };
  const index = releases.findIndex((release) => (release.versionCodes ?? []).map(String).includes(code));
  if (index >= 0) {
    const current = releases[index];
    if (current.status === "completed") {
      throw new Error(`O versionCode ${code} já está em produção.`);
    }
    if (current.status === "inProgress") {
      throw new Error(`O versionCode ${code} já está em rollout. Use Liberar ou Pausar.`);
    }
    const next = releases.slice();
    const { userFraction, ...rest } = current;
    void userFraction;
    next[index] = {
      ...rest,
      ...rollout,
      releaseNotes: !replaceNotes && current.releaseNotes?.length ? current.releaseNotes : note,
    };
    return next;
  }

  const blocking = releases.find((release) => release.status === "inProgress" || release.status === "halted");
  if (blocking) {
    throw new Error("Já existe um rollout aberto nessa faixa. Pause ou conclua antes de enviar outra versão.");
  }

  return [
    {
      name: code,
      versionCodes: [code],
      ...rollout,
      releaseNotes: note,
    },
    ...releases,
  ];
}

export function withTargetFraction(releases: RawRelease[], fraction: number): RawRelease[] {
  if (fraction >= 1) return withCompletedRelease(releases);
  const index = releases.findIndex((release) => release.status === "inProgress" || release.status === "halted");
  if (index < 0) throw new Error("Não há rollout para atualizar. Envie para revisão antes.");
  const current = releases[index];
  const currentFraction = current.userFraction ?? 0;
  if (current.status === "inProgress" && fraction <= currentFraction) {
    throw new Error(
      `O rollout já está em ${formatPercent(currentFraction)}. A Play só aceita uma porcentagem maior.`,
    );
  }
  const next = releases.slice();
  next[index] = { ...current, status: "inProgress", userFraction: fraction };
  return next;
}

export function withCompletedRelease(releases: RawRelease[]): RawRelease[] {
  const index = releases.findIndex((release) => release.status === "inProgress" || release.status === "halted");
  if (index < 0) throw new Error("Não há rollout para liberar. Envie para revisão antes.");
  const next = releases.slice();
  const { userFraction, ...rest } = releases[index];
  void userFraction;
  next[index] = { ...rest, status: "completed" };
  return next;
}

export function withHaltedRelease(releases: RawRelease[]): RawRelease[] {
  const index = releases.findIndex((release) => release.status === "inProgress");
  if (index < 0) throw new Error("Não há rollout em andamento para pausar.");
  const next = releases.slice();
  next[index] = { ...releases[index], status: "halted" };
  return next;
}

export function latestVersionCode(codes: readonly (number | undefined)[]): number | null {
  const present = codes.filter((code): code is number => typeof code === "number");
  if (present.length === 0) return null;
  return Math.max(...present);
}

export function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}
