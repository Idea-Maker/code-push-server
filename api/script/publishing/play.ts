import { GoogleAuth, type AuthClient } from "google-auth-library";
import {
  androidTrack,
  defaultReleaseNotes,
  notesLanguage,
  playApiRoot,
  playAuthScope,
  playConsolePublishingUrl,
  playCredentials,
  releaseNotesFor,
  reviewFraction,
} from "./config";
import { forgetAndroidDraft, readAndroidDraft, rememberAndroidDraft } from "./android-draft-plans";
import { cell } from "./cells";
import { describeError } from "./errors";
import {
  findAndroidReleaseName,
  formatPercent,
  isAndroidRolloutLive,
  versionCodeForBoard,
  mapAndroidStatus,
  pickRicherAndroidReleaseName,
  withDraftRelease,
  withHaltedRelease,
  withReviewRelease,
  withTargetFraction,
  type RawRelease,
  type ReleaseSummary,
} from "./play-status";
import { serialize } from "./pool";
import type { AppConfig, Cell } from "./types";

type EditResponse = { id?: string };
type BundlesResponse = { bundles?: { versionCode?: number }[] };
type TrackResponse = { track?: string; releases?: RawRelease[] };
type TracksListResponse = { tracks?: TrackResponse[] };
type ReleaseSummariesResponse = { releases?: ReleaseSummary[] };

type OpenedTrack = {
  editId: string;
  releases: RawRelease[];
  latest: number | null;
  /** Nome com versionName, se existir em qualquer faixa (internal/alpha/…). */
  releaseName: string | null;
  /** Lifecycle da Console (Em revisão / Pronto para publicar / …). */
  lifecycleSummaries: ReleaseSummary[];
};

let auth: GoogleAuth | null = null;

function playAuth(): GoogleAuth {
  if (!auth) {
    auth = new GoogleAuth({
      ...playCredentials(),
      scopes: [playAuthScope()],
    });
  }
  return auth;
}

function endpoint(packageName: string, suffix: string): string {
  return `${playApiRoot()}/${encodeURIComponent(packageName)}${suffix}`;
}

async function play<T>(
  url: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    data?: unknown;
    params?: Record<string, string>;
  } = {},
): Promise<T> {
  const client: AuthClient = await playAuth().getClient();
  try {
    const response = await client.request<T>({
      url,
      method: options.method ?? "GET",
      data: options.data,
      params: options.params,
    });
    return response.data;
  } catch (error) {
    throw new Error(describeError(error));
  }
}

async function abandon(packageName: string, editId: string): Promise<void> {
  await play(endpoint(packageName, `/edits/${editId}`), { method: "DELETE" }).catch(() => undefined);
}

async function listLifecycleSummaries(packageName: string, track: string): Promise<ReleaseSummary[]> {
  try {
    const body = await play<ReleaseSummariesResponse>(
      endpoint(packageName, `/tracks/${encodeURIComponent(track)}/releases`),
    );
    return body.releases ?? [];
  } catch {
    // Contas/ambientes sem o endpoint novo caem no mapeamento pelo status do edit.
    return [];
  }
}

async function openTrack(app: AppConfig): Promise<OpenedTrack> {
  const packageName = app.androidPackage;
  if (!packageName) throw new Error("App sem androidPackage.");
  const track = androidTrack(app);
  const edit = await play<EditResponse>(endpoint(packageName, "/edits"), { method: "POST", data: {} });
  const editId = edit.id;
  if (!editId) throw new Error("O Play não retornou o edit.");
  try {
    const [bundles, trackBody, allTracks, lifecycleSummaries] = await Promise.all([
      play<BundlesResponse>(endpoint(packageName, `/edits/${editId}/bundles`)),
      play<TrackResponse>(endpoint(packageName, `/edits/${editId}/tracks/${encodeURIComponent(track)}`)),
      play<TracksListResponse>(endpoint(packageName, `/edits/${editId}/tracks`)),
      listLifecycleSummaries(packageName, track),
    ]);
    const releases = trackBody.releases ?? [];
    const latest = versionCodeForBoard(
      (bundles.bundles ?? []).map((bundle) => bundle.versionCode),
      releases,
      lifecycleSummaries,
    );
    const otherReleases = (allTracks.tracks ?? []).flatMap((item) => item.releases ?? []);
    const releaseName =
      latest === null
        ? null
        : pickRicherAndroidReleaseName(
            latest,
            findAndroidReleaseName(releases, latest),
            findAndroidReleaseName(otherReleases, latest),
          ) ?? null;
    return { editId, releases, latest, releaseName, lifecycleSummaries };
  } catch (error) {
    await abandon(packageName, editId);
    throw error;
  }
}

async function commitEdit(
  packageName: string,
  editId: string,
  changesNotSentForReview: boolean,
): Promise<void> {
  const baseParams: Record<string, string> = {
    changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
  };
  const preferred = changesNotSentForReview
    ? { ...baseParams, changesNotSentForReview: "true" }
    : baseParams;
  try {
    await play(endpoint(packageName, `/edits/${editId}:commit`), {
      method: "POST",
      params: preferred,
    });
    return;
  } catch (error) {
    const message = describeError(error);
    // App sem rejeição pendente: a Play manda revisão sozinha e rejeita o parâmetro.
    if (changesNotSentForReview && /must not be set/i.test(message)) {
      await play(endpoint(packageName, `/edits/${editId}:commit`), {
        method: "POST",
        params: baseParams,
      });
      return;
    }
    // Submissão anterior rejeitada: a Play exige o parâmetro.
    if (!changesNotSentForReview && /changesNotSentForReview to true/i.test(message)) {
      await play(endpoint(packageName, `/edits/${editId}:commit`), {
        method: "POST",
        params: { ...baseParams, changesNotSentForReview: "true" },
      });
      return;
    }
    throw error;
  }
}

async function commit(
  packageName: string,
  editId: string,
  track: string,
  releases: RawRelease[],
  changesNotSentForReview = false,
): Promise<void> {
  try {
    await play(endpoint(packageName, `/edits/${editId}/tracks/${encodeURIComponent(track)}`), {
      method: "PUT",
      data: { track, releases },
    });
    await commitEdit(packageName, editId, changesNotSentForReview);
  } catch (error) {
    await abandon(packageName, editId);
    throw error;
  }
}

function withStoredDraftPlan(mapped: Cell, packageName: string, versionCode: number | null): Cell {
  if (versionCode === null) return mapped;
  const plan = readAndroidDraft(packageName, versionCode);
  if (!plan) return mapped;
  const percent = formatPercent(plan.fraction);
  const detail = mapped.detail.includes(percent)
    ? mapped.detail
    : [mapped.detail, `Rollout inicial definido na preparação: ${percent}.`].filter((part) => part.trim()).join(" ");
  return cell({ ...mapped, plannedFraction: plan.fraction, detail });
}

function withAndroidConsoleUrl(mapped: Cell, app: AppConfig): Cell {
  const consoleUrl = playConsolePublishingUrl(app);
  if (!consoleUrl) return mapped;
  return cell({ ...mapped, consoleUrl });
}

export async function readAndroid(app: AppConfig): Promise<Cell> {
  if (!app.androidPackage) return mapAndroidStatus({ configured: false, latestVersionCode: null, releases: [] });
  return serialize(`play:${app.androidPackage}`, async () => {
    const opened = await openTrack(app);
    await abandon(app.androidPackage as string, opened.editId);
    return withAndroidConsoleUrl(
      withStoredDraftPlan(
        mapAndroidStatus({
          configured: true,
          latestVersionCode: opened.latest,
          releases: opened.releases,
          releaseName: opened.releaseName,
          lifecycleSummaries: opened.lifecycleSummaries,
        }),
        app.androidPackage as string,
        opened.latest,
      ),
      app,
    );
  });
}

export async function prepareAndroid(app: AppConfig, notes?: string, fraction = reviewFraction()): Promise<string> {
  const packageName = app.androidPackage;
  if (!packageName) throw new Error("App sem androidPackage.");
  const text = releaseNotesFor(app, notes);
  return serialize(`play:${packageName}`, () =>
    changeAndroid(app, (opened) => {
      if (opened.latest === null) throw new Error("Nenhum AAB encontrado. O CI ainda não enviou o bundle.");
      const versionCode = opened.latest;
      return {
        releases: withDraftRelease(opened.releases, versionCode, text, notesLanguage(), opened.releaseName),
        message: `Rascunho do version code ${versionCode} criado com rollout inicial de ${formatPercent(fraction)}. O rollout em andamento não foi alterado.`,
        changesNotSentForReview: true,
        onCommitted: () => rememberAndroidDraft(packageName, versionCode, { fraction, notes: text }),
      };
    }),
  );
}

export async function reviewAndroid(app: AppConfig, fraction = reviewFraction(), notes?: string): Promise<string> {
  const packageName = app.androidPackage;
  if (!packageName) throw new Error("App sem androidPackage.");
  const typed = notes?.trim();
  return serialize(`play:${packageName}`, () =>
    changeAndroid(app, (opened) => {
      if (opened.latest === null) throw new Error("Nenhum AAB encontrado. O CI ainda não enviou o bundle.");
      const versionCode = opened.latest;
      const stored = readAndroidDraft(packageName, versionCode);
      const staged = stored?.fraction ?? fraction;
      const replaceNotes = stored ? false : Boolean(typed && typed !== defaultReleaseNotes());
      return {
        releases: withReviewRelease(
          opened.releases,
          versionCode,
          stored?.notes || releaseNotesFor(app, notes),
          staged,
          notesLanguage(),
          replaceNotes,
          opened.releaseName,
        ),
        message: `Version code ${versionCode} enviado para revisão em rollout de ${formatPercent(staged)}.`,
        onCommitted: () => forgetAndroidDraft(packageName, versionCode),
      };
    }),
  );
}

export async function releaseAndroid(app: AppConfig, fraction = 1): Promise<string> {
  if (!app.androidPackage) throw new Error("App sem androidPackage.");
  return serialize(`play:${app.androidPackage}`, () =>
    changeAndroid(app, (opened) => {
      const live = isAndroidRolloutLive(opened.releases, opened.latest, opened.lifecycleSummaries);
      if (!live) {
        const consoleUrl = playConsolePublishingUrl(app);
        throw new Error(
          "A primeira publicação com Publicação Gerenciada é só na Play Console (a API não tem Publicar alterações). " +
            (consoleUrl
              ? `Abra: ${consoleUrl}`
              : "Configure PLAY_CONSOLE_DEVELOPER_ID e playConsoleAppId para o link direto no board."),
        );
      }
      return {
        releases: withTargetFraction(opened.releases, fraction),
        message:
          fraction >= 1
            ? "Rollout promovido para 100%."
            : `Rollout atualizado para ${formatPercent(fraction)}.`,
      };
    }),
  );
}

export async function haltAndroid(app: AppConfig): Promise<string> {
  if (!app.androidPackage) throw new Error("App sem androidPackage.");
  return serialize(`play:${app.androidPackage}`, () =>
    changeAndroid(app, (opened) => ({
      releases: withHaltedRelease(opened.releases),
      message: "Rollout pausado.",
    })),
  );
}

async function changeAndroid(
  app: AppConfig,
  // eslint-disable-next-line no-unused-vars
  change: (opened: OpenedTrack) => {
    releases: RawRelease[];
    message: string;
    changesNotSentForReview?: boolean;
    onCommitted?: () => void;
  },
): Promise<string> {
  const packageName = app.androidPackage as string;
  const opened = await openTrack(app);
  try {
    const next = change(opened);
    await commit(
      packageName,
      opened.editId,
      androidTrack(app),
      next.releases,
      next.changesNotSentForReview,
    );
    next.onCommitted?.();
    return next.message;
  } catch (error) {
    await abandon(packageName, opened.editId);
    throw error;
  }
}
