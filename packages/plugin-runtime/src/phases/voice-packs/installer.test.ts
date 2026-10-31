import { emptyVoicePackStatus, VOICE_PACK_DEV_BASE_URL_KEY, VOICE_PACK_STATUS_KEY } from "@iracedeck/app-constants";
import { getPluginVersion } from "@iracedeck/deck-core";
import { silentLogger } from "@iracedeck/logger";
import { clearWarning, setWarning } from "@iracedeck/settings";
import type {
  BundledVoicePack,
  VoicePackCatalogServiceDeps,
  VoicePackInstallerDeps,
  VoicePackStorageDeps,
} from "@iracedeck/voice-packs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stopRaceEngineerPlayback } from "../../actions.js";
import { createFakeAdapter } from "../../test-support/fake-host.js";
import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import type { VoicePackState } from "../../types.js";
import { buildVoicePackInstaller } from "./installer.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("../../actions.js", async () => (await import("../../test-support/module-mocks.js")).actionsMock());

const ROOT = "C:/Users/test/AppData/Roaming/iRaceDeck/Voices";

/**
 * Build the installer over a fake scan, capturing the deps each voice-packs
 * factory received and every global-settings write.
 */
function setup(bundled: readonly BundledVoicePack[] = []) {
  const captured: {
    storage?: VoicePackStorageDeps;
    catalog?: VoicePackCatalogServiceDeps;
    installer?: VoicePackInstallerDeps;
  } = {};
  const storage = { packDir: (id: string) => `${ROOT}/${id}` };
  const catalog = { name: "catalog" };
  const product = { name: "installer" };
  const writes: Record<string, unknown>[] = [];
  implement("createVoicePackStorage", (d) => {
    captured.storage = d as VoicePackStorageDeps;

    return storage;
  });
  implement("createVoicePackCatalogService", (d) => {
    captured.catalog = d as VoicePackCatalogServiceDeps;

    return catalog;
  });
  implement("createVoicePackInstaller", (d) => {
    captured.installer = d as VoicePackInstallerDeps;

    return product;
  });
  implement("updateGlobalSettings", (partial) => writes.push(partial as Record<string, unknown>));

  const adapter = createFakeAdapter();
  const providedByDev = new Set<string>();
  const refresh = vi.fn(() => []);
  const state: Pick<VoicePackState, "lastPublished"> = {
    lastPublished: { voiceList: "", voiceLabels: "", driverNames: "", packList: "", status: "" },
  };
  const scan = {
    state,
    logger: { ...silentLogger },
    voicePacksRoot: ROOT,
    fs: stub("packFs"),
    service: { refresh, isProvidedByDevRoot: (id: string) => providedByDev.has(id) },
  };
  const installer = buildVoicePackInstaller({ adapter }, scan, bundled);
  const { storage: storageDeps, catalog: catalogDeps, installer: installerDeps } = captured;

  if (!storageDeps || !catalogDeps || !installerDeps) throw new Error("a voice-packs factory was not called");

  return {
    adapter,
    scan,
    state,
    writes,
    refresh,
    providedByDev,
    storage,
    catalog,
    product,
    installer,
    storageDeps,
    catalogDeps,
    installerDeps,
  };
}

describe("buildVoicePackInstaller (#1377)", () => {
  beforeEach(() => resetRecorder());

  it("builds storage, then the catalog under its own logger scope, then the installer it returns", () => {
    const { adapter, installer, product } = setup();

    expect(callLog.filter((n) => /^createVoicePack(Storage|CatalogService|Installer)$/.test(n))).toEqual([
      "createVoicePackStorage",
      "createVoicePackCatalogService",
      "createVoicePackInstaller",
    ]);
    expect(adapter.scopes).toEqual(["VoicePackCatalog"]);
    expect(installer).toBe(product);
  });

  it("roots storage at the scan's packs folder and hands the installer the scan's port, logger and the seedable packs", () => {
    const bundled: BundledVoicePack[] = [];
    const { scan, storage, catalog, storageDeps, installerDeps } = setup(bundled);

    expect(storageDeps.root).toBe(ROOT);
    expect(storageDeps.logger).toBe(scan.logger);
    expect(installerDeps.storage).toBe(storage);
    expect(installerDeps.packFs).toBe(scan.fs);
    expect(installerDeps.catalog).toBe(catalog);
    expect(installerDeps.bundled).toBe(bundled);
    expect(installerDeps.logger).toBe(scan.logger);
    expect(installerDeps.getPluginVersion).toBe(getPluginVersion);
    expect(installerDeps.stopPlayback).toBe(stopRaceEngineerPlayback);
    expect(installerDeps.warnings).toEqual({ set: setWarning, clear: clearWarning });
  });

  it("rescans through the scan's service after an install", () => {
    const { refresh, installerDeps } = setup();

    installerDeps.refreshPacks();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("dedupes the installer's published status", () => {
    const { writes, state, installerDeps } = setup();
    const status = emptyVoicePackStatus();

    installerDeps.publishStatus(status);
    installerDeps.publishStatus(emptyVoicePackStatus());

    expect(writes).toEqual([{ [VOICE_PACK_STATUS_KEY]: JSON.stringify(status) }]);
    expect(state.lastPublished.status).toBe(JSON.stringify(status));
  });

  it("asks the catalog unconditionally, with the plugin version", () => {
    const { catalogDeps } = setup();

    expect(catalogDeps.isEnabled()).toBe(true);
    expect(catalogDeps.getPluginVersion).toBe(getPluginVersion);
  });

  it("reads the installed digest through the scanner port, in the storage's pack directory", () => {
    const calls: unknown[][] = [];
    implement("readInstalledVoicePackSha", (...args) => {
      calls.push(args);

      return "abc123";
    });
    const { scan, catalogDeps } = setup();

    expect(catalogDeps.getInstalledSha("terse")).toBe("abc123");
    expect(calls).toEqual([[scan.fs, `${ROOT}/terse`, "terse"]]);
  });

  it("asks the service live whether the development root provides a pack", () => {
    const { providedByDev, catalogDeps } = setup();

    expect(catalogDeps.isProvidedByDevRoot?.("staged")).toBe(false);
    providedByDev.add("staged");
    expect(catalogDeps.isProvidedByDevRoot?.("staged")).toBe(true);
  });

  it("reads the development catalog URL fresh on each fetch, and only a string", () => {
    const settings: Record<string, unknown> = {};
    implement("getGlobalSettings", () => settings);
    const { catalogDeps } = setup();

    expect(catalogDeps.getDevBaseUrl?.()).toBeUndefined();
    settings[VOICE_PACK_DEV_BASE_URL_KEY] = 42;
    expect(catalogDeps.getDevBaseUrl?.(), "a non-string is ignored").toBeUndefined();
    settings[VOICE_PACK_DEV_BASE_URL_KEY] = "http://127.0.0.1:8080/";
    expect(catalogDeps.getDevBaseUrl?.()).toBe("http://127.0.0.1:8080/");
  });
});
