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

/** Resumo do endpoint applications.tracks.releases (lifecycle real da Console). */
export type ReleaseSummary = {
  releaseName?: string;
  track?: string;
  activeArtifacts?: { versionCode?: number }[];
  releaseLifecycleState?: string;
};

export function findLifecycleState(
  summaries: readonly ReleaseSummary[],
  versionCode: number,
): string | undefined {
  const match = summaries.find((summary) =>
    (summary.activeArtifacts ?? []).some((artifact) => Number(artifact.versionCode) === versionCode),
  );
  return match?.releaseLifecycleState;
}

/** Prefere um name com versionName (ex.: "6.5.2" ou "235423453 (6.5.2)") em vez do versionCode puro. */
export function pickRicherAndroidReleaseName(
  versionCode: number,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  const build = String(versionCode);
  const names = candidates
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (names.length === 0) return undefined;
  const withMarketing = names.find((name) => name !== build && /\d+\.\d+/.test(name));
  if (withMarketing) return withMarketing;
  return names.find((name) => name !== build) ?? names[0];
}

export function findAndroidReleaseName(
  releases: readonly RawRelease[],
  versionCode: number,
): string | undefined {
  const matches = releases.filter((release) =>
    (release.versionCodes ?? []).some((code) => Number(code) === versionCode),
  );
  return pickRicherAndroidReleaseName(versionCode, ...matches.map((release) => release.name));
}

export function releaseVersionCode(release: RawRelease): number | null {
  const codes = (release.versionCodes ?? [])
    .map((code) => Number(code))
    .filter((code) => Number.isFinite(code));
  if (codes.length === 0) return null;
  return Math.max(...codes);
}

const ACTIONABLE_LIFECYCLE = new Set([
  "RELEASE_LIFECYCLE_STATE_DRAFT",
  "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW",
  "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
  "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED",
  "RELEASE_LIFECYCLE_STATE_NOT_APPROVED",
]);

/**
 * Versão que o board pode preparar ou revisar.
 * A biblioteca de AABs guarda código antigo para sempre. Só entra aqui release
 * que a faixa ou o lifecycle da Play ainda mostram (rascunho, revisão, etc.).
 */
export function versionCodeForBoard(
  bundleCodes: readonly (number | undefined)[],
  releases: readonly RawRelease[],
  lifecycleSummaries: readonly ReleaseSummary[] = [],
): number | null {
  const uploaded = bundleCodes.filter((code): code is number => typeof code === "number" && Number.isFinite(code));
  const actionable: number[] = [];

  for (const release of releases) {
    if (release.status !== "draft") continue;
    const code = releaseVersionCode(release);
    if (code !== null) actionable.push(code);
  }

  for (const summary of lifecycleSummaries) {
    if (!summary.releaseLifecycleState || !ACTIONABLE_LIFECYCLE.has(summary.releaseLifecycleState)) continue;
    for (const artifact of summary.activeArtifacts ?? []) {
      if (typeof artifact.versionCode === "number" && Number.isFinite(artifact.versionCode)) {
        actionable.push(artifact.versionCode);
      }
    }
  }

  if (actionable.length > 0) return Math.max(...actionable);

  const open = releases.find((release) => release.status === "inProgress" || release.status === "halted");
  const openCode = open ? releaseVersionCode(open) : null;
  if (openCode !== null) return openCode;

  const completed = releases
    .map((release) => (release.status === "completed" ? releaseVersionCode(release) : null))
    .filter((code): code is number => code !== null);
  if (completed.length > 0) return Math.max(...completed);

  return uploaded.length > 0 ? Math.max(...uploaded) : null;
}

/**
 * Com uma release mais nova na faixa, o rollout/halt da versão anterior continua
 * sendo o status do board. Essa release nova vira etapa de preparação.
 */
export function pickAndroidFocus(releases: readonly RawRelease[], latest: number): RawRelease | undefined {
  const open = releases.find((release) => release.status === "inProgress" || release.status === "halted");
  const openCode = open ? releaseVersionCode(open) : null;
  if (open && openCode !== null && openCode !== latest) return open;

  const onLatest = releases.find((release) =>
    (release.versionCodes ?? []).some((code) => Number(code) === latest),
  );
  if (onLatest) return onLatest;
  if (open) return open;

  return releases
    .filter((release) => release.status === "completed")
    .reduce<RawRelease | undefined>((best, release) => {
      if (!best) return release;
      return (releaseVersionCode(release) ?? -1) > (releaseVersionCode(best) ?? -1) ? release : best;
    }, undefined);
}

function pendingBundleLabel(latest: number, releaseName?: string | null): string {
  return formatAndroidReleaseName(pickRicherAndroidReleaseName(latest, releaseName), latest);
}

function describeAndroidPending(
  releases: readonly RawRelease[],
  latest: number,
  focusCode: number,
  releaseName?: string | null,
): { canPrepare: boolean; canReview: boolean; note: string; pendingVersion: string | null } {
  if (latest <= focusCode) return { canPrepare: false, canReview: false, note: "", pendingVersion: null };
  const label = pendingBundleLabel(latest, releaseName);
  const pending = releases.find((release) =>
    (release.versionCodes ?? []).some((code) => Number(code) === latest),
  );
  const blocking = releases.some((release) => {
    if (release.status !== "inProgress" && release.status !== "halted") return false;
    return releaseVersionCode(release) !== latest;
  });
  if (pending?.status === "draft") {
    if (blocking) {
      return {
        canPrepare: false,
        canReview: false,
        pendingVersion: label,
        note: `Rascunho ${label} criado. Enviar para revisão fica disponível quando o rollout atual for concluído. O rollout segue disponível.`,
      };
    }
    return {
      canPrepare: false,
      canReview: true,
      pendingVersion: label,
      note: `Rascunho ${label} pronto para revisão.`,
    };
  }
  if (pending) return { canPrepare: false, canReview: false, note: "", pendingVersion: label };
  return {
    canPrepare: true,
    canReview: false,
    pendingVersion: label,
    note: blocking
      ? `Bundle ${label} disponível. Use Preparar para definir a porcentagem e as notas, sem alterar o rollout.`
      : `Bundle ${label} disponível. Use Preparar para definir a porcentagem e as notas.`,
  };
}

export function mapAndroidStatus(input: {
  configured: boolean;
  latestVersionCode: number | null;
  releases: RawRelease[];
  /** Nome de release encontrado em qualquer faixa (ex.: internal) para o versionCode. */
  releaseName?: string | null;
  /** Lifecycle da Console (Pronto para publicar, Em revisão, etc.). */
  lifecycleSummaries?: readonly ReleaseSummary[];
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
  const focus = pickAndroidFocus(input.releases, latest);
  if (!focus) {
    return cell({
      platform: "android",
      status: "pronta",
      version: pendingBundleLabel(latest, input.releaseName),
      pendingVersion: pendingBundleLabel(latest, input.releaseName),
      canPrepare: true,
      detail: "Bundle enviado pelo CI, ainda fora da faixa. Use Preparar para definir a porcentagem e as notas.",
    });
  }

  const focusCode = releaseVersionCode(focus) ?? latest;
  const match = focus;
  const releaseName = pickRicherAndroidReleaseName(
    focusCode,
    match.name,
    focusCode === latest ? input.releaseName : undefined,
  );
  const version = formatAndroidReleaseName(releaseName, focusCode);
  const lifecycle = findLifecycleState(input.lifecycleSummaries ?? [], focusCode);
  const pending = describeAndroidPending(input.releases, latest, focusCode, input.releaseName);

  const finish = (mapped: Cell): Cell => {
    if (!pending.note && !pending.canPrepare && !pending.canReview && !pending.pendingVersion) return mapped;
    const detail = [mapped.detail, pending.note].filter((part) => part.trim()).join(" ");
    return cell({
      ...mapped,
      canPrepare: mapped.canPrepare || pending.canPrepare,
      canReview: mapped.canReview || pending.canReview,
      pendingVersion: pending.pendingVersion,
      detail,
    });
  };

  if (lifecycle === "RELEASE_LIFECYCLE_STATE_IN_REVIEW") {
    return finish(
      cell({
        platform: "android",
        status: "em_revisao",
        version,
        label: "Em revisão",
        releaseUncertain: true,
        detail: "Em revisão na Google. Ainda não está disponível para os usuários.",
      }),
    );
  }
  if (lifecycle === "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED") {
    const pendingFraction = match.userFraction;
    const pct =
      typeof pendingFraction === "number" && pendingFraction > 0 && pendingFraction < 1
        ? formatPercent(pendingFraction)
        : null;
    return finish(
      cell({
        platform: "android",
        status: "aprovada",
        version,
        label: "Pronto para publicar",
        needsConsolePublish: true,
        detail: pct
          ? `Aprovado (${pct}). Publicação Gerenciada ativo: publique na Play Console — a API não tem essa etapa. Depois use Aumentar rollout.`
          : "Aprovado. Publicação Gerenciada ativo: publique na Play Console — a API não tem essa etapa. Depois use Aumentar rollout.",
      }),
    );
  }
  if (lifecycle === "RELEASE_LIFECYCLE_STATE_NOT_APPROVED") {
    return finish(
      cell({
        platform: "android",
        status: "rejeitada",
        version,
        detail: "Rejeitada pela Google. O Enviar todos não inclui. Marque a linha para tentar de novo.",
      }),
    );
  }
  if (
    lifecycle === "RELEASE_LIFECYCLE_STATE_DRAFT" ||
    lifecycle === "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW"
  ) {
    return finish(
      cell({
        platform: "android",
        status: "pronta",
        version,
        canReview: true,
        detail:
          lifecycle === "RELEASE_LIFECYCLE_STATE_DRAFT"
            ? "Release em rascunho."
            : "Pronta para enviar à análise da Google.",
      }),
    );
  }

  if (match.status === "draft") {
    return finish(
      cell({
        platform: "android",
        status: "pronta",
        version,
        canReview: true,
        detail: "Release em rascunho.",
      }),
    );
  }
  if (match.status === "halted") {
    return finish(
      cell({
        platform: "android",
        status: "pausada",
        version,
        canRelease: true,
        detail: "Pausado. Só entra em Liberar se o aplicativo estiver marcado.",
      }),
    );
  }
  if (match.status === "completed") {
    return finish(cell({ platform: "android", status: "liberada", version, label: "No ar 100%" }));
  }
  if (match.status === "inProgress") {
    const fraction = match.userFraction ?? 0;
    const pct = formatPercent(fraction);
    // Só é rollout real quando a Play marca PUBLISHED. Antes disso (Pronto para publicar /
    // análise / lifecycle ausente) Liberar deve iniciar a % já definida — não completar 100%.
    if (lifecycle === "RELEASE_LIFECYCLE_STATE_PUBLISHED") {
      return finish(
        cell({
          platform: "android",
          status: "aprovada",
          version,
          label: `Rollout ${pct}`,
          canRelease: fraction < 1,
          canHalt: true,
          inRollout: true,
          detail: "Já está em rollout. Use Aumentar rollout para subir a %. A Play não deixa reduzir.",
        }),
      );
    }
    const underReview = fraction <= 0.02 || lifecycle === "RELEASE_LIFECYCLE_STATE_IN_REVIEW";
    if (underReview) {
      return finish(
        cell({
          platform: "android",
          status: "em_revisao",
          version,
          label: "Em revisão",
          releaseUncertain: true,
          detail: "Em revisão na Google. Ainda não está disponível para os usuários.",
        }),
      );
    }
    return finish(
      cell({
        platform: "android",
        status: "aprovada",
        version,
        label: "Pronto para publicar",
        needsConsolePublish: true,
        detail:
          fraction > 0 && fraction < 1
            ? `Aprovado (${pct}). Publicação Gerenciada ativo: publique na Play Console — a API não tem essa etapa. Depois use Aumentar rollout.`
            : "Aprovado. Publicação Gerenciada ativo: publique na Play Console — a API não tem essa etapa. Depois use Aumentar rollout.",
      }),
    );
  }

  return finish(
    cell({
      platform: "android",
      status: "pronta",
      version,
      canReview: true,
      detail: `Status ${match.status ?? "desconhecido"} no Play.`,
    }),
  );
}

export function withReviewRelease(
  releases: RawRelease[],
  latest: number,
  notes: string,
  fraction: number,
  language: string,
  replaceNotes = false,
  releaseName?: string | null,
): RawRelease[] {
  const code = String(latest);
  const name = formatAndroidReleaseName(pickRicherAndroidReleaseName(latest, releaseName), latest);
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
    const blockingOther = releases.find(
      (release, position) =>
        position !== index && (release.status === "inProgress" || release.status === "halted"),
    );
    if (blockingOther) {
      throw new Error("Já existe um rollout aberto nessa faixa. Pause ou conclua antes de enviar outra versão.");
    }
    const { userFraction, ...rest } = current;
    void userFraction;
    const richerName = pickRicherAndroidReleaseName(latest, current.name, releaseName);
    const updated = {
      ...rest,
      ...rollout,
      name: formatAndroidReleaseName(richerName ?? current.name, latest),
      releaseNotes: !replaceNotes && current.releaseNotes?.length ? current.releaseNotes : note,
    };
    // 100%: só uma completed por faixa. Staged: mantém a completed anterior como fallback.
    const others = releases.filter(
      (release, i) => i !== index && (fraction < 1 || release.status !== "completed"),
    );
    return [updated, ...others];
  }

  const blocking = releases.find((release) => release.status === "inProgress" || release.status === "halted");
  if (blocking) {
    throw new Error("Já existe um rollout aberto nessa faixa. Pause ou conclua antes de enviar outra versão.");
  }

  const created = {
    name,
    versionCodes: [code],
    ...rollout,
    releaseNotes: note,
  };
  const others =
    fraction >= 1 ? releases.filter((release) => release.status !== "completed") : releases;
  return [created, ...others];
}

/** Cria o rascunho do bundle novo sem alterar o rollout já aberto na faixa. */
export function withDraftRelease(
  releases: RawRelease[],
  latest: number,
  notes: string,
  language: string,
  releaseName?: string | null,
): RawRelease[] {
  const code = String(latest);
  const existing = releases.find((release) => (release.versionCodes ?? []).map(String).includes(code));
  if (existing) {
    if (existing.status === "draft") {
      throw new Error(`O versionCode ${code} já está em rascunho.`);
    }
    throw new Error(`O versionCode ${code} já está na faixa (${existing.status}).`);
  }
  const otherDraft = releases.find((release) => release.status === "draft");
  if (otherDraft) {
    throw new Error("Já existe um rascunho nessa faixa. Envie ou descarte antes de preparar outra versão.");
  }
  const name = formatAndroidReleaseName(pickRicherAndroidReleaseName(latest, releaseName), latest);
  return [
    {
      name,
      versionCodes: [code],
      status: "draft",
      releaseNotes: [{ language, text: notes }],
    },
    ...releases,
  ];
}

/** Só é rollout real quando a Play marca a release como PUBLISHED. */
export function isAndroidRolloutLive(
  releases: readonly RawRelease[],
  latest: number | null,
  lifecycleSummaries: readonly ReleaseSummary[] = [],
): boolean {
  const open = releases.find((release) => release.status === "inProgress" || release.status === "halted");
  const code = open ? releaseVersionCode(open) : latest;
  if (code === null) return false;
  const lifecycle = findLifecycleState(lifecycleSummaries, code);
  if (lifecycle !== "RELEASE_LIFECYCLE_STATE_PUBLISHED") return false;
  const match =
    open ??
    releases.find((release) => (release.versionCodes ?? []).some((item) => Number(item) === code));
  return Boolean(match && (match.status === "inProgress" || match.status === "halted"));
}

/**
 * Primeira publicação / iniciar lançamento gradual: usa a % já definida na revisão.
 * Não completa 100% só porque o front mandou fraction=1.
 */
export function withPublishExistingFraction(
  releases: RawRelease[],
): { releases: RawRelease[]; fraction: number } {
  const index = releases.findIndex(
    (release) =>
      release.status === "inProgress" || release.status === "halted" || release.status === "draft",
  );
  if (index < 0) {
    throw new Error(
      "Não há release para publicar. Envie para revisão antes. Se estiver Pronto para publicar com Publicação Gerenciada, a API da Play não publica sozinha — use a Console ou desligue o Publicação Gerenciada.",
    );
  }
  const current = releases[index];
  const staged = typeof current.userFraction === "number" ? current.userFraction : null;

  // Nunca inventar 100%. Só publica a % que veio da revisão (staged rollout).
  if (staged === null || !(staged > 0 && staged < 1)) {
    throw new Error(
      "Esta release não tem porcentagem de lançamento gradual definida (ex.: 10%). " +
        "Liberar não publica 100% sozinho — defina a % no envio para revisão ou use Aumentar rollout só depois de publicado.",
    );
  }

  // Já inProgress na mesma %: Edits não dispara o "Publicar" do Publicação Gerenciada.
  if (current.status === "inProgress" && (current.userFraction ?? 0) === staged) {
    throw new Error(
      `A release já está configurada em ${formatPercent(staged)}, mas ainda não chegou aos usuários. ` +
        "Se a Console mostra «Iniciar o lançamento gradual», publique por lá (Publicação Gerenciada) ou desligue o Publicação Gerenciada — a API não tem esse botão.",
    );
  }

  // draft/halted → inProgress: inicia o lançamento gradual na % da revisão (ex.: 10%).
  const next = releases.slice();
  next[index] = { ...current, status: "inProgress", userFraction: staged };
  return { releases: next, fraction: staged };
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
  const { userFraction, ...rest } = releases[index];
  void userFraction;
  // A Play só aceita uma release completed por faixa: a nova substitui a anterior.
  return [
    { ...rest, status: "completed" },
    ...releases.filter((release, i) => i !== index && release.status !== "completed"),
  ];
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
