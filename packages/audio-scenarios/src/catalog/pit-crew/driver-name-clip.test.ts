import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../manifest.js";
import { driverNameClipPath } from "./driver-name-clip.js";

const engineState = vi.hoisted(() => ({
  recordedBases: vi.fn((): ReadonlySet<string> => new Set(["geoff"])),
  initialized: true,
  manifest: { clips: [] as string[], ambientLoop: "", ticks: { open: "", close: "" } },
}));

vi.mock("../../interpreter.js", () => ({
  isAudioScenariosInitialized: () => engineState.initialized,
  getScenarioEngine: () => ({
    currentManifest: (): AudioAssetsManifest => engineState.manifest,
    // The ACTIVE voice's names — here a voice that records `geoff` — which
    // the path players must never consult (issue #1580).
    recordedBases: engineState.recordedBases,
  }),
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

  describe("alias spellings (#1580)", () => {
    it("plays the canonical's clip for an alias in a voice that records only the canonical", () => {
      engineState.manifest.clips = ["voice/luca/names/jeff-01.mp3"];

      expect(driverNameClipPath("luca", "geoff")).toBe("voice/luca/names/jeff-01.mp3");
    });

    it("plays the voice's own clip for the alias spelling when the voice records it", () => {
      engineState.manifest.clips = ["voice/snoop/names/geoff.mp3", "voice/snoop/names/jeff.mp3"];

      expect(driverNameClipPath("snoop", "geoff")).toBe("voice/snoop/names/geoff.mp3");
    });

    it("resolves against the voice it is passed while the engine's active voice is another", () => {
      // The engine's active voice records `geoff`; the voice about to play,
      // `luca`, records only `jeff`, so Geoff is spoken from luca's `jeff`.
      engineState.manifest.clips = ["voice/luca/names/jeff.mp3", "voice/snoop/names/geoff.mp3"];

      expect(driverNameClipPath("luca", "geoff")).toBe("voice/luca/names/jeff.mp3");
      expect(engineState.recordedBases).not.toHaveBeenCalled();
    });

    it("falls back to the spelling's bare path when the voice records neither", () => {
      engineState.manifest.clips = ["voice/snoop/names/jeff.mp3"];

      expect(driverNameClipPath("luca", "geoff")).toBe("voice/luca/names/geoff.mp3");
    });
  });
});
