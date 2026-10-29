import { GoogleAuth, type AuthClient } from "google-auth-library";
import { androidTrack, defaultReleaseNotes, notesLanguage, playApiRoot, playAuthScope, playCredentials, releaseNotesFor, reviewFraction } from "./config";
import { describeError } from "./errors";
import {
  findAndroidReleaseName,
  formatPercent,
  latestVersionCode,
  mapAndroidStatus,
  pickRicherAndroidReleaseName,
  withHaltedRelease,
  withReviewRelease,
  withTargetFraction,
  type RawRelease,
} from "./play-status";
import { serialize } from "./pool";
import type { AppConfig, Cell } from "./types";

type EditResponse = { id?: string };
type BundlesResponse = { bundles?: { versionCode?: number }[] };
type TrackResponse = { track?: string; releases?: RawRelease[] };
type TracksListResponse = { tracks?: TrackResponse[] };

type OpenedTrack = {
  editId: string;
  releases: RawRelease[];
  latest: number | null;
  /** Nome com versionName, se existir em qualquer faixa (internal/alpha/…). */
  releaseName: string | null;
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

async function openTrack(app: AppConfig): Promise<OpenedTrack> {
  const packageName = app.androidPackage;
  if (!packageName) throw new Error("App sem androidPackage.");
  const track = androidTrack(app);
  const edit = await play<EditResponse>(endpoint(packageName, "/edits"), { method: "POST", data: {} });
  const editId = edit.id;
  if (!editId) throw new Error("O Play não retornou o edit.");
  try {
    const [bundles, trackBody, allTracks] = await Promise.all([
      play<BundlesResponse>(endpoint(packageName, `/edits/${editId}/bundles`)),
      play<TrackResponse>(endpoint(packageName, `/edits/${editId}/tracks/${encodeURIComponent(track)}`)),
      play<TracksListResponse>(endpoint(packageName, `/edits/${editId}/tracks`)),
    ]);
    const releases = trackBody.releases ?? [];
    const latest = latestVersionCode((bundles.bundles ?? []).map((bundle) => bundle.versionCode));
    const otherReleases = (allTracks.tracks ?? []).flatMap((item) => item.releases ?? []);
    const releaseName =
      latest === null
        ? null
        : pickRicherAndroidReleaseName(
            latest,
            findAndroidReleaseName(releases, latest),
            findAndroidReleaseName(otherReleases, latest),
          ) ?? null;
    return { editId, releases, latest, releaseName };
  } catch (error) {
    await abandon(packageName, editId);
    throw error;
  }
}

async function commit(packageName: string, editId: string, track: string, releases: RawRelease[]): Promise<void> {
  try {
    await play(endpoint(packageName, `/edits/${editId}/tracks/${encodeURIComponent(track)}`), {
      method: "PUT",
      data: { track, releases },
    });
    await play(endpoint(packageName, `/edits/${editId}:commit`), {
      method: "POST",
      params: {
        changesNotSentForReview: "false",
        changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
      },
    });
  } catch (error) {
    await abandon(packageName, editId);
    throw error;
  }
}

export async function readAndroid(app: AppConfig): Promise<Cell> {
  if (!app.androidPackage) return mapAndroidStatus({ configured: false, latestVersionCode: null, releases: [] });
  return serialize(`play:${app.androidPackage}`, async () => {
    const opened = await openTrack(app);
    await abandon(app.androidPackage as string, opened.editId);
    return mapAndroidStatus({
      configured: true,
      latestVersionCode: opened.latest,
      releases: opened.releases,
      releaseName: opened.releaseName,
    });
  });
}

export async function reviewAndroid(app: AppConfig, fraction = reviewFraction(), notes?: string): Promise<string> {
  const packageName = app.androidPackage;
  if (!packageName) throw new Error("App sem androidPackage.");
  const typed = notes?.trim();
  const replaceNotes = Boolean(typed && typed !== defaultReleaseNotes());
  return serialize(`play:${packageName}`, () =>
    changeAndroid(app, (opened) => {
      if (opened.latest === null) throw new Error("Nenhum AAB encontrado. O CI ainda não enviou o bundle.");
      return {
        releases: withReviewRelease(
          opened.releases,
          opened.latest,
          releaseNotesFor(app, notes),
          fraction,
          notesLanguage(),
          replaceNotes,
          opened.releaseName,
        ),
        message: `Version code ${opened.latest} enviado para revisão em rollout de ${formatPercent(fraction)}.`,
      };
    }),
  );
}

export async function releaseAndroid(app: AppConfig, fraction = 1): Promise<string> {
  if (!app.androidPackage) throw new Error("App sem androidPackage.");
  return serialize(`play:${app.androidPackage}`, () =>
    changeAndroid(app, (opened) => ({
      releases: withTargetFraction(opened.releases, fraction),
      message: fraction >= 1 ? "Rollout promovido para 100%." : `Rollout atualizado para ${formatPercent(fraction)}.`,
    })),
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
  change: (opened: OpenedTrack) => { releases: RawRelease[]; message: string },
): Promise<string> {
  const packageName = app.androidPackage as string;
  const opened = await openTrack(app);
  try {
    const next = change(opened);
    await commit(packageName, opened.editId, androidTrack(app), next.releases);
    return next.message;
  } catch (error) {
    await abandon(packageName, opened.editId);
    throw error;
  }
}
