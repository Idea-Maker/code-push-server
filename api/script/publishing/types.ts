export type Platform = "android" | "ios";

export type ActionName = "prepare" | "review" | "release" | "halt";

export type CellStatus =
  | "indisponivel"
  | "sem_build"
  | "pronta"
  | "em_revisao"
  | "aprovada"
  | "rejeitada"
  | "liberada"
  | "pausada"
  | "erro";

export type AppConfig = {
  id: string;
  name: string;
  /** Projeto dono do app, por exemplo WL ou ADS. */
  project: string;
  androidPackage?: string;
  /** production, beta, alpha ou internal. O padrão é production. */
  androidTrack?: string;
  iosAppId?: string;
  releaseNotes?: string;
};

export type Cell = {
  platform: Platform;
  status: CellStatus;
  label: string;
  detail: string;
  version: string;
  canPrepare: boolean;
  canReview: boolean;
  canRelease: boolean;
  canHalt: boolean;
  /** Já está com parte dos usuários: rollout da Play ou faseado da Apple. */
  inRollout: boolean;
  /** Android em 1%: a Google pode ainda estar revisando. */
  releaseUncertain: boolean;
  lastError: string | null;
};

export type BoardApp = {
  id: string;
  name: string;
  project: string;
  version: string;
  android: Cell;
  ios: Cell;
  note: string;
  refreshedAt: string | null;
};

export type ActionTarget = {
  appId: string;
  appName: string;
  platform: Platform;
  label: string;
  releaseUncertain: boolean;
};

export type SkippedTarget = ActionTarget & {
  reason: string;
};

export type ActionResult = {
  appId: string;
  appName: string;
  platform: Platform;
  ok: boolean;
  message: string;
};

export type IosPrepareChoice = {
  appId: string;
  versionString: string;
  buildId: string;
};

export type IosBuildOption = {
  id: string;
  buildNumber: string;
  marketingVersion: string | null;
  processingState: string;
  label: string;
};

export type IosPrepareOptions = {
  appId: string;
  appName: string;
  liveVersion: string | null;
  draftVersion: string | null;
  suggestedVersion: string | null;
  suggestedBuildId: string | null;
  builds: IosBuildOption[];
};
