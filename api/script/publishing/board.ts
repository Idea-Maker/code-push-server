import { recordResult, readAudit, type AuditEntry } from "./audit";
import { cell, decorate, unavailable } from "./cells";
import { appStoreConnectUrl, hasAppleCredentials, hasPlayCredentials, loadApps, storeMode } from "./config";
import { applyDemo, demoApps, demoPrepareOptions, resetDemo, stampDemoError } from "./demo";
import { describeError, HttpError } from "./errors";
import { logger } from "./logger";
import { platformName, preview } from "./eligibility";
import { haltIos, listIosPrepareOptions, prepareIos, readIos, releaseIos, reviewIos } from "./appstore";
import { haltAndroid, prepareAndroid, readAndroid, releaseAndroid, reviewAndroid } from "./play";
import { mapPool, serialize } from "./pool";
import type { ActionName, ActionResult, BoardApp, Cell, IosPrepareChoice, IosPrepareOptions } from "./types";

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

export async function refreshApps(
  ids?: string[],
  platform?: "android" | "ios",
): Promise<BoardApp[]> {
  if (storeMode() === "demo") return listApps();
  const configs = loadApps();
  const targets = ids?.length ? configs.filter((config) => ids.includes(config.id)) : configs;
  const now = new Date().toISOString();
  // Concorrência baixa: Apple/Play estouram rate limit com vários apps em paralelo.
  await mapPool(targets, 2, async (config) => {
    const previous = cache.get(config.id);
    const shouldReadAndroid = !platform || platform === "android";
    const shouldReadIos = !platform || platform === "ios";
    const [android, ios] = await Promise.all([
      shouldReadAndroid
        ? readAndroidCell(config, previous?.android)
        : Promise.resolve(
            previous?.android ??
              (config.androidPackage
                ? cell({ platform: "android", status: "sem_build", detail: "Ainda não consultado." })
                : unavailable("android", "Este app não tem androidPackage.")),
          ),
      shouldReadIos
        ? readIosCell(config, previous?.ios)
        : Promise.resolve(
            previous?.ios ??
              (config.iosAppId
                ? cell({ platform: "ios", status: "sem_build", detail: "Ainda não consultado." })
                : unavailable("ios", "Este app não tem iosAppId.")),
          ),
    ]);
    cache.set(config.id, decorate(config.id, config.name, config.project, android, ios, now));
  });
  lastRefresh = now;
  return listApps();
}

export async function getIosPrepareOptions(appId: string): Promise<IosPrepareOptions> {
  const app = loadApps().find((item) => item.id === appId);
  if (!app) throw new HttpError(404, "App não encontrado.");
  if (!app.iosAppId) throw new HttpError(400, "App sem iosAppId.");
  if (storeMode() === "demo") return demoPrepareOptions(app);
  if (!hasAppleCredentials()) throw new HttpError(400, "Defina a chave da App Store Connect API.");
  try {
    return await listIosPrepareOptions(app);
  } catch (error) {
    throw new HttpError(502, describeError(error));
  }
}

export async function runAction(input: {
  action: ActionName;
  appIds: string[] | "all";
  platforms?: "android" | "ios" | "both";
  androidFraction?: number;
  releaseNotes?: string;
  iosPrepare?: IosPrepareChoice[];
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
  const prepareByApp = new Map(
    (input.iosPrepare ?? []).map((item) => [item.appId, item] as const),
  );

  const results = await mapPool(plan.included, 3, async (target) => {
    const app = loadApps().find((item) => item.id === target.appId);
    const current = apps.find((item) => item.id === target.appId);
    if (!app || !current) {
      return failure(target.appId, target.appName, target.platform, "App sumiu da configuração.");
    }
    try {
      const prepareChoice = prepareByApp.get(target.appId);
      const message =
        storeMode() === "demo"
          ? applyDemo(current, target.platform, input.action, input.androidFraction, prepareChoice)
          : await liveAction(
              app,
              target.platform,
              input.action,
              input.androidFraction,
              input.releaseNotes,
              prepareChoice,
            );
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
  iosPrepare?: IosPrepareChoice,
) {
  if (platform === "android") {
    if (action === "prepare") return prepareAndroid(app, releaseNotes, androidFraction);
    if (action === "review") return reviewAndroid(app, androidFraction, releaseNotes);
    if (action === "release") return releaseAndroid(app, androidFraction);
    return haltAndroid(app);
  }
  if (action === "prepare") {
    return prepareIos(
      app,
      iosPrepare
        ? {
            versionString: iosPrepare.versionString,
            buildId: iosPrepare.buildId,
            whatsNew: iosPrepare.whatsNew,
            releaseType: iosPrepare.releaseType,
            earliestReleaseDate: iosPrepare.earliestReleaseDate,
            phasedRelease: iosPrepare.phasedRelease,
          }
        : undefined,
    );
  }
  if (action === "review") return reviewIos(app, releaseNotes);
  if (action === "release") return releaseIos(app);
  return haltIos(app);
}

function isRateLimitMessage(message: string): boolean {
  return /too many requests|rate limit|try again later|slow down your request/i.test(message);
}

function keepPreviousOnRateLimit(previous: Cell | undefined, detail: string): Cell | null {
  if (!previous || !isRateLimitMessage(detail)) return null;
  if (previous.status === "erro" || previous.status === "sem_build" || previous.status === "indisponivel") {
    return null;
  }
  return cell({
    ...previous,
    lastError: detail,
    detail: previous.detail
      ? `${previous.detail} · Leitura limitada pela loja; mantido o status anterior.`
      : "Leitura limitada pela loja; mantido o status anterior.",
  });
}

async function readStoreWithRetry(read: () => Promise<Cell>): Promise<Cell> {
  try {
    return await read();
  } catch (error) {
    const first = describeError(error);
    if (!isRateLimitMessage(first)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return read();
  }
}

async function readAndroidCell(
  app: ReturnType<typeof loadApps>[number],
  previous?: Cell,
): Promise<Cell> {
  if (!app.androidPackage) return unavailable("android", "Este app não tem androidPackage.");
  if (!hasPlayCredentials()) return unavailable("android", "Defina PLAY_SERVICE_ACCOUNT_JSON.");
  try {
    return await readStoreWithRetry(() => readAndroid(app));
  } catch (error) {
    const detail = describeError(error);
    logger.error(
      { appId: app.id, platform: "android", message: detail },
      `falha ao consultar ${app.name}`,
    );
    return (
      keepPreviousOnRateLimit(previous, detail) ??
      cell({
        platform: "android",
        status: "erro",
        detail,
      })
    );
  }
}

async function readIosCell(
  app: ReturnType<typeof loadApps>[number],
  previous?: Cell,
): Promise<Cell> {
  if (!app.iosAppId) return unavailable("ios", "Este app não tem iosAppId.");
  if (!hasAppleCredentials()) {
    return withIosConsoleUrl(app, unavailable("ios", "Defina a chave da App Store Connect API."));
  }
  try {
    // Fila global da Apple: evita 429 ao abrir/atualizar o board com vários apps.
    const mapped = await serialize("apple-api", () => readStoreWithRetry(() => readIos(app)));
    return withIosConsoleUrl(app, mapped);
  } catch (error) {
    const detail = describeError(error);
    logger.error(
      { appId: app.id, platform: "ios", message: detail },
      `falha ao consultar ${app.name}`,
    );
    return withIosConsoleUrl(
      app,
      keepPreviousOnRateLimit(previous, detail) ??
        cell({
          platform: "ios",
          status: "erro",
          detail,
        }),
    );
  }
}

function withIosConsoleUrl(app: ReturnType<typeof loadApps>[number], mapped: Cell): Cell {
  const consoleUrl = appStoreConnectUrl(app);
  if (!consoleUrl) return mapped;
  return cell({ ...mapped, consoleUrl });
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
