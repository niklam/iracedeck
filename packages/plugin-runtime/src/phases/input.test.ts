import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHost } from "../test-support/fake-host.js";
import { callLog, implement, resetRecorder } from "../test-support/recorder.js";
import { initCore } from "./core.js";
import { initInput } from "./input.js";

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

describe("initInput", () => {
  beforeEach(() => resetRecorder());
  afterEach(() => vi.unstubAllGlobals());

  it("builds the native layer, keyboard, clipboard, then the rasterizer when the flag is on", () => {
    const core = initCore(createHost());
    callLog.length = 0;

    const input = initInput(core);

    expect(callLog).toEqual([
      "new IRacingNative",
      "initializeKeyboard",
      "initializeClipboard",
      "createSvgRasterizer",
      "initializeRasterizer",
    ]);
    expect(input.native).toBeDefined();
  });

  it("leaves the rasterizer uninitialised when pngRasterization is off (#642)", () => {
    vi.stubGlobal("__FEATURE_PNG_RASTERIZATION__", false);
    const core = initCore(createHost());
    callLog.length = 0;

    initInput(core);

    expect(callLog).not.toContain("initializeRasterizer");
    expect(callLog).not.toContain("createSvgRasterizer");

    // Positive control: the same phase with the flag back on reaches both.
    vi.stubGlobal("__FEATURE_PNG_RASTERIZATION__", true);
    callLog.length = 0;
    initInput(core);
    expect(callLog).toContain("createSvgRasterizer");
    expect(callLog).toContain("initializeRasterizer");
  });

  it("survives a rasterizer that fails to start, falling back to SVG (#642)", () => {
    implement("createSvgRasterizer", () => {
      throw new Error("fonts missing");
    });

    expect(() => initInput(initCore(createHost()))).not.toThrow();
    // Positive control: the rasterizer was attempted, so the absence below is the fallback, not a skipped branch.
    expect(callLog).toContain("createSvgRasterizer");
    expect(callLog).not.toContain("initializeRasterizer");
  });
});
