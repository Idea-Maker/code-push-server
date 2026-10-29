import * as jwt from "jsonwebtoken";
import { appStoreApiBase, appStoreAudience, defaultReleaseNotes, privateKeyFileName, readPrivateKey, releaseNotesFor } from "./config";
import { describeError } from "./errors";
import {
  compareVersions,
  findPreparingDraft,
  mapIosStatus,
  marketingVersion,
  pickStoreVersion,
  type BuildState,
  type IosVersionCandidate,
} from "./appstore-status";
import { formatAppBuild } from "./cells";
import { serialize } from "./pool";
import type { AppConfig, Cell, IosBuildOption, IosPrepareChoice, IosPrepareOptions } from "./types";

const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "REJECTED", "METADATA_REJECTED", "DEVELOPER_REJECTED"]);

type VersionResource = {
  id: string;
  attributes: {
    versionString?: string;
    appStoreState?: string;
    releaseType?: string;
    createdDate?: string;
  };
};

type BuildResource = {
  id: string;
  attributes: {
    version?: string;
    processingState?: string;
  };
};

type PreReleaseVersion = {
  attributes?: { version?: string };
};

type Localization = {
  id: string;
  attributes: { locale?: string; whatsNew?: string };
};

type PhasedRelease = {
  id: string;
  attributes: {
    phasedReleaseState?: string;
    currentDayNumber?: number;
  };
};

class AppleHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let cachedToken: { value: string; exp: number } | null = null;

function appleToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.value;
  const configuredKey = process.env.ASC_PRIVATE_KEY?.trim();
  const issuer = process.env.ASC_ISSUER_ID?.trim();
  const keyId = process.env.ASC_KEY_ID?.trim();
  if (!configuredKey || !issuer || !keyId) {
    throw new Error("Defina ASC_ISSUER_ID, ASC_KEY_ID e ASC_PRIVATE_KEY.");
  }
  const fileName = privateKeyFileName(configuredKey);
  const fromFile = fileName ? /^AuthKey_([A-Za-z0-9]+)\.p8$/i.exec(fileName) : null;
  if (fromFile && fromFile[1].toUpperCase() !== keyId.toUpperCase()) {
    throw new Error(
      `O arquivo ${fileName} é da chave ${fromFile[1].toUpperCase()}, mas ASC_KEY_ID está como ${keyId}. Os dois têm que ser o mesmo.`,
    );
  }
  const key = readPrivateKey(configuredKey);
  const value = jwt.sign({}, key, {
    algorithm: "ES256",
    expiresIn: "15m",
    issuer,
    audience: appStoreAudience(),
    keyid: keyId,
  });
  cachedToken = { value, exp: now + 15 * 60 };
  return value;
}

async function apple<T>(pathname: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${appStoreApiBase()}${pathname}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${appleToken()}`,
        "Content-Type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw new Error(describeError(error));
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: (T & { errors?: { detail?: string; title?: string }[] }) | undefined;
  if (text) {
    try {
      data = JSON.parse(text) as T & { errors?: { detail?: string; title?: string }[] };
    } catch {
      data = undefined;
    }
  }
  if (!response.ok) {
    const detail = data?.errors?.map((item) => item.detail || item.title).filter(Boolean).join("; ");
    throw new AppleHttpError(detail || `App Store Connect respondeu ${response.status}`, response.status);
  }
  return data as T;
}

async function listVersions(appId: string): Promise<VersionResource[]> {
  const body = await apple<{ data?: VersionResource[] }>(
    `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=IOS&limit=10`,
  );
  return (body.data ?? [])
    .slice()
    .sort((left, right) => (right.attributes.createdDate ?? "").localeCompare(left.attributes.createdDate ?? ""));
}

async function listBuilds(appId: string, limit = 5): Promise<BuildResource[]> {
  const body = await apple<{ data?: BuildResource[] }>(
    `/v1/builds?filter[app]=${encodeURIComponent(appId)}&sort=-uploadedDate&limit=${limit}&fields[builds]=version,processingState,uploadedDate`,
  );
  return body.data ?? [];
}

async function versionBuild(versionId: string): Promise<BuildResource | null> {
  try {
    const body = await apple<{ data?: BuildResource | null }>(
      `/v1/appStoreVersions/${versionId}/build?fields[builds]=version,processingState,uploadedDate`,
    );
    return body.data?.id ? body.data : null;
  } catch (error) {
    if (error instanceof AppleHttpError && error.status === 404) return null;
    throw error;
  }
}

async function buildAppVersion(build: BuildResource | undefined): Promise<string | null> {
  if (!build) return null;
  try {
    const body = await apple<{ data?: PreReleaseVersion | null }>(`/v1/builds/${build.id}/preReleaseVersion`);
    return body.data?.attributes?.version?.trim() || null;
  } catch (error) {
    if (error instanceof AppleHttpError && error.status === 404) return null;
    throw error;
  }
}

function toBuildState(build: BuildResource | undefined): BuildState {
  const processing = build?.attributes.processingState;
  if (!build) return "none";
  if (processing === "VALID") return "valid";
  if (processing === "FAILED" || processing === "INVALID") return "failed";
  return "processing";
}

async function createVersion(appId: string, versionString: string): Promise<VersionResource> {
  const body = await apple<{ data: VersionResource }>("/v1/appStoreVersions", {
    method: "POST",
    body: {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString, releaseType: "MANUAL" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    },
  });
  return body.data;
}

async function attachBuild(versionId: string, buildId: string): Promise<void> {
  try {
    const current = await apple<{ data?: { id: string } | null }>(`/v1/appStoreVersions/${versionId}/build`);
    if (current.data?.id === buildId) return;
  } catch (error) {
    if (!(error instanceof AppleHttpError) || error.status !== 404) throw error;
  }
  await apple(`/v1/appStoreVersions/${versionId}/relationships/build`, {
    method: "PATCH",
    body: { data: { type: "builds", id: buildId } },
  });
}

async function ensureWhatsNew(versionId: string, notes: string, replace: boolean): Promise<void> {
  const body = await apple<{ data?: Localization[] }>(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=20`,
  );
  const locales = body.data ?? [];
  const preferred =
    locales.find((item) => item.attributes.locale === "pt-BR") ??
    locales.find((item) => item.attributes.locale === "pt-PT") ??
    locales[0];
  if (!preferred) {
    throw new Error("A versão não tem idioma no App Store Connect. Cadastre a localização uma vez.");
  }
  if (preferred.attributes.whatsNew?.trim() && !replace) return;
  await apple(`/v1/appStoreVersionLocalizations/${preferred.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "appStoreVersionLocalizations",
        id: preferred.id,
        attributes: { whatsNew: notes },
      },
    },
  });
}

export async function readIos(app: AppConfig): Promise<Cell> {
  if (!app.iosAppId) return mapIosStatus(emptyIos(false));
  return serialize(`ios:${app.iosAppId}`, async () => {
    const versions = await listVersions(app.iosAppId as string);
    const onSale = versions.filter((item) => item.attributes.appStoreState === "READY_FOR_SALE");
    const phasedById = new Map(
      await Promise.all(
        onSale.map(async (item) => [item.id, await readPhased(item.id)] as const),
      ),
    );
    const candidates: IosVersionCandidate[] = versions.map((item) => ({
      id: item.id,
      versionString: item.attributes.versionString ?? null,
      appStoreState: item.attributes.appStoreState ?? null,
      releaseType: item.attributes.releaseType ?? null,
      phasedReleaseState: phasedById.get(item.id)?.attributes.phasedReleaseState ?? null,
    }));
    const live = candidates.find((item) => item.appStoreState === "READY_FOR_SALE");
    const liveName = marketingVersion(live?.versionString);
    const picked = pickStoreVersion(candidates);
    const draft = findPreparingDraft(candidates, liveName);
    const draftIsPrimary = Boolean(picked && draft && picked.id === draft.id);

    if (!picked) {
      const builds = await listBuilds(app.iosAppId as string);
      const build = builds[0];
      return mapIosStatus({
        configured: true,
        versionString: null,
        appVersion: marketingVersion(await buildAppVersion(build)),
        appStoreState: null,
        releaseType: null,
        buildVersion: build?.attributes.version ?? null,
        buildState: toBuildState(build),
        liveVersionString: liveName,
      });
    }

    const version = versions.find((item) => item.id === picked.id) as VersionResource;
    const phased = phasedById.get(version.id) ?? (await readPhased(version.id));
    const storeBuild = await versionBuild(version.id);
    const fromStore = marketingVersion(version.attributes.versionString);
    const fromBuild = marketingVersion(await buildAppVersion(storeBuild ?? undefined));

    let pendingDraftVersion: string | null = null;
    let pendingDraftBuildState: BuildState | null = null;
    let pendingBuildLabel: string | null = null;

    if (draft && !draftIsPrimary) {
      pendingDraftVersion = marketingVersion(draft.versionString);
      const draftBuild = await versionBuild(draft.id);
      pendingDraftBuildState = toBuildState(draftBuild ?? undefined);
    } else if (!draft) {
      const newer = await findNewerValidBuild(app.iosAppId as string, liveName);
      if (newer) pendingBuildLabel = newer.label;
    }

    return mapIosStatus({
      configured: true,
      versionString: fromStore,
      appVersion: fromBuild ?? fromStore,
      appStoreState: version.attributes.appStoreState ?? null,
      releaseType: version.attributes.releaseType ?? null,
      buildVersion: storeBuild?.attributes.version ?? null,
      buildState: toBuildState(storeBuild ?? undefined),
      phasedReleaseState: phased?.attributes.phasedReleaseState ?? null,
      currentDayNumber: phased?.attributes.currentDayNumber ?? null,
      liveVersionString: liveName,
      pendingDraftVersion,
      pendingDraftBuildState,
      pendingBuildLabel,
    });
  });
}

export async function listIosPrepareOptions(app: AppConfig): Promise<IosPrepareOptions> {
  const appId = app.iosAppId;
  if (!appId) throw new Error("App sem iosAppId.");
  return serialize(`ios:${appId}`, async () => {
    const versions = await listVersions(appId);
    const live = versions.find((item) => item.attributes.appStoreState === "READY_FOR_SALE");
    const liveName = marketingVersion(live?.attributes.versionString);
    const draft = findPreparingDraft(
      versions.map((item) => ({
        id: item.id,
        versionString: item.attributes.versionString ?? null,
        appStoreState: item.attributes.appStoreState ?? null,
      })),
      liveName,
    );
    const draftVersion = marketingVersion(draft?.versionString);
    const builds = await listBuilds(appId, 20);
    const options: IosBuildOption[] = [];
    for (const build of builds) {
      const marketing = marketingVersion(await buildAppVersion(build));
      const buildNumber = build.attributes.version?.trim() || "";
      options.push({
        id: build.id,
        buildNumber,
        marketingVersion: marketing,
        processingState: build.attributes.processingState ?? "PROCESSING",
        label: formatAppBuild(marketing, buildNumber),
      });
    }
    const valid = options.filter((item) => item.processingState === "VALID");
    const preferred =
      valid.find((item) => draftVersion && item.marketingVersion === draftVersion) ??
      valid.find((item) => item.marketingVersion && liveName && compareVersions(item.marketingVersion, liveName) > 0) ??
      valid[0] ??
      null;
    return {
      appId: app.id,
      appName: app.name,
      liveVersion: liveName,
      draftVersion,
      suggestedVersion: draftVersion ?? preferred?.marketingVersion ?? null,
      suggestedBuildId: preferred?.id ?? null,
      builds: options,
    };
  });
}

export async function prepareIos(app: AppConfig, choice?: Omit<IosPrepareChoice, "appId">): Promise<string> {
  const appId = app.iosAppId;
  if (!appId) throw new Error("App sem iosAppId.");
  return serialize(`ios:${appId}`, async () => {
    const versions = await listVersions(appId);
    const builds = await listBuilds(appId, 20);
    const live = versions.find((item) => item.attributes.appStoreState === "READY_FOR_SALE");
    const liveName = marketingVersion(live?.attributes.versionString);

    let build: BuildResource | undefined;
    let marketing: string | null = null;

    if (choice?.buildId) {
      build = builds.find((item) => item.id === choice.buildId);
      if (!build) {
        const listed = await listBuilds(appId, 50);
        build = listed.find((item) => item.id === choice.buildId);
      }
      if (!build) throw new Error("Build escolhido não foi encontrado no App Store Connect.");
      if (build.attributes.processingState !== "VALID") {
        throw new Error("O build escolhido ainda não está válido. Espere o processamento na Apple.");
      }
      marketing = marketingVersion(await buildAppVersion(build));
    } else {
      const auto = await resolveValidBuild(builds, null, liveName);
      if (!auto) throw new Error("Não há build processado. Espere o upload do CI terminar.");
      build = auto.build;
      marketing = auto.marketing;
    }

    const requested = choice?.versionString?.trim() ? marketingVersion(choice.versionString) : null;
    if (choice?.versionString?.trim() && !requested) {
      throw new Error("A versão do rascunho precisa ser no formato 1.2 ou 1.2.3.");
    }
    const versionString = requested ?? marketing;
    if (!versionString) throw new Error("O build não informa a versão do app.");
    if (marketing && marketing !== versionString) {
      throw new Error(
        `O build é da versão ${marketing}, mas o rascunho pedido é ${versionString}. Escolha um build da mesma versão.`,
      );
    }
    if (liveName && compareVersions(versionString, liveName) <= 0) {
      throw new Error(`A versão ${liveName} já está no ar. Informe uma versão maior.`);
    }

    let version = versions.find((item) => {
      if (!EDITABLE.has(item.attributes.appStoreState ?? "")) return false;
      const name = marketingVersion(item.attributes.versionString);
      return Boolean(name && name === versionString);
    });
    if (!version) {
      const other = versions.find(
        (item) => EDITABLE.has(item.attributes.appStoreState ?? "") && marketingVersion(item.attributes.versionString),
      );
      const existingName = other ? marketingVersion(other.attributes.versionString) : null;
      if (other && existingName && existingName !== versionString) {
        throw new Error(
          `Já existe o rascunho ${existingName}. Remova ou use esse rascunho antes de preparar ${versionString}.`,
        );
      }
      version = await createVersion(appId, versionString);
    }

    await apple(`/v1/appStoreVersions/${version.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appStoreVersions",
          id: version.id,
          attributes: { releaseType: "MANUAL" },
        },
      },
    });
    await attachBuild(version.id, build.id);
    await ensureWhatsNew(version.id, releaseNotesFor(app), false);
    await ensurePhased(version.id);

    const versionName = version.attributes.versionString ?? versionString;
    const buildLabel = formatAppBuild(marketing ?? versionString, build.attributes.version ?? null);
    return `Rascunho ${versionName} criado com build ${buildLabel}.`;
  });
}

export async function reviewIos(app: AppConfig, notes?: string): Promise<string> {
  const appId = app.iosAppId;
  if (!appId) throw new Error("App sem iosAppId.");
  return serialize(`ios:${appId}`, async () => {
    const versions = await listVersions(appId);
    const version = versions.find(
      (item) => EDITABLE.has(item.attributes.appStoreState ?? "") && marketingVersion(item.attributes.versionString),
    );
    if (!version) throw new Error("Prepare a versão antes de enviar.");

    const versionName = marketingVersion(version.attributes.versionString);
    if (!versionName) throw new Error("Prepare a versão antes de enviar.");

    let storeBuild = await versionBuild(version.id);
    if (!storeBuild || storeBuild.attributes.processingState !== "VALID") {
      const builds = await listBuilds(appId);
      const matched = await resolveValidBuild(builds, versionName, null);
      if (!matched) {
        throw new Error(
          storeBuild
            ? "O build do rascunho ainda não está válido. Espere o processamento ou use Preparar versão."
            : "O rascunho não tem build. Use Preparar versão antes de enviar.",
        );
      }
      await attachBuild(version.id, matched.build.id);
      storeBuild = matched.build;
    }

    await apple(`/v1/appStoreVersions/${version.id}`, {
      method: "PATCH",
      body: {
        data: {
          type: "appStoreVersions",
          id: version.id,
          attributes: { releaseType: "MANUAL" },
        },
      },
    });
    const typed = notes?.trim();
    await ensureWhatsNew(version.id, releaseNotesFor(app, notes), Boolean(typed && typed !== defaultReleaseNotes()));
    await ensurePhased(version.id);
    await apple("/v1/appStoreVersionSubmissions", {
      method: "POST",
      body: {
        data: {
          type: "appStoreVersionSubmissions",
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
          },
        },
      },
    });

    return `Versão ${versionName} enviada para revisão. A liberação será faseada em 7 dias.`;
  });
}

async function resolveValidBuild(
  builds: readonly BuildResource[],
  requiredMarketing: string | null,
  liveName: string | null,
): Promise<{ build: BuildResource; marketing: string } | null> {
  for (const build of builds) {
    if (build.attributes.processingState !== "VALID") continue;
    const marketing = marketingVersion(await buildAppVersion(build));
    if (!marketing) continue;
    if (requiredMarketing && marketing !== requiredMarketing) continue;
    if (!requiredMarketing && liveName && compareVersions(marketing, liveName) <= 0) continue;
    return { build, marketing };
  }
  return null;
}

async function findNewerValidBuild(
  appId: string,
  liveName: string | null,
): Promise<{ label: string } | null> {
  const builds = await listBuilds(appId);
  const matched = await resolveValidBuild(builds, null, liveName);
  if (!matched) return null;
  return { label: formatAppBuild(matched.marketing, matched.build.attributes.version ?? null) };
}

export async function releaseIos(app: AppConfig): Promise<string> {
  const appId = app.iosAppId;
  if (!appId) throw new Error("App sem iosAppId.");
  return serialize(`ios:${appId}`, async () => {
    const versions = await listVersions(appId);
    const pending = versions.find((item) => item.attributes.appStoreState === "PENDING_DEVELOPER_RELEASE");
    if (pending) {
      await ensurePhased(pending.id);
      await apple("/v1/appStoreVersionReleaseRequests", {
        method: "POST",
        body: {
          data: {
            type: "appStoreVersionReleaseRequests",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: pending.id } },
            },
          },
        },
      });
      return `Versão ${pending.attributes.versionString ?? ""} em lançamento faseado de 7 dias.`;
    }

    for (const version of versions) {
      if (version.attributes.appStoreState !== "READY_FOR_SALE") continue;
      const phased = await readPhased(version.id);
      if (phased?.attributes.phasedReleaseState === "ACTIVE") {
        await updatePhased(phased.id, "COMPLETE");
        return `Versão ${version.attributes.versionString ?? ""} liberada para 100% dos usuários.`;
      }
    }
    for (const version of versions) {
      if (version.attributes.appStoreState !== "READY_FOR_SALE") continue;
      const phased = await readPhased(version.id);
      if (phased?.attributes.phasedReleaseState !== "PAUSED") continue;
      await updatePhased(phased.id, "ACTIVE");
      return "Lançamento faseado retomado.";
    }
    throw new Error("Nenhuma versão aprovada aguardando liberação.");
  });
}

export async function haltIos(app: AppConfig): Promise<string> {
  const appId = app.iosAppId;
  if (!appId) throw new Error("App sem iosAppId.");
  return serialize(`ios:${appId}`, async () => {
    const versions = await listVersions(appId);
    for (const version of versions) {
      if (version.attributes.appStoreState !== "READY_FOR_SALE") continue;
      const phased = await readPhased(version.id);
      if (phased?.attributes.phasedReleaseState !== "ACTIVE") continue;
      await updatePhased(phased.id, "PAUSED");
      return "Lançamento faseado pausado.";
    }
    throw new Error("Não há lançamento faseado em andamento para pausar.");
  });
}

async function readPhased(versionId: string): Promise<PhasedRelease | null> {
  try {
    const body = await apple<{ data?: PhasedRelease | null }>(
      `/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`,
    );
    return body.data ?? null;
  } catch (error) {
    if (error instanceof AppleHttpError && error.status === 404) return null;
    throw error;
  }
}

async function ensurePhased(versionId: string): Promise<void> {
  if (await readPhased(versionId)) return;
  await apple("/v1/appStoreVersionPhasedReleases", {
    method: "POST",
    body: {
      data: {
        type: "appStoreVersionPhasedReleases",
        attributes: { phasedReleaseState: "INACTIVE" },
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    },
  });
}

async function updatePhased(id: string, phasedReleaseState: "ACTIVE" | "PAUSED" | "COMPLETE"): Promise<void> {
  await apple(`/v1/appStoreVersionPhasedReleases/${id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "appStoreVersionPhasedReleases",
        id,
        attributes: { phasedReleaseState },
      },
    },
  });
}

function emptyIos(configured: boolean) {
  return {
    configured,
    versionString: null,
    appStoreState: null,
    releaseType: null,
    buildVersion: null,
    buildState: "none" as const,
  };
}
