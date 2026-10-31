import { VOICE_LABELS_KEY, VOICE_PACKS_KEY } from "@iracedeck/app-constants";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { InstalledVoicePack, VoicePackServiceDeps } from "@iracedeck/voice-packs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdapter } from "../../test-support/fake-host.js";
import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import { buildVoicePackScan } from "./scan.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-service", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-scenarios", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

const PACKS: InstalledVoicePack[] = [
  {
    id: "default",
    label: "Default",
    version: "1.0.0",
    dir: "C:/packs/default",
    voices: [{ id: "default::default", packVoiceId: "default", label: "Default", script: null }],
    clips: [],
    provenance: "catalog",
  },
  {
    id: "staged",
    label: "Staged",
    version: "0.0.1",
    dir: "C:/dev/staged",
    voices: [],
    clips: [],
    provenance: "development",
  },
];

/**
 * Build the scan over a fake service that captures its deps; nothing is
 * scanned until a test calls a captured callback. `settings.initialised` and
 * `engine.initialised` are read live.
 */
function setup({ devRoot }: { devRoot?: string } = {}) {
  const settings = { initialised: true };
  const engine = { initialised: false };
  const writes: Record<string, unknown>[] = [];
  const report = vi.fn();
  const fs = { name: "scanner fs" };
  const scripts = new Map<string, CalloutScript>([["default::default", stub("script")]]);
  let deps: VoicePackServiceDeps | undefined;
  const service = {
    installed: () => PACKS,
    problems: () => [{ pack: "broken", reason: "no voice-pack.json" }],
    scripts: () => scripts,
  };
  implement("createVoiceScriptWarningReporter", () => report);
  implement("createVoicePackFileSystem", () => fs);
  implement("createVoicePackService", (d) => {
    deps = d as VoicePackServiceDeps;

    return service;
  });
  implement("resolveVoicePacksPath", () => "C:/packs");
  implement("getDevVoicePacksRoot", () => devRoot);
  implement("isGlobalSettingsInitialized", () => settings.initialised);
  implement("isAudioScenariosInitialized", () => engine.initialised);
  implement("updateGlobalSettings", (partial) => writes.push(partial as Record<string, unknown>));
  implement("scanRaceEngineerVoices", () => ["default::default"]);
  implement("scanDriverNames", () => ["adam"]);
  implement("mergeManifests", () => ({ merged: true }));
  implement("orderRaceEngineerVoices", (voices) => [...(voices as string[])].reverse());
  implement("voiceDisplayLabels", () => ({ "default::default": "iRaceDeck: Default" }));
  implement("resolveActiveRaceEngineerVoice", () => "default::default");
  implement("isManagedVoicePack", (id) => id === "default" || id === "staged");
  implement("migrateRaceEngineerVoiceId", () => undefined);

  const adapter = createFakeAdapter();
  const scan = buildVoicePackScan({ adapter }, { rootDir: "C:/plugin/assets/audio" });

  if (deps === undefined) throw new Error("createVoicePackService was not called");

  return { scan, deps, adapter, settings, engine, writes, report, fs };
}

const keysOf = (writes: Record<string, unknown>[]): string[] => writes.flatMap((w) => Object.keys(w));

describe("buildVoicePackScan (#1377)", () => {
  beforeEach(() => resetRecorder());

  it("builds the banner reporter, the VoicePacks logger and then the service, and scans nothing", () => {
    const { adapter } = setup();

    expect(callLog.filter((n) => /^create/.test(n))).toEqual([
      "createVoiceScriptWarningReporter",
      "createVoicePackFileSystem",
      "createVoicePackService",
    ]);
    expect(adapter.scopes).toEqual(["VoicePacks"]);
    expect(callLog, "the startup scan is the phase's call").not.toContain("createVoicePackService().refresh");
  });

  it("starts its state from the compiled-in manifest, with nothing published", () => {
    const { scan } = setup();

    expect(scan.state.raceEngineerVoices).toEqual(["default::default"]);
    expect(scan.state.driverNames).toEqual(["adam"]);
    expect(scan.state.activeScripts.size).toBe(0);
    expect(scan.state.lastPublished).toEqual({
      voiceList: "",
      voiceLabels: "",
      driverNames: "",
      packList: "",
      status: "",
    });
  });

  it("hands the service the packs folder, the scanner port, the logger and the plugin's audio directory", () => {
    const { scan, deps, fs } = setup();

    expect(deps.root).toBe("C:/packs");
    expect(scan.voicePacksRoot).toBe("C:/packs");
    expect(deps.fs).toBe(fs);
    expect(scan.fs).toBe(fs);
    expect(deps.logger).toBe(scan.logger);
    expect(deps.pluginAudioDir).toBe("C:/plugin/assets/audio");
    expect(deps).not.toHaveProperty("devRoot");
    expect(scan.devVoicePacksRoot).toBeUndefined();
  });

  it("passes the development root when the build carries one", () => {
    const { scan, deps } = setup({ devRoot: "C:/dev/voices" });

    expect(deps.devRoot).toBe("C:/dev/voices");
    expect(scan.devVoicePacksRoot).toBe("C:/dev/voices");
  });

  it("applies a scan's roots to the audio service", () => {
    const { deps } = setup();

    deps.applyRoots([]);

    expect(callLog).toContain("getAudio().setRoots");
  });

  it("merges a scan's manifest into state, and reloads the engine only once it exists", () => {
    const { scan, deps, engine } = setup();

    deps.applyManifest([]);
    expect(scan.state.activeManifest).toEqual({ merged: true });
    expect(callLog, "the startup scan precedes the engine").not.toContain("getScenarioEngine().setManifest");

    engine.initialised = true;
    deps.applyManifest([]);
    expect(callLog).toContain("getScenarioEngine().setManifest");
  });

  it("holds a scan's scripts in state, and reloads the engine only once it exists", () => {
    const { scan, deps, engine } = setup();
    const scripts = new Map<string, CalloutScript>();

    deps.applyScripts(scripts);
    expect(scan.state.activeScripts).toBe(scripts);
    expect(callLog).not.toContain("getScenarioEngine().setScripts");

    engine.initialised = true;
    deps.applyScripts(scripts);
    expect(callLog).toContain("getScenarioEngine().setScripts");
  });

  it("orders the voices on every scan, and publishes nothing before the settings exist", () => {
    const { scan, deps, settings, writes, report } = setup();
    settings.initialised = false;
    scan.state.raceEngineerVoices = ["a", "b"];

    deps.onPacksChanged();

    expect(scan.state.raceEngineerVoices).toEqual(["b", "a"]);
    expect(writes).toEqual([]);
    expect(callLog).not.toContain("migrateRaceEngineerVoiceId");
    expect(report).not.toHaveBeenCalled();
  });

  it("publishes a scan once the settings exist: the three pushes, the voice id migration, then the banner", () => {
    const { deps, writes, report } = setup();

    deps.onPacksChanged();

    expect(keysOf(writes)).toEqual(["_raceEngineerVoices", VOICE_LABELS_KEY, "_driverNames", VOICE_PACKS_KEY]);
    expect(callLog.filter((n) => n === "migrateRaceEngineerVoiceId" || n === "updateGlobalSettings")).toEqual([
      "updateGlobalSettings",
      "updateGlobalSettings",
      "updateGlobalSettings",
      "migrateRaceEngineerVoiceId",
    ]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("writes the voice list and its labels in one write, and dedupes an unchanged push", () => {
    const { scan, writes } = setup();

    scan.push.raceEngineerVoices();
    scan.push.raceEngineerVoices();

    expect(writes).toEqual([
      {
        _raceEngineerVoices: JSON.stringify(["default::default"]),
        [VOICE_LABELS_KEY]: JSON.stringify({ "default::default": "iRaceDeck: Default" }),
      },
    ]);
  });

  it("dedupes the driver names", () => {
    const { scan, writes } = setup();

    scan.push.driverNames();
    scan.push.driverNames();

    expect(writes).toEqual([{ _driverNames: JSON.stringify(["adam"]) }]);
  });

  it("publishes the pack list with its problems, voices by id and label only", () => {
    const { scan, writes } = setup();

    scan.push.packList();
    scan.push.packList();

    expect(writes, "an unchanged list is deduped").toHaveLength(1);
    const payload = JSON.parse(writes[0]?.[VOICE_PACKS_KEY] as string);
    expect(payload.problems).toEqual([{ pack: "broken", reason: "no voice-pack.json" }]);
    expect(payload.packs[0]).toEqual({
      id: "default",
      label: "Default",
      version: "1.0.0",
      voices: [{ id: "default::default", label: "Default" }],
      provenance: "catalog",
      managed: true,
    });
  });

  it("publishes a pack's dir only on a development row, which never claims to be managed", () => {
    const { scan, writes } = setup();

    scan.push.packList();
    const packs = JSON.parse(writes[0]?.[VOICE_PACKS_KEY] as string).packs as {
      id: string;
      dir?: string;
      managed: boolean;
    }[];

    expect(packs.find((p) => p.id === "default")).not.toHaveProperty("dir");
    expect(packs.find((p) => p.id === "staged")?.dir).toBe("C:/dev/staged");
    expect(packs.find((p) => p.id === "staged")?.managed).toBe(false);
  });

  it("re-asserts the banner against the active voice, the scripted voices and the dropdown's labels", () => {
    const { scan, report } = setup();

    scan.reassertVoiceScriptWarning();

    expect(report).toHaveBeenCalledExactlyOnceWith({
      activeVoice: "default::default",
      scriptedVoices: new Set(["default::default"]),
      labels: { "default::default": "iRaceDeck: Default" },
    });
  });
});
