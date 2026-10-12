import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readFastestLapSearchDelayMs,
  readReplayJumpTimeoutMs,
  RECORD_JUMP_MIN_TIMEOUT_MS,
  REPLAY_JUMP_MAX_WAIT_MS,
  REPLAY_JUMP_POLL_MS,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "./replay-timing.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: mockGetGlobalSettings,
}));

function setDelay(value: unknown): void {
  mockGetGlobalSettings.mockReturnValue({ fastestLapSearchDelayMs: value });
}

describe("replay-timing", () => {
  beforeEach(() => {
    mockGetGlobalSettings.mockReset();
    mockGetGlobalSettings.mockReturnValue({});
  });

  describe("readFastestLapSearchDelayMs", () => {
    it("reads the setting, a number or the numeric string a slider stores", () => {
      setDelay(650);
      expect(readFastestLapSearchDelayMs()).toBe(650);

      setDelay("250");
      expect(readFastestLapSearchDelayMs()).toBe(250);
    });

    it("clamps to the accepted 50 to 1000 ms", () => {
      setDelay(10);
      expect(readFastestLapSearchDelayMs()).toBe(50);

      setDelay(5000);
      expect(readFastestLapSearchDelayMs()).toBe(1000);
    });

    it.each([undefined, "abc", {}, Number.NaN])("falls back to 400 ms for %s", (value) => {
      setDelay(value);

      expect(readFastestLapSearchDelayMs()).toBe(400);
    });
  });

  describe("readReplayJumpTimeoutMs", () => {
    it("is the walk's delay × 4, and never under three seconds", () => {
      expect(STABILIZATION_TIMEOUT_MULTIPLIER).toBe(4);
      expect(RECORD_JUMP_MIN_TIMEOUT_MS).toBe(3000);

      setDelay(50);
      expect(readReplayJumpTimeoutMs()).toBe(3000);

      setDelay(400);
      expect(readReplayJumpTimeoutMs()).toBe(3000);

      setDelay(750);
      expect(readReplayJumpTimeoutMs()).toBe(3000);

      setDelay(1000);
      expect(readReplayJumpTimeoutMs()).toBe(4000);
    });
  });

  it("polls a jump faster than the walk, and caps a landing that never comes", () => {
    expect(REPLAY_JUMP_POLL_MS).toBeLessThan(STABILIZATION_POLL_INTERVAL_MS);
    // A 24 h recording at 2048 frames per 60 Hz update is about 42 s of seeking.
    expect(REPLAY_JUMP_MAX_WAIT_MS).toBeGreaterThan(((24 * 3600 * 60) / (2048 * 60)) * 1000);
  });
});
