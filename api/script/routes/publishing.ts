import { Request, Response, Router } from "express";

import {
  audit,
  getIosPrepareOptions,
  listApps,
  refreshApps,
  refreshedAt,
  resetDemoBoard,
  runAction,
} from "../publishing/board";
import { defaultReleaseNotes, reviewFraction, storeMode } from "../publishing/config";
import { HttpError } from "../publishing/errors";
import { preview } from "../publishing/eligibility";
import { logger } from "../publishing/logger";
import { ActionName, IosPrepareChoice } from "../publishing/types";

export function getPublishingRouter(): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response): void => {
    res.json({ ok: true, mode: storeMode() });
  });

  router.get("/session", (_req: Request, res: Response): void => {
    res.json({
      demo: storeMode() === "demo",
      androidReviewFraction: reviewFraction(),
      defaultReleaseNotes: defaultReleaseNotes(),
    });
  });

  router.get("/apps", (_req: Request, res: Response): void => {
    res.json(payload());
  });

  router.post("/refresh", async (req: Request, res: Response, next: Function): Promise<void> => {
    try {
      const ids = Array.isArray(req.body?.appIds)
        ? req.body.appIds.filter((id: unknown): id is string => typeof id === "string")
        : undefined;
      res.json(payload(await refreshApps(ids)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/preview", (req: Request, res: Response, next: Function): void => {
    try {
      res.json(
        preview(listApps(), {
          action: parseAction(req.body?.action),
          appIds: parseIds(req.body?.appIds),
          platforms: parsePlatforms(req.body?.platforms),
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/apps/:appId/ios/prepare-options", async (req: Request, res: Response, next: Function): Promise<void> => {
    try {
      const appId = typeof req.params.appId === "string" ? req.params.appId : "";
      if (!appId) throw new HttpError(400, "Informe o app.");
      res.json(await getIosPrepareOptions(appId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/act", async (req: Request, res: Response, next: Function): Promise<void> => {
    try {
      const action = parseAction(req.body?.action);
      const outcome = await runAction({
        action,
        appIds: parseIds(req.body?.appIds),
        platforms: parsePlatforms(req.body?.platforms),
        androidFraction: parseAndroidFraction(req.body?.androidFraction, action),
        releaseNotes: parseReleaseNotes(req.body?.releaseNotes, action),
        iosPrepare: parseIosPrepare(req.body?.iosPrepare, action),
      });
      res.json({
        ...outcome,
        demo: storeMode() === "demo",
        refreshedAt: refreshedAt(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/audit", (_req: Request, res: Response): void => {
    res.json({ entries: audit(40) });
  });

  router.post("/demo/reset", (_req: Request, res: Response, next: Function): void => {
    try {
      resetDemoBoard();
      res.json(payload());
    } catch (error) {
      next(error);
    }
  });

  router.use((error: unknown, req: Request, res: Response, next: Function): void => {
    void next;
    const path = req.originalUrl.split("?")[0] || req.path;
    if (error instanceof HttpError) {
      logger.warn({ method: req.method, path, status: error.status }, error.message);
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error(error instanceof Error ? error : { error }, "Falha interna");
    const message = error instanceof Error ? error.message : "Falha interna";
    res.status(500).json({ error: message });
  });

  return router;
}

function payload(apps: ReturnType<typeof listApps> = listApps()) {
  return { demo: storeMode() === "demo", refreshedAt: refreshedAt(), apps };
}

function parseAction(value: unknown): ActionName {
  if (value === "prepare" || value === "review" || value === "release" || value === "halt") return value;
  throw new HttpError(400, "Ação inválida.");
}

function parseAndroidFraction(value: unknown, action: ActionName): number {
  const fallback = action === "release" ? 1 : reviewFraction();
  if (action === "halt" || value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    throw new HttpError(400, "A porcentagem do Android precisa estar entre 1 e 100.");
  }
  return Math.round(number * 10000) / 10000;
}

function parseReleaseNotes(value: unknown, action: ActionName): string | undefined {
  if (action !== "review" || value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "As notas de versão precisam ser um texto.");
  const notes = value.trim();
  if (!notes) throw new HttpError(400, "As notas de versão não podem ficar vazias.");
  if (notes.length > 500) throw new HttpError(400, "As notas de versão podem ter no máximo 500 caracteres.");
  return notes;
}

function parsePlatforms(value: unknown): "android" | "ios" | "both" {
  if (value === undefined || value === null || value === "" || value === "both") return "both";
  if (value === "android" || value === "ios") return value;
  throw new HttpError(400, "A plataforma precisa ser Android, iOS ou as duas.");
}

function parseIds(value: unknown): string[] | "all" {
  if (value === "all") return "all";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new HttpError(400, 'Informe appIds como "all" ou uma lista de ids.');
}

function parseIosPrepare(value: unknown, action: ActionName): IosPrepareChoice[] | undefined {
  if (action !== "prepare" || value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, "iosPrepare precisa ser uma lista.");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HttpError(400, `iosPrepare[${index}] inválido.`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.appId !== "string" || !row.appId.trim()) {
      throw new HttpError(400, `iosPrepare[${index}].appId é obrigatório.`);
    }
    if (typeof row.versionString !== "string" || !row.versionString.trim()) {
      throw new HttpError(400, `Informe a versão do rascunho para ${row.appId}.`);
    }
    if (typeof row.buildId !== "string" || !row.buildId.trim()) {
      throw new HttpError(400, `Escolha o build para ${row.appId}.`);
    }
    return {
      appId: row.appId.trim(),
      versionString: row.versionString.trim(),
      buildId: row.buildId.trim(),
    };
  });
}
