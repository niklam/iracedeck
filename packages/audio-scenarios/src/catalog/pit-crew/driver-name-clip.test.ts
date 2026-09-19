import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../manifest.js";
import { driverNameClipPath } from "./driver-name-clip.js";

const engineState = vi.hoisted(() => ({
  initialized: true,
  manifest: { clips: [] as string[], ambientLoop: "", ticks: { open: "", close: "" } },
}));

vi.mock("../../interpreter.js", () => ({
  isAudioScenariosInitialized: () => engineState.initialized,
  getScenarioEngine: () => ({ currentManifest: (): AudioAssetsManifest => engineState.manifest }),
}));

describe("driverNameClipPath (#1173)", () => {
  beforeEach(() => {
    engineState.initialized = true;
    engineState.manifest = { clips: [], ambientLoop: "", ticks: { open: "", close: "" } };
  });

  it("plays a pack's take when the pack records the name only as takes", () => {
    engineState.manifest.clips = ["voice/snoop/names/niklas-01.mp3", "voice/snoop/names/niklas-02.mp3"];

    expect(driverNameClipPath("snoop", "niklas")).toBe("voice/snoop/names/niklas-01.mp3");
  });

  it("plays the bare clip when the voice has one", () => {
    engineState.manifest.clips = ["voice/default/names/niklas.mp3"];

    expect(driverNameClipPath("default", "niklas")).toBe("voice/default/names/niklas.mp3");
  });

  it("reads the manifest at call time, so an installed pack counts at once", () => {
    expect(driverNameClipPath("snoop", "adam")).toBe("voice/snoop/names/adam.mp3");

    engineState.manifest.clips = ["voice/snoop/names/adam-01.mp3"];

    expect(driverNameClipPath("snoop", "adam")).toBe("voice/snoop/names/adam-01.mp3");
  });

  it("falls back to the bare path when the voice has no clip for the name", () => {
    engineState.manifest.clips = ["voice/snoop/names/adam-01.mp3"];

    expect(driverNameClipPath("snoop", "niklas")).toBe("voice/snoop/names/niklas.mp3");
  });

  it("falls back to the bare path before the engine is initialized", () => {
    engineState.initialized = false;
    engineState.manifest.clips = ["voice/snoop/names/niklas-01.mp3"];

    expect(driverNameClipPath("snoop", "niklas")).toBe("voice/snoop/names/niklas.mp3");
  });
});
