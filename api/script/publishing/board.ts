import { recordResult, readAudit, type AuditEntry } from "./audit";
import { cell, decorate, unavailable } from "./cells";
import { hasAppleCredentials, hasPlayCredentials, loadApps, storeMode } from "./config";
import { applyDemo, demoApps, resetDemo, stampDemoError } from "./demo";
import { describeError, HttpError } from "./errors";
import { logger } from "./logger";
import { platformName, preview } from "./eligibility";
import { haltIos, readIos, releaseIos, reviewIos } from "./appstore";
import { haltAndroid, readAndroid, releaseAndroid, reviewAndroid } from "./play";
import { mapPool } from "./pool";
import type { ActionName, ActionResult, BoardApp, Cell } from "./types";

const cache = new Map<string, BoardApp>();
let lastRefresh: string | null = null;

export function listApps(): BoardApp[] {
  const configs = loadApps();
  if (storeMode() === "demo") return demoApps(configs);
  return configs.map((config) => {
    return (
      cache.get(config.id) ??
      decorate(
        config.id,
        config.name,
        config.project,
        config.androidPackage
          ? cell({ platform: "android", status: "sem_build", detail: "Ainda não consultado." })
          : unavailable("android", "Este app não tem androidPackage."),
        config.iosAppId
          ? cell({ platform: "ios", status: "sem_build", detail: "Ainda não consultado." })
          : unavailable("ios", "Este app não tem iosAppId."),
        null,
      )
    );
  });
}

export function refreshedAt(): string | null {
  return storeMode() === "demo" ? new Date().toISOString() : lastRefresh;
}

export async function refreshApps(ids?: string[]): Promise<BoardApp[]> {
  if (storeMode() === "demo") return listApps();
  const configs = loadApps();
  const targets = ids?.length ? configs.filter((config) => ids.includes(config.id)) : configs;
  await mapPool(targets, 4, async (config) => {
    const [android, ios] = await Promise.all([readAndroidCell(config), readIosCell(config)]);
    cache.set(config.id, decorate(config.id, config.name, config.project, android, ios, new Date().toISOString()));
  });
  lastRefresh = new Date().toISOString();
  return listApps();
}

export async function runAction(input: {
  action: ActionName;
  appIds: string[] | "all";
  platforms?: "android" | "ios" | "both";
  androidFraction?: number;
  releaseNotes?: string;
}): Promise<{
  results: ActionResult[];
  apps: BoardApp[];
}> {
  if (input.action === "halt" && input.appIds === "all") {
    throw new HttpError(400, "Pausar pede os aplicativos marcados. Não existe pausar todos.");
  }
  const apps = listApps();
  const plan = preview(apps, input);
  if (plan.included.length === 0) {
    throw new HttpError(400, "Nenhuma plataforma elegível para esta ação.");
  }

  const results = await mapPool(plan.included, 3, async (target) => {
    const app = loadApps().find((item) => item.id === target.appId);
    const current = apps.find((item) => item.id === target.appId);
    if (!app || !current) {
      return failure(target.appId, target.appName, target.platform, "App sumiu da configuração.");
    }
    try {
      const message =
        storeMode() === "demo"
          ? applyDemo(current, target.platform, input.action, input.androidFraction)
          : await liveAction(app, target.platform, input.action, input.androidFraction, input.releaseNotes);
      const result: ActionResult = {
        appId: target.appId,
        appName: target.appName,
        platform: target.platform,
        ok: true,
        message,
      };
      recordResult(input.action, result);
      logger.info(
        { action: input.action, appId: result.appId, appName: result.appName, platform: result.platform },
        `ok ${input.action} ${target.appName} ${platformName(target.platform)}: ${message}`,
      );
      return result;
    } catch (error) {
      const message = describeError(error);
      const result = failure(target.appId, target.appName, target.platform, message);
      recordResult(input.action, result);
      rememberError(target.appId, target.platform, message);
      logger.error(
        { action: input.action, appId: result.appId, appName: result.appName, platform: result.platform, message },
        `falha ${input.action} ${target.appName} ${platformName(target.platform)}: ${message}`,
      );
      return result;
    }
  });

  if (storeMode() === "live") {
    const touched = [...new Set(results.filter((result) => result.ok).map((result) => result.appId))];
    if (touched.length > 0) await refreshApps(touched);
  }

  return { results, apps: listApps() };
}

export function audit(limit = 30): AuditEntry[] {
  return readAudit(limit);
}

export function resetDemoBoard(): void {
  if (storeMode() !== "demo") throw new HttpError(404, "O reset só existe no modo demonstração.");
  resetDemo();
}

async function liveAction(
  app: ReturnType<typeof loadApps>[number],
  platform: BoardApp["android"]["platform"],
  action: ActionName,
  androidFraction?: number,
  releaseNotes?: string,
) {
  if (platform === "android") {
    if (action === "review") return reviewAndroid(app, androidFraction, releaseNotes);
    if (action === "release") return releaseAndroid(app, androidFraction);
    return haltAndroid(app);
  }
  if (action === "review") return reviewIos(app, releaseNotes);
  if (action === "release") return releaseIos(app);
  return haltIos(app);
}

async function readAndroidCell(app: ReturnType<typeof loadApps>[number]): Promise<Cell> {
  if (!app.androidPackage) return unavailable("android", "Este app não tem androidPackage.");
  if (!hasPlayCredentials()) return unavailable("android", "Defina PLAY_SERVICE_ACCOUNT_JSON.");
  try {
    return await readAndroid(app);
  } catch (error) {
    const detail = describeError(error);
    logger.error(
      { appId: app.id, platform: "android", message: detail },
      `falha ao consultar ${app.name}`,
    );
    return cell({
      platform: "android",
      status: "erro",
      detail,
    });
  }
}

async function readIosCell(app: ReturnType<typeof loadApps>[number]): Promise<Cell> {
  if (!app.iosAppId) return unavailable("ios", "Este app não tem iosAppId.");
  if (!hasAppleCredentials()) return unavailable("ios", "Defina a chave da App Store Connect API.");
  try {
    return await readIos(app);
  } catch (error) {
    const detail = describeError(error);
    logger.error(
      { appId: app.id, platform: "ios", message: detail },
      `falha ao consultar ${app.name}`,
    );
    return cell({
      platform: "ios",
      status: "erro",
      detail,
    });
  }
}

function rememberError(appId: string, platform: "android" | "ios", message: string): void {
  if (storeMode() === "demo") {
    const app = listApps().find((item) => item.id === appId);
    if (app) stampDemoError(app, platform, message);
    return;
  }
  const current = cache.get(appId);
  if (!current) return;
  const nextCell = cell({ ...current[platform], lastError: message });
  const android = platform === "android" ? nextCell : current.android;
  const ios = platform === "ios" ? nextCell : current.ios;
  cache.set(appId, decorate(current.id, current.name, current.project, android, ios, current.refreshedAt));
}

function failure(appId: string, appName: string, platform: "android" | "ios", message: string): ActionResult {
  return { appId, appName, platform, ok: false, message };
}
