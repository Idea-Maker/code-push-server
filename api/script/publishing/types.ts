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
  /**
   * ID numérico do app na Play Console (trecho /app/{id}/ da URL).
   * Usado para montar o link direto da Visão geral da publicação.
   */
  playConsoleAppId?: string;
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
  /**
   * Android: aprovado com Publicação Gerenciada — a 1ª publicação só na Console
   * (a API não tem o botão Publicar alterações).
   */
  needsConsolePublish: boolean;
  /** Link da Play Console / App Store Connect quando disponível. */
  consoleUrl: string | null;
  lastError: string | null;
  /** Bundle novo que ainda não é o status principal (rollout/no ar seguem visíveis). */
  pendingVersion: string | null;
  /** Porcentagem inicial escolhida na preparação do rascunho Android. */
  plannedFraction: number | null;
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
  /** Já está com parte dos usuários (rollout Play / faseado Apple). */
  inRollout: boolean;
  version?: string;
  pendingVersion?: string | null;
  plannedFraction?: number | null;
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

export type IosReleaseType = "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";

export type IosPrepareChoice = {
  appId: string;
  versionString: string;
  buildId: string;
  whatsNew: string;
  releaseType: IosReleaseType;
  /** ISO-8601; obrigatório quando releaseType é SCHEDULED. */
  earliestReleaseDate?: string;
  /** true = phased de 7 dias; false = todos os usuários de imediato. */
  phasedRelease: boolean;
};

export type IosBuildOption = {
  id: string;
  buildNumber: string;
  marketingVersion: string | null;
  processingState: string;
  label: string;
  /** null = Missing Compliance na Console. */
  usesNonExemptEncryption: boolean | null;
  complianceReady: boolean;
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
