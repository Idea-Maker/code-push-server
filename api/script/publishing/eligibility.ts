import type { ActionName, ActionTarget, BoardApp, Cell, Platform, SkippedTarget } from "./types";

export function isEligible(item: Cell, action: ActionName, explicit: boolean): boolean {
  if (action === "review") {
    if (item.canReview) return true;
    return explicit && item.status === "rejeitada";
  }
  if (action === "release") {
    if (!item.canRelease) return false;
    if (item.status === "pausada" && !explicit) return false;
    return true;
  }
  return item.canHalt;
}

export function preview(
  apps: readonly BoardApp[],
  input: { action: ActionName; appIds: string[] | "all"; platforms?: Platform | "both" },
): { included: ActionTarget[]; skipped: SkippedTarget[] } {
  const explicit = input.appIds !== "all";
  const chosen = explicit ? apps.filter((app) => input.appIds.includes(app.id)) : apps;
  const platforms: readonly Platform[] = input.platforms === "android" || input.platforms === "ios" ? [input.platforms] : ["android", "ios"];
  const included: ActionTarget[] = [];
  const skipped: SkippedTarget[] = [];

  for (const app of chosen) {
    for (const platform of platforms) {
      const item = app[platform];
      const target = {
        appId: app.id,
        appName: app.name,
        platform,
        label: item.label,
        releaseUncertain: item.releaseUncertain,
      };
      if (isEligible(item, input.action, explicit)) {
        included.push(target);
        continue;
      }
      if (item.status === "indisponivel") continue;
      skipped.push({ ...target, reason: item.lastError || item.detail || item.label });
    }
  }

  return { included, skipped };
}

export function platformName(platform: Platform): string {
  return platform === "android" ? "Android" : "iOS";
}
