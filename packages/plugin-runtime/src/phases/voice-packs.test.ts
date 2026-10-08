import { VOICE_LABELS_KEY, VOICE_PACK_STATUS_KEY, VOICE_PACKS_KEY } from "@iracedeck/app-constants";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initAudio } from "./audio.js";
import { initCore } from "./core.js";
import { initVoicePacks } from "./voice-packs.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/voice-packs", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/deck-iracing", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/event-bus", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/sim-events-iracing", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-service", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/audio-scenarios", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/rasterizer", async () => (await import("../test-support/module-mocks.js")).rasterizerMock());
vi.mock("@iracedeck/race-engineer-wiring", async () =>
  (await import("../test-support/module-mocks.js")).raceEngineerWiringMock(),
);
vi.mock("../actions.js", async () => (await import("../test-support/module-mocks.js")).actionsMock());

type ServiceDeps = { onPacksChanged: () => void; applyManifest: (fragments: unknown) => void };

/**
 * Wire a fake voice-pack service whose refresh() runs the scan callbacks, and
 * capture every global-settings write. `settings.initialised` is read live, so
 * a test can flip it after the startup scan.
 */
function setup(initialised: boolean) {
  const settings = { initialised };
  const writes: Record<string, unknown>[] = [];
  let deps: ServiceDeps | undefined;
  const refresh = vi.fn(() => {
    deps?.applyManifest([]);
    deps?.onPacksChanged();
  });
  implement("isGlobalSettingsInitialized", () => settings.initialised);
  implement("updateGlobalSettings", (partial) => writes.push(partial as Record<string, unknown>));
  implement("scanRaceEngineerVoices", () => ["default::default"]);
  implement("scanDriverNames", () => ["adam"]);
  implement("orderRaceEngineerVoices", (voices) => voices);
  implement("voiceDisplayLabels", () => ({}));
  implement("migrateRaceEngineerVoiceId", () => undefined);
  implement("createVoicePackService", (d) => {
    deps = d as ServiceDeps;

    return {
      refresh,
      installed: () => [
        {
          id: "default",
          label: "Default",
          version: "1.0.0",
          voices: [{ id: "default::default", label: "Default" }],
          provenance: "catalog",
          dir: "C:/packs/default",
        },
        {
          id: "staged",
          label: "Staged",
          version: "0.0.1",
          voices: [],
          provenance: "development",
          dir: "C:/dev/staged",
        },
      ],
      problems: () => [],
      scripts: () => new Map(),
      isProvidedByDevRoot: () => false,
    };
  });
  const host = createHost();
  const core = initCore(host);
  const audio = initAudio(core);
  host.adapter.scopes.length = 0;
  callLog.length = 0;
  const voicePacks = initVoicePacks(core, audio);

  return { settings, writes, voicePacks, host, refresh, rescan: () => voicePacks.service.refresh() };
}

const keysOf = (writes: Record<string, unknown>[]): string[] => writes.flatMap((w) => Object.keys(w));

describe("initVoicePacks (#1104)", () => {
  beforeEach(() => resetRecorder());
  afterAll(() => cleanupTempBinDirs());

  it("runs the startup scan before initGlobalSettings without writing anything", () => {
    const { writes } = setup(false);

    expect(callLog).toContain("createVoicePackService");
    expect(writes).toEqual([]);
  });

  it("publishes a scan once settings exist, with its dedupe state already in place (no TDZ)", () => {
    const { writes, rescan } = setup(true);

    // The startup refresh inside initVoicePacks already published (initialised = true here).
    expect(keysOf(writes)).toEqual(
      expect.arrayContaining(["_raceEngineerVoices", VOICE_LABELS_KEY, "_driverNames", VOICE_PACKS_KEY]),
    );
    const count = writes.length;
    rescan();
    expect(writes.length, "an unchanged rescan is deduped").toBe(count);
  });

  it("leaves the dedupe markers untouched by the pre-init scan, so the post-init push still publishes", () => {
    const { settings, writes, voicePacks } = setup(false);

    // The startup scan ran (the service was built and refreshed) and published nothing.
    expect(callLog).toContain("orderRaceEngineerVoices");
    expect(writes).toEqual([]);
    expect(voicePacks.state.lastPublished).toEqual({
      voiceList: "",
      voiceLabels: "",
      driverNames: "",
      packList: "",
      status: "",
    });

    // What `startServices` does once `initGlobalSettings` has run.
    settings.initialised = true;
    voicePacks.push.raceEngineerVoices();
    voicePacks.push.driverNames();
    voicePacks.push.packList();

    expect(keysOf(writes)).toEqual(["_raceEngineerVoices", VOICE_LABELS_KEY, "_driverNames", VOICE_PACKS_KEY]);
    expect(voicePacks.state.lastPublished.voiceList).toBe(JSON.stringify(["default::default"]));
    expect(voicePacks.state.lastPublished.driverNames).toBe(JSON.stringify(["adam"]));
  });

  it("publishes a pack's dir only on a development row", () => {
    const { writes } = setup(true);
    const packs = JSON.parse(writes.find((w) => VOICE_PACKS_KEY in w)?.[VOICE_PACKS_KEY] as string).packs as {
      id: string;
      dir?: string;
    }[];

    expect(packs.find((p) => p.id === "default")).toBeDefined();
    expect(packs.find((p) => p.id === "default")).not.toHaveProperty("dir");
    expect(packs.find((p) => p.id === "staged")?.dir).toBe("C:/dev/staged");
  });

  it("dedupes the installer's published status", () => {
    let publish: ((status: unknown) => void) | undefined;
    implement("createVoicePackInstaller", (d) => {
      publish = (d as { publishStatus: (s: unknown) => void }).publishStatus;

      return {};
    });
    const { writes, voicePacks } = setup(true);
    const before = writes.length;

    publish?.({ default: "installed" });
    publish?.({ default: "installed" });

    expect(writes.slice(before)).toEqual([{ [VOICE_PACK_STATUS_KEY]: JSON.stringify({ default: "installed" }) }]);
    expect(voicePacks.state.lastPublished.status).toBe(JSON.stringify({ default: "installed" }));
  });

  it("refuses to remove the managed pack from the settings window", () => {
    implement("isManagedVoicePack", (id) => id === "default");
    const { voicePacks } = setup(true);
    callLog.length = 0;

    voicePacks.windowCommands.removeVoicePack("default");
    expect(callLog).not.toContain("createVoicePackInstaller().remove");

    // Positive control: any other pack does reach the installer.
    voicePacks.windowCommands.removeVoicePack("other");
    expect(callLog).toContain("createVoicePackInstaller().remove");
  });

  it("rescans and pokes the launch step on the window's Rescan, and asks the catalog on refreshCatalog", () => {
    const { voicePacks, refresh } = setup(true);
    callLog.length = 0;
    refresh.mockClear();

    voicePacks.windowCommands.refreshVoicePacks();
    expect(refresh).toHaveBeenCalledTimes(1);
    voicePacks.windowCommands.installVoicePack("terse");
    voicePacks.refreshCatalog();

    expect(callLog.filter((n) => n.startsWith("createVoicePack"))).toEqual([
      "createVoicePackLaunchStep().poke",
      "createVoicePackInstaller().install",
      "createVoicePackInstaller().refreshCatalog",
    ]);
  });

  it("creates its loggers under the VoicePacks and VoicePackCatalog scopes", () => {
    const { host } = setup(false);

    expect(host.adapter.scopes).toEqual(["VoicePacks", "VoicePackCatalog"]);
  });
});
