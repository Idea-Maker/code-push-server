import { cell, decorate, unavailable } from "./cells";
import { appStoreConnectUrl } from "./config";
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
      base("android", "em_revisao", {
        label: "Em revisão",
        releaseUncertain: true,
        detail: "Em revisão do Google. Ainda não está disponível para os usuários.",
      }),
    ios: () => base("ios", "em_revisao", { detail: "Na fila da Apple." }),
  },
  "nome-04": {
    android: () =>
      base("android", "aprovada", {
        label: "Pronto para publicar",
        needsConsolePublish: true,
        consoleUrl: "https://play.google.com/console/u/0/developers/demo/app/demo/publishing",
        detail:
          "Aprovado (10%). Publicação Gerenciada ativo: publique na Play Console — a API não tem essa etapa. Depois use Aumentar rollout.",
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
        inRollout: true,
        canPrepare: true,
        detail:
          "Já está em rollout. Use Aumentar rollout para subir a %. Bundle 4.3.0 (220) disponível. Use Preparar para criar o rascunho sem alterar o rollout.",
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
    android: () =>
      base("android", "liberada", {
        label: "No ar 100%",
        canPrepare: true,
        detail: "Bundle 4.3.0 (220) disponível. Use Preparar para criar o rascunho.",
      }),
    ios: () =>
      base("ios", "liberada", {
        label: "No ar 100%",
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
        inRollout: true,
        canPrepare: true,
        detail:
          "Já está em rollout. Use Aumentar rollout para subir a %. Bundle 4.2.0 (210) disponível. Use Preparar para criar o rascunho sem alterar o rollout.",
      }),
    ios: () => base("ios", "sem_build", { version: "—", detail: "Build ainda processando na Apple." }),
  },
  "nome-12": {
    android: () =>
      base("android", "em_revisao", {
        label: "Em revisão",
        detail: "Na fila da Google, fora do rollout.",
      }),
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
    const iosBase = saved?.ios ?? initialCell(config.id, "ios", Boolean(config.iosAppId));
    const iosUrl = appStoreConnectUrl(config);
    const ios = iosUrl ? cell({ ...iosBase, consoleUrl: iosUrl }) : iosBase;
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
        usesNonExemptEncryption: false,
        complianceReady: true,
      },
      {
        id: "demo-build-209",
        buildNumber: "209",
        marketingVersion: "4.2.0",
        processingState: "VALID",
        label: "4.2.0 (209)",
        usesNonExemptEncryption: false,
        complianceReady: true,
      },
      {
        id: "demo-build-198",
        buildNumber: "198",
        marketingVersion: "4.1.0",
        processingState: "VALID",
        label: "4.1.0 (198) · Missing Compliance",
        usesNonExemptEncryption: null,
        complianceReady: false,
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
  const next = nextCell(current, action, fraction, prepareChoice);
  const saved = overrides.get(app.id) ?? {};
  saved[platform] = next;
  overrides.set(app.id, saved);
  if (action === "prepare") {
    if (platform === "android") {
      const percent = formatPercent(fraction);
      return current.inRollout
        ? `Rascunho criado com rollout inicial de ${percent}. O rollout em andamento não foi alterado.`
        : `Rascunho criado com rollout inicial de ${percent}.`;
    }
    const version = prepareChoice?.versionString?.trim() || (current.version === "—" ? "4.2.0" : current.version);
    return `Rascunho ${version} criado com build ${prepareChoice?.buildId ?? "demo"}.`;
  }
  if (action === "review") {
    const staged =
      platform === "android" && typeof current.plannedFraction === "number" ? current.plannedFraction : fraction;
    return platform === "android"
      ? `Enviado para revisão em rollout de ${formatPercent(staged)}.`
      : "Enviado para revisão.";
  }
  if (action === "halt") return platform === "ios" ? "Lançamento faseado pausado." : "Rollout pausado.";
  if (platform === "ios") {
    if (current.status === "pausada") return "Lançamento faseado retomado.";
    if (current.inRollout) return "Liberada para 100% dos usuários.";
    return "Liberado em lançamento faseado de 7 dias.";
  }
  if (!current.inRollout) {
    throw new Error(
      "A primeira publicação com Publicação Gerenciada é só na Play Console. Use o link do board e depois Aumentar rollout.",
    );
  }
  return fraction < 1 ? `Rollout atualizado para ${formatPercent(fraction)}.` : "Rollout promovido para 100%.";
}

function nextCell(
  current: Cell,
  action: ActionName,
  fraction: number,
  prepareChoice?: IosPrepareChoice,
): Cell {
  if (action === "prepare") {
    if (current.platform === "android") {
      const percent = formatPercent(fraction);
      if (current.inRollout || current.status === "pausada") {
        return cell({
          ...current,
          canPrepare: false,
          canReview: false,
          plannedFraction: fraction,
          detail: `Rascunho da próxima versão criado com rollout inicial de ${percent}. Enviar para revisão fica disponível quando o rollout atual for concluído. O rollout segue disponível.`,
        });
      }
      return cell({
        platform: "android",
        status: "pronta",
        version: current.pendingVersion || (current.version === "—" ? VERSION : current.version),
        canReview: true,
        plannedFraction: fraction,
        detail: `Release em rascunho. Rollout inicial de ${percent}. Enviar para revisão usa esta porcentagem e as notas já definidas.`,
      });
    }
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
    const staged = android && typeof current.plannedFraction === "number" ? current.plannedFraction : fraction;
    const underReview = android && staged <= 0.02;
    if (android && underReview) {
      return cell({
        platform: "android",
        status: "em_revisao",
        version: current.version,
        label: "Em revisão",
        canRelease: true,
        canHalt: true,
        releaseUncertain: true,
        detail:
          "Enviado para a Google. Ainda não é rollout real — se a análise estiver em andamento, Liberar pode falhar neste app e os outros seguem.",
      });
    }
    if (android) {
      return cell({
        platform: "android",
        status: "aprovada",
        version: current.version,
        label: "Pronto para publicar",
        needsConsolePublish: true,
        consoleUrl: "https://play.google.com/console/u/0/developers/demo/app/demo/publishing",
        detail: `Aprovado (${formatPercent(staged)}). Publicação Gerenciada ativo: publique na Play Console — a API não tem essa etapa. Depois use Aumentar rollout.`,
      });
    }
    return cell({
      platform: "ios",
      status: "em_revisao",
      version: current.version,
      label: "Em revisão",
      detail: "Na fila da Apple.",
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
        label: "No ar 100%",
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
  if (current.platform === "android") {
    if (!current.inRollout) {
      throw new Error(
        "A primeira publicação com Publicação Gerenciada é só na Play Console. Use o link do board e depois Aumentar rollout.",
      );
    }
    if (fraction < 1) {
      return cell({
        platform: "android",
        status: "aprovada",
        version: current.version,
        label: `Rollout ${formatPercent(fraction)}`,
        canRelease: true,
        canHalt: true,
        inRollout: true,
        detail: "Já está em rollout. Use Aumentar rollout para subir a %.",
      });
    }
  }
  return cell({
    platform: current.platform,
    status: "liberada",
    version: current.version,
    label: "No ar 100%",
  });
}
