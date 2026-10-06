import { silentLogger } from "@iracedeck/logger";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initAudio } from "./audio.js";
import { initCore } from "./core.js";
import { initRaceEngineer } from "./race-engineer.js";
import { initSim } from "./sim.js";
import { initVoicePacks } from "./voice-packs.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
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

function phases() {
  const host = createHost();
  const core = initCore(host);
  const sim = initSim(core);
  const audio = initAudio(core);
  const voicePacks = initVoicePacks(core, audio);

  return { host, core, sim, audio, voicePacks };
}

describe("initRaceEngineer", () => {
  beforeEach(() => resetRecorder());
  afterAll(() => cleanupTempBinDirs());

  it("constructs the engine, wires the Race Engineer, then hands over the scripts — in that order", () => {
    const { core, sim, audio, voicePacks } = phases();
    callLog.length = 0;

    initRaceEngineer(core, sim, audio, voicePacks);

    expect(
      callLog.filter((n) =>
        ["initializeAudioScenarios", "wireRaceEngineer", "getScenarioEngine().setScripts"].includes(n),
      ),
    ).toEqual(["initializeAudioScenarios", "wireRaceEngineer", "getScenarioEngine().setScripts"]);
  });

  it("gives the wiring the bus, the RaceEngineer logger, the sim, the voice-pack state and no overrides", () => {
    const seen: { bus: unknown; deps: Record<string, unknown> }[] = [];
    implement("wireRaceEngineer", (bus, deps) => seen.push({ bus, deps: deps as Record<string, unknown> }));
    const { core, sim, audio, voicePacks } = phases();
    const raceEngineerLogger = { ...silentLogger };
    const createLogger = vi
      .spyOn(core.adapter, "createLogger")
      .mockImplementation((scope) => (scope === "RaceEngineer" ? raceEngineerLogger : silentLogger));

    initRaceEngineer(core, sim, audio, voicePacks);

    expect(createLogger).toHaveBeenCalledWith("RaceEngineer");
    expect(seen).toHaveLength(1);
    expect(seen[0].bus).toBe(core.bus);
    expect(Object.keys(seen[0].deps).sort(), "no overrides key at all").toEqual(["logger", "sim", "voice"]);
    expect(seen[0].deps.logger).toBe(raceEngineerLogger);
    expect(seen[0].deps.sim).toBe(sim);
    expect(seen[0].deps.voice, "the live state object, not a copy of its list").toBe(voicePacks.state);
  });

  it("builds the AudioScenarios and RaceEngineer loggers, in that order", () => {
    const { host, core, sim, audio, voicePacks } = phases();
    host.adapter.scopes.length = 0;

    initRaceEngineer(core, sim, audio, voicePacks);

    expect(host.adapter.scopes).toEqual(["AudioScenarios", "RaceEngineer"]);
  });

  it("gives the engine the bus, the active manifest, and a voice resolver that reads the live voice list", () => {
    const args: unknown[][] = [];
    implement("initializeAudioScenarios", (...a) => args.push(a));
    implement("resolveActiveRaceEngineerVoice", (voices) => voices);
    const { core, sim, audio, voicePacks } = phases();

    initRaceEngineer(core, sim, audio, voicePacks);

    expect(args).toHaveLength(1);
    const [bus, , manifest, , getActiveVoice, getFrameOptions] = args[0];
    expect(bus).toBe(core.bus);
    expect(manifest).toBe(voicePacks.state.activeManifest);
    expect(typeof getFrameOptions).toBe("function");

    // A rescan replaces the list on the state object; the resolver must see the new one.
    const rescanned = ["pack::voice"];
    voicePacks.state.raceEngineerVoices = rescanned;
    expect((getActiveVoice as () => unknown)()).toBe(rescanned);
  });

  it("hands the engine the scripts the startup scan stored", () => {
    const handed: unknown[] = [];
    implement("getScenarioEngine().setScripts", (scripts) => handed.push(scripts));
    const { core, sim, audio, voicePacks } = phases();

    initRaceEngineer(core, sim, audio, voicePacks);

    expect(handed).toHaveLength(1);
    expect(handed[0]).toBe(voicePacks.state.activeScripts);
  });
});
