import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyDialReleaseForHost } from "./dial-release.js";

describe("classifyDialReleaseForHost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("extended gestures on (Stream Deck+)", () => {
    it("classifies a quick release as short", () => {
      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1100, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("short");
    });

    it("classifies a release past the threshold as long", () => {
      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1500, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("long");
    });

    it("classifies a release after a pressed rotation as push-turn", () => {
      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 3000, rotatedWhilePressed: true, thresholdMs: 500 }),
      ).toBe("push-turn");
    });
  });

  describe("extended gestures off (Mirabox / Ulanzi)", () => {
    it("classifies a quick release as short", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1100, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("short");
    });

    it("never classifies a release as long, however long the hold", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 9000, rotatedWhilePressed: false, thresholdMs: 500 }),
      ).toBe("short");
    });

    it("still classifies a release after a pressed rotation as push-turn, so it fires nothing", () => {
      vi.stubGlobal("__FEATURE_DIAL_EXTENDED_GESTURES__", false);

      expect(
        classifyDialReleaseForHost({ pressStartMs: 1000, nowMs: 1100, rotatedWhilePressed: true, thresholdMs: 500 }),
      ).toBe("push-turn");
    });
  });
});
