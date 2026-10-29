import { cell, decorate, unavailable } from "./cells";
import { formatPercent } from "./play-status";
import type {
  ActionName,
  AppConfig,
  BoardApp,
  Cell,
  IosPrepareChoice,
  IosPrepareOptions,
  Platform,
} from "./types";

const VERSION = "4.2.0 (210)";

function base(platform: Platform, status: Cell["status"], extra: Partial<Cell> = {}): Cell {
  return cell({ platform, version: VERSION, status, ...extra });
}

function initialCell(id: string, platform: Platform, configured: boolean): Cell {
  if (!configured) return unavailable(platform, platform === "android" ? "Este app não tem androidPackage." : "Este app não tem iosAppId.");
  const special = SPECIAL[id]?.[platform];
  if (special) return special();
  if (platform === "ios") {
    return base(platform, "pronta", { canPrepare: true, detail: "Build do CI disponível. Use Preparar versão." });
  }
  return base(platform, "pronta", { canReview: true, detail: "Build do CI disponível." });
}

const SPECIAL: Record<string, Partial<Record<Platform, () => Cell>>> = {
  "nome-01": {
    android: () => base("android", "pronta", { canReview: true, detail: "Bundle enviado, ainda fora da faixa." }),
    ios: () => base("ios", "pronta", { canReview: true, detail: "Versão pronta para enviar à revisão." }),
  },
  "nome-02": {
    android: () => base("android", "pronta", { canReview: true, detail: "Release em rascunho." }),
    ios: () => base("ios", "em_revisao", { detail: "Na fila da Apple." }),
  },
  "nome-03": {
    android: () =>
      base("android", "aprovada", {
        label: "Rollout 1% · pode estar em revisão",
        canRelease: true,
        canHalt: true,
        releaseUncertain: true,
        detail: "Liberar sobe para 100%. Se a Google ainda estiver revisando, este aplicativo falha e os outros seguem.",
      }),
    ios: () => base("ios", "em_revisao", { detail: "Na fila da Apple." }),
  },
  "nome-04": {
    android: () =>
      base("android", "aprovada", {
        label: "Rollout 20%",
        canRelease: true,
        canHalt: true,
        detail: "Liberar sobe o rollout para 100%.",
      }),
    ios: () =>
      base("ios", "aprovada", {
        label: "Aprovada",
        canRelease: true,
        detail: "A Apple aprovou. Liberar publica para o usuário.",
      }),
  },
  "nome-05": {
    android: () =>
      base("android", "aprovada", {
        label: "Rollout 20%",
        canRelease: true,
        canHalt: true,
        detail: "Liberar sobe o rollout para 100%.",
      }),
    ios: () => base("ios", "em_revisao", { detail: "Na fila da Apple." }),
  },
  "nome-06": {
    android: () => base("android", "rejeitada", { detail: "Rejeitada. O Enviar todos não inclui. Marque a linha para tentar de novo." }),
    ios: () =>
      base("ios", "aprovada", {
        label: "Aprovada",
        canRelease: true,
        detail: "A Apple aprovou. Liberar publica para o usuário.",
      }),
  },
  "nome-07": {
    android: () => base("android", "liberada", { label: "No ar" }),
    ios: () =>
      base("ios", "liberada", {
        label: "No ar",
        canPrepare: true,
        detail: "Build 4.3.0 (220) disponível. Use Preparar versão.",
      }),
  },
  "nome-08": {
    android: () => base("android", "sem_build", { version: "—", detail: "CI não gerou este aplicativo neste ciclo." }),
    ios: () => base("ios", "sem_build", { version: "—", detail: "CI não gerou este aplicativo neste ciclo." }),
  },
  "nome-09": {
    android: () => base("android", "pronta", { canReview: true, detail: "Release em rascunho." }),
    ios: () => base("ios", "rejeitada", { detail: "Rejeitada. O Enviar todos não inclui. Marque a linha para tentar de novo." }),
  },
  "nome-10": {
    android: () =>
      base("android", "pronta", {
        canReview: true,
        detail: "Bundle enviado, ainda fora da faixa.",
        lastError: "O envio anterior falhou: notas de versão ausentes.",
      }),
    ios: () => base("ios", "pronta", { canReview: true, detail: "Versão pronta para enviar à revisão." }),
  },
  "nome-11": {
    android: () =>
      base("android", "aprovada", {
        version: "4.1.0 (198)",
        label: "Rollout 20%",
        canRelease: true,
        canHalt: true,
        detail: "Liberar sobe o rollout para 100%.",
      }),
    ios: () => base("ios", "sem_build", { version: "—", detail: "Build ainda processando na Apple." }),
  },
  "nome-12": {
    android: () => base("android", "em_revisao", { detail: "Na fila da Google, fora do rollout." }),
    ios: () =>
      base("ios", "aprovada", {
        label: "Aprovada",
        canRelease: true,
        detail: "A Apple aprovou. Liberar publica para o usuário.",
      }),
  },
};

const overrides = new Map<string, Partial<Record<Platform, Cell>>>();

export function resetDemo(): void {
  overrides.clear();
}

export function demoApps(configs: readonly AppConfig[]): BoardApp[] {
  const refreshedAt = new Date().toISOString();
  return configs.map((config) => {
    const saved = overrides.get(config.id);
    const android = saved?.android ?? initialCell(config.id, "android", Boolean(config.androidPackage));
    const ios = saved?.ios ?? initialCell(config.id, "ios", Boolean(config.iosAppId));
    return decorate(config.id, config.name, config.project, android, ios, refreshedAt);
  });
}

export function stampDemoError(app: BoardApp, platform: Platform, message: string): void {
  const saved = overrides.get(app.id) ?? {};
  saved[platform] = cell({ ...app[platform], lastError: message });
  overrides.set(app.id, saved);
}

export function demoPrepareOptions(app: AppConfig): IosPrepareOptions {
  return {
    appId: app.id,
    appName: app.name,
    liveVersion: "4.1.0",
    draftVersion: null,
    suggestedVersion: "4.2.0",
    suggestedBuildId: "demo-build-210",
    builds: [
      {
        id: "demo-build-210",
        buildNumber: "210",
        marketingVersion: "4.2.0",
        processingState: "VALID",
        label: "4.2.0 (210)",
      },
      {
        id: "demo-build-209",
        buildNumber: "209",
        marketingVersion: "4.2.0",
        processingState: "VALID",
        label: "4.2.0 (209)",
      },
      {
        id: "demo-build-198",
        buildNumber: "198",
        marketingVersion: "4.1.0",
        processingState: "VALID",
        label: "4.1.0 (198)",
      },
    ],
  };
}

export function applyDemo(
  app: BoardApp,
  platform: Platform,
  action: ActionName,
  fraction = 0.01,
  prepareChoice?: IosPrepareChoice,
): string {
  const current = app[platform];
  if (action === "prepare" && platform !== "ios") {
    throw new Error("Preparar versão só existe no iOS.");
  }
  const next = nextCell(current, action, fraction, prepareChoice);
  const saved = overrides.get(app.id) ?? {};
  saved[platform] = next;
  overrides.set(app.id, saved);
  if (action === "prepare") {
    const version = prepareChoice?.versionString?.trim() || (current.version === "—" ? "4.2.0" : current.version);
    return `Rascunho ${version} criado com build ${prepareChoice?.buildId ?? "demo"}.`;
  }
  if (action === "review") {
    return platform === "android"
      ? `Enviado para revisão em rollout de ${formatPercent(fraction)}.`
      : "Enviado para revisão.";
  }
  if (action === "halt") return platform === "ios" ? "Lançamento faseado pausado." : "Rollout pausado.";
  if (platform === "ios") {
    if (current.status === "pausada") return "Lançamento faseado retomado.";
    if (current.inRollout) return "Liberada para 100% dos usuários.";
    return "Liberado em lançamento faseado de 7 dias.";
  }
  return fraction < 1 ? `Rollout atualizado para ${formatPercent(fraction)}.` : "Liberado para o usuário.";
}

function nextCell(
  current: Cell,
  action: ActionName,
  fraction: number,
  prepareChoice?: IosPrepareChoice,
): Cell {
  if (action === "prepare") {
    const version = prepareChoice?.versionString?.trim()
      ? `${prepareChoice.versionString.trim()} (${prepareChoice.buildId.replace(/^demo-build-/, "") || "210"})`
      : current.version === "—"
        ? VERSION
        : current.version;
    return cell({
      platform: "ios",
      status: "pronta",
      version,
      canReview: true,
      detail: "Versão pronta para enviar à revisão.",
    });
  }
  if (action === "review") {
    const android = current.platform === "android";
    const uncertain = fraction <= 0.02;
    return cell({
      platform: current.platform,
      status: android ? "aprovada" : "em_revisao",
      version: current.version,
      label: android
        ? `Rollout ${formatPercent(fraction)}${uncertain ? " · pode estar em revisão" : ""}`
        : "Em revisão",
      canRelease: android,
      canHalt: android,
      inRollout: android,
      releaseUncertain: android && uncertain,
      detail: android
        ? "Enviado agora. Liberar escolhe a próxima porcentagem."
        : "Na fila da Apple.",
    });
  }
  if (action === "halt") {
    return cell({
      platform: current.platform,
      status: "pausada",
      version: current.version,
      canRelease: true,
      detail: "Pausado. Só entra em Liberar se o aplicativo estiver marcado.",
    });
  }
  if (current.platform === "ios") {
    if (current.inRollout) {
      return cell({
        platform: "ios",
        status: "liberada",
        version: current.version,
        label: "No ar",
        detail: "Faseado encerrado. Disponível para 100% dos usuários.",
      });
    }
    return cell({
      platform: "ios",
      status: "aprovada",
      version: current.version,
      label: "Faseado · 1%",
      canRelease: true,
      canHalt: true,
      inRollout: true,
      detail: "Disponível para 1% dos usuários. Liberar encerra o faseado e vai para 100%.",
    });
  }
  if (current.platform === "android" && fraction < 1) {
    return cell({
      platform: "android",
      status: "aprovada",
      version: current.version,
      label: `Rollout ${formatPercent(fraction)}`,
      canRelease: true,
      canHalt: true,
      inRollout: true,
      detail: "Já está em rollout. Liberar aumenta a porcentagem.",
    });
  }
  return cell({
    platform: current.platform,
    status: "liberada",
    version: current.version,
    label: "No ar",
  });
}
