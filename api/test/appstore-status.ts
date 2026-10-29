import * as assert from "assert";
import {
  findPreparingDraft,
  mapIosStatus,
  pickStoreVersion,
  type IosVersionCandidate,
} from "../script/publishing/appstore-status";

describe("appstore-status", () => {
  const live: IosVersionCandidate = {
    id: "live",
    versionString: "6.5.1",
    appStoreState: "READY_FOR_SALE",
  };
  const draft: IosVersionCandidate = {
    id: "draft",
    versionString: "6.5.2",
    appStoreState: "PREPARE_FOR_SUBMISSION",
  };
  const rolling: IosVersionCandidate = {
    id: "live",
    versionString: "6.5.1",
    appStoreState: "READY_FOR_SALE",
    phasedReleaseState: "ACTIVE",
  };

  it("escolhe o rascunho Prepare quando a live não está em faseado", () => {
    const picked = pickStoreVersion([live, draft]);
    assert.equal(picked?.id, "draft");
  });

  it("prioriza o faseado ativo e ainda encontra o rascunho", () => {
    const versions = [rolling, draft];
    const picked = pickStoreVersion(versions);
    assert.equal(picked?.id, "live");
    assert.equal(findPreparingDraft(versions, "6.5.1")?.id, "draft");
  });

  it("devolve a live quando não há rascunho novo", () => {
    const picked = pickStoreVersion([live]);
    assert.equal(picked?.id, "live");
  });

  it("marca canPrepare quando há build novo sem rascunho", () => {
    const cell = mapIosStatus({
      configured: true,
      versionString: "6.5.1",
      appStoreState: "READY_FOR_SALE",
      releaseType: "MANUAL",
      buildVersion: "100",
      buildState: "valid",
      pendingBuildLabel: "6.5.2 (210)",
    });
    assert.equal(cell.status, "liberada");
    assert.equal(cell.canPrepare, true);
    assert.equal(cell.canReview, false);
    assert.ok(cell.detail.includes("Preparar versão"));
  });

  it("em faseado com rascunho pronto, mantém rolling e libera canReview", () => {
    const cell = mapIosStatus({
      configured: true,
      versionString: "6.5.1",
      appStoreState: "READY_FOR_SALE",
      releaseType: "MANUAL",
      buildVersion: "100",
      buildState: "valid",
      phasedReleaseState: "ACTIVE",
      currentDayNumber: 3,
      pendingDraftVersion: "6.5.2",
      pendingDraftBuildState: "valid",
    });
    assert.equal(cell.status, "aprovada");
    assert.equal(cell.inRollout, true);
    assert.equal(cell.canRelease, true);
    assert.equal(cell.canHalt, true);
    assert.equal(cell.canPrepare, false);
    assert.equal(cell.canReview, true);
    assert.ok(cell.detail.includes("Rascunho 6.5.2"));
  });

  it("build-only VALID pede Preparar versão", () => {
    const cell = mapIosStatus({
      configured: true,
      versionString: null,
      appVersion: "6.5.2",
      appStoreState: null,
      releaseType: null,
      buildVersion: "210",
      buildState: "valid",
    });
    assert.equal(cell.status, "pronta");
    assert.equal(cell.canPrepare, true);
    assert.equal(cell.canReview, false);
  });

  it("rascunho Prepare com build válido fica pronto para revisão", () => {
    const cell = mapIosStatus({
      configured: true,
      versionString: "6.5.2",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      releaseType: "MANUAL",
      buildVersion: "210",
      buildState: "valid",
    });
    assert.equal(cell.status, "pronta");
    assert.equal(cell.canReview, true);
    assert.equal(cell.canPrepare, false);
  });

  it("rascunho Prepare sem build fica Sem build selecionado", () => {
    const cell = mapIosStatus({
      configured: true,
      versionString: "6.5.2",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      releaseType: "MANUAL",
      buildVersion: null,
      buildState: "none",
    });
    assert.equal(cell.status, "sem_build");
    assert.equal(cell.label, "Sem build selecionado");
    assert.equal(cell.canPrepare, true);
  });
});
