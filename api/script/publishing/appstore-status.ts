import { cell, formatAppBuild, unavailable } from "./cells";
import type { Cell } from "./types";

export type BuildState = "none" | "processing" | "valid" | "failed";

const IN_REVIEW = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "WAITING_FOR_EXPORT_COMPLIANCE"]);

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

const PHASE_PERCENT = [0, 1, 2, 5, 10, 20, 50, 100];

const IN_FLIGHT = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "PENDING_APPLE_RELEASE",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_REVIEW",
]);

const PREPARING = new Set(["PREPARE_FOR_SUBMISSION", "REJECTED", "METADATA_REJECTED", "DEVELOPER_REJECTED"]);

export type IosVersionCandidate = {
  id: string;
  versionString?: string | null;
  appStoreState?: string | null;
  releaseType?: string | null;
  phasedReleaseState?: string | null;
};

export function marketingVersion(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return /^\d+\.\d+/.test(text) ? text : null;
}

export function findPreparingDraft(
  versions: readonly IosVersionCandidate[],
  liveName: string | null,
): IosVersionCandidate | null {
  return (
    versions.find((item) => {
      if (!item.appStoreState || !PREPARING.has(item.appStoreState)) return false;
      const name = marketingVersion(item.versionString);
      if (!name) return false;
      if (liveName && compareVersions(name, liveName) <= 0) return false;
      return true;
    }) ?? null
  );
}

export function pickStoreVersion(versions: readonly IosVersionCandidate[]): IosVersionCandidate | null {
  const live = versions.find((item) => item.appStoreState === "READY_FOR_SALE");
  const liveName = marketingVersion(live?.versionString);
  const rolling = versions.find(
    (item) =>
      item.appStoreState === "READY_FOR_SALE" &&
      (item.phasedReleaseState === "ACTIVE" || item.phasedReleaseState === "PAUSED"),
  );
  const newerInFlight = versions.find((item) => {
    if (!item.appStoreState || !IN_FLIGHT.has(item.appStoreState)) return false;
    const name = marketingVersion(item.versionString);
    return Boolean(name && liveName && compareVersions(name, liveName) > 0);
  });
  if (newerInFlight) return newerInFlight;
  if (rolling) return rolling;

  const inFlight = versions.find(
    (item) => item.appStoreState && IN_FLIGHT.has(item.appStoreState) && marketingVersion(item.versionString),
  );
  if (inFlight) return inFlight;

  const preparing = findPreparingDraft(versions, liveName);
  if (preparing) return preparing;
  if (live) return live;
  return null;
}

export function phasedPercent(day: number | null): number | null {
  if (!day) return null;
  return PHASE_PERCENT[day] ?? null;
}

export function phasedLabel(day: number | null): string {
  const percent = phasedPercent(day);
  return percent ? `Faseado · ${percent}%` : "Faseado";
}

export function mapIosStatus(input: {
  configured: boolean;
  versionString: string | null;
  appVersion?: string | null;
  appStoreState: string | null;
  releaseType: string | null;
  buildVersion: string | null;
  buildState: BuildState;
  phasedReleaseState?: string | null;
  currentDayNumber?: number | null;
  liveVersionString?: string | null;
  pendingDraftVersion?: string | null;
  pendingDraftBuildState?: BuildState | null;
  pendingBuildLabel?: string | null;
}): Cell {
  if (!input.configured) return unavailable("ios", "Este app não tem iosAppId.");

  const version = iosVersion(input);
  const pending = pendingFlags(input);

  if (!input.appStoreState) {
    const pendingOnly = mapBuildOnly(input.buildVersion, input.buildState, input.appVersion ?? null);
    if (input.liveVersionString && input.buildState === "valid" && input.buildVersion) {
      return {
        ...pendingOnly,
        canPrepare: true,
        canReview: false,
        detail: `Build ${formatAppBuild(input.appVersion, input.buildVersion)} ainda não foi submetido. No ar: ${input.liveVersionString}. Use Preparar versão.`,
      };
    }
    if (input.buildState === "valid") {
      return { ...pendingOnly, canPrepare: true, canReview: false, detail: "Build pronto. Use Preparar versão." };
    }
    return pendingOnly;
  }

  if (input.appStoreState === "PROCESSING_FOR_DISTRIBUTION") {
    return cell({
      platform: "ios",
      status: "em_revisao",
      version,
      label: "Liberando",
      detail: appendPending("A Apple está disponibilizando a versão.", pending),
      canPrepare: pending.canPrepare,
      canReview: pending.canReview,
    });
  }

  if (input.appStoreState === "READY_FOR_SALE") {
    if (input.phasedReleaseState === "ACTIVE") {
      const percent = phasedPercent(input.currentDayNumber ?? null);
      const baseDetail = percent
        ? `Disponível para ${percent}% dos usuários. Liberar encerra o faseado e vai para 100%.`
        : "Liberar encerra o faseado e vai para 100%. Pausar interrompe.";
      return cell({
        platform: "ios",
        status: "aprovada",
        version,
        label: phasedLabel(input.currentDayNumber ?? null),
        canRelease: true,
        canHalt: true,
        inRollout: true,
        canPrepare: pending.canPrepare,
        canReview: pending.canReview,
        detail: appendPending(baseDetail, pending),
      });
    }
    if (input.phasedReleaseState === "PAUSED") {
      return cell({
        platform: "ios",
        status: "pausada",
        version,
        canRelease: true,
        canPrepare: pending.canPrepare,
        canReview: pending.canReview,
        detail: appendPending("Faseado pausado. Só entra em Liberar se o aplicativo estiver marcado.", pending),
      });
    }
    return cell({
      platform: "ios",
      status: "liberada",
      version,
      label: "No ar",
      canPrepare: pending.canPrepare,
      canReview: pending.canReview,
      detail: appendPending("", pending) || undefined,
    });
  }

  if (input.appStoreState === "PENDING_DEVELOPER_RELEASE") {
    return cell({
      platform: "ios",
      status: "aprovada",
      version,
      label: "Aprovada",
      canRelease: true,
      canPrepare: pending.canPrepare,
      canReview: pending.canReview,
      detail: appendPending("A Apple aprovou. Liberar começa o faseado de 7 dias.", pending),
    });
  }

  if (input.appStoreState === "PENDING_APPLE_RELEASE") {
    return cell({
      platform: "ios",
      status: "em_revisao",
      version,
      label: "Aguardando a Apple",
      canPrepare: pending.canPrepare,
      canReview: pending.canReview,
      detail: appendPending("A versão foi aprovada e a Apple ainda vai soltar.", pending),
    });
  }

  if (IN_REVIEW.has(input.appStoreState)) {
    const automatic = input.releaseType === "AFTER_APPROVAL";
    return cell({
      platform: "ios",
      status: "em_revisao",
      version,
      canPrepare: pending.canPrepare,
      canReview: pending.canReview,
      detail: appendPending(
        automatic
          ? "Na fila. Esta versão está marcada para sair sozinha quando a Apple aprovar."
          : "Na fila da Apple.",
        pending,
      ),
    });
  }

  if (input.appStoreState === "INVALID_BINARY") {
    return cell({
      platform: "ios",
      status: "erro",
      version,
      detail: "Binário inválido. O CI precisa enviar outro build.",
    });
  }

  if (
    input.appStoreState === "REJECTED" ||
    input.appStoreState === "METADATA_REJECTED" ||
    input.appStoreState === "DEVELOPER_REJECTED"
  ) {
    return cell({
      platform: "ios",
      status: "rejeitada",
      version,
      detail: "Rejeitada. O Enviar todos não inclui. Marque a linha para tentar de novo.",
    });
  }

  if (input.appStoreState === "PREPARE_FOR_SUBMISSION") {
    if (input.buildState === "processing") {
      return cell({
        platform: "ios",
        status: "sem_build",
        version,
        detail: "Build ainda processando na Apple.",
      });
    }
    if (input.buildState === "failed") {
      return cell({
        platform: "ios",
        status: "erro",
        version,
        detail: "O último build falhou no processamento.",
      });
    }
    if (input.buildState === "none") {
      return cell({
        platform: "ios",
        status: "sem_build",
        version,
        label: "Sem build selecionado",
        canPrepare: true,
        detail: "Rascunho sem build. Use Preparar versão para escolher o build do CI.",
      });
    }
    return cell({
      platform: "ios",
      status: "pronta",
      version,
      canReview: true,
      detail: "Versão pronta para enviar à revisão.",
    });
  }

  return cell({
    platform: "ios",
    status: "em_revisao",
    version,
    canPrepare: pending.canPrepare,
    canReview: pending.canReview,
    detail: appendPending(`Estado ${input.appStoreState} no App Store Connect.`, pending),
  });
}

function pendingFlags(input: {
  pendingDraftVersion?: string | null;
  pendingDraftBuildState?: BuildState | null;
  pendingBuildLabel?: string | null;
}): { canPrepare: boolean; canReview: boolean; note: string } {
  if (input.pendingDraftVersion) {
    const draftState = input.pendingDraftBuildState ?? "none";
    if (draftState === "valid") {
      return {
        canPrepare: false,
        canReview: true,
        note: `Rascunho ${input.pendingDraftVersion} pronto para revisão.`,
      };
    }
    if (draftState === "none" || draftState === "processing") {
      return {
        canPrepare: true,
        canReview: false,
        note: `Rascunho ${input.pendingDraftVersion} sem build selecionado. Use Preparar versão.`,
      };
    }
    return {
      canPrepare: false,
      canReview: false,
      note: `Rascunho ${input.pendingDraftVersion} com build inválido.`,
    };
  }
  if (input.pendingBuildLabel) {
    return {
      canPrepare: true,
      canReview: false,
      note: `Build ${input.pendingBuildLabel} disponível. Use Preparar versão.`,
    };
  }
  return { canPrepare: false, canReview: false, note: "" };
}

function appendPending(base: string, pending: { note: string }): string {
  if (!pending.note) return base;
  if (!base) return pending.note;
  return `${base} ${pending.note}`;
}

function iosVersion(input: {
  versionString: string | null;
  appVersion?: string | null;
  buildVersion: string | null;
}): string {
  const build = input.buildVersion?.trim() || null;
  const fromBuild = input.appVersion?.trim() || null;
  const fromStore = input.versionString && input.versionString !== build ? input.versionString.trim() : null;
  return formatAppBuild(fromBuild || fromStore, build);
}

function mapBuildOnly(buildVersion: string | null, buildState: BuildState, appVersion: string | null): Cell {
  const version = formatAppBuild(appVersion, buildVersion);
  if (buildState === "processing") {
    return cell({
      platform: "ios",
      status: "sem_build",
      version,
      detail: "Build ainda processando na Apple.",
    });
  }
  if (buildState === "failed") {
    return cell({
      platform: "ios",
      status: "erro",
      version,
      detail: "O último build falhou no processamento.",
    });
  }
  if (buildState === "valid") {
    return cell({
      platform: "ios",
      status: "pronta",
      version,
      canPrepare: true,
      detail: "Build pronto. Use Preparar versão.",
    });
  }
  return cell({
    platform: "ios",
    status: "sem_build",
    detail: "Nenhum build no App Store Connect.",
  });
}
