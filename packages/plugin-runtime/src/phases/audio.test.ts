import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initAudio } from "./audio.js";
import { initCore } from "./core.js";

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

describe("initAudio", () => {
  beforeEach(() => resetRecorder());

  it("starts audio, registers the two gate listeners, then applies the audio state once", () => {
    const core = initCore(createHost());
    callLog.length = 0;

    initAudio(core);

    expect(callLog.filter((n) => n !== "getAudio" && n !== "pluginAudioSessionIdentity")).toEqual([
      "new AudioNative",
      "initializeAudio",
      "getAudio().init",
      "onGlobalSettingsChange",
      "onGlobalSettingsChange",
      "applyRadarVolume",
      "applyRadarEnabled",
      "applyRaceEngineerAudio",
    ]);
  });

  it("roots audio at <plugin>/assets/audio and hands back armFeatureGateSync", async () => {
    const roots: unknown[] = [];
    implement("initializeAudio", (_logger, _native, rootDirs) => roots.push(rootDirs));
    const host = createHost();

    const audio = initAudio(initCore(host));

    expect(roots).toEqual([[join(host.binDir, "..", "assets", "audio")]]);
    expect(audio.rootDir).toBe(join(host.binDir, "..", "assets", "audio"));
    expect(audio.armFeatureGateSync).toBe((await import("../actions.js")).armFeatureGateSync);
  });
});
