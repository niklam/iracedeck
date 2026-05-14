import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DUAL_PRESS_DIRECTIONS_FALLBACK,
  DUAL_PRESS_THRESHOLD_FALLBACK_MS,
  DualPressTracker,
  getDualPressDirections,
  getDualPressThresholdMs,
} from "./dual-press.js";
// Namespace import so the unrecognised-value test can spy on getGlobalSettings;
// the named bindings below keep the rest of the file unchanged.
import * as globalSettings from "./global-settings.js";
import type { IDeckPlatformAdapter } from "./types.js";

const { _resetGlobalSettings, initGlobalSettings, updateGlobalSettings } = globalSettings;

type EchoCallback = (settings: unknown) => void;

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

function createMockAdapter(): IDeckPlatformAdapter {
  let echo: EchoCallback | null = null;

  return {
    onDidReceiveGlobalSettings: (cb: EchoCallback) => {
      echo = cb;
    },
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(() => {
      echo?.({});
    }),
  } as unknown as IDeckPlatformAdapter;
}

describe("DualPressTracker", () => {
  let nowValue: number;
  const now = () => nowValue;

  beforeEach(() => {
    _resetGlobalSettings();
    initGlobalSettings(createMockAdapter(), createMockLogger());
    nowValue = 0;
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("returns undefined when key-down has not been recorded (stray key-up)", () => {
    const tracker = new DualPressTracker(now);
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBeUndefined();
  });

  it("returns tap outcome for presses below the threshold", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);
    nowValue = 1000;
    tracker.recordKeyDown("ctx");
    nowValue = 1100;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBe("tap");
  });

  it("returns long-press outcome at the threshold boundary", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);
    nowValue = 1000;
    tracker.recordKeyDown("ctx");
    nowValue = 1500;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBe("long");
  });

  it("returns long-press outcome above the threshold", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);
    nowValue = 1000;
    tracker.recordKeyDown("ctx");
    nowValue = 1800;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBe("long");
  });

  it("uses the live threshold from settings — slider change takes effect on the next press", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);

    nowValue = 1000;
    tracker.recordKeyDown("ctx");
    nowValue = 1400;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBe("tap");

    updateGlobalSettings({ dualPressThresholdMs: 300 });
    nowValue = 2000;
    tracker.recordKeyDown("ctx");
    nowValue = 2400;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBe("long");
  });

  it("consumes the pending timestamp on resolve (second resolve returns undefined)", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);
    nowValue = 1000;
    tracker.recordKeyDown("ctx");
    nowValue = 1800;
    tracker.computeOutcome("ctx", "tap", "long");

    nowValue = 5000;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBeUndefined();
  });

  it("tracks contexts independently", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);

    nowValue = 1000;
    tracker.recordKeyDown("a");
    nowValue = 1200;
    tracker.recordKeyDown("b");

    nowValue = 2100; // a held 1100 ms
    expect(tracker.computeOutcome("a", "tap", "long")).toBe("long");

    nowValue = 1300; // b held 100 ms relative to its 1200 ms keydown
    expect(tracker.computeOutcome("b", "tap", "long")).toBe("tap");
  });

  it("clear() drops the pending timestamp without firing", () => {
    updateGlobalSettings({ dualPressThresholdMs: 500 });
    const tracker = new DualPressTracker(now);
    nowValue = 1000;
    tracker.recordKeyDown("ctx");
    expect(tracker.hasPending("ctx")).toBe(true);

    tracker.clear("ctx");
    expect(tracker.hasPending("ctx")).toBe(false);

    nowValue = 5000;
    expect(tracker.computeOutcome("ctx", "tap", "long")).toBeUndefined();
  });
});

describe("getDualPressThresholdMs", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("falls back to 500 ms before initGlobalSettings runs", () => {
    expect(getDualPressThresholdMs()).toBe(DUAL_PRESS_THRESHOLD_FALLBACK_MS);
    expect(getDualPressThresholdMs()).toBe(500);
  });

  it("reflects the live value after updateGlobalSettings", () => {
    initGlobalSettings(createMockAdapter(), createMockLogger());
    updateGlobalSettings({ dualPressThresholdMs: 1200 });
    expect(getDualPressThresholdMs()).toBe(1200);
  });
});

describe("getDualPressDirections", () => {
  beforeEach(() => {
    _resetGlobalSettings();
  });

  afterEach(() => {
    _resetGlobalSettings();
  });

  it("falls back to tap-increases before initGlobalSettings runs", () => {
    expect(getDualPressDirections()).toBe(DUAL_PRESS_DIRECTIONS_FALLBACK);
    expect(getDualPressDirections()).toBe("tap-increases");
  });

  it("reflects the live value after updateGlobalSettings", () => {
    initGlobalSettings(createMockAdapter(), createMockLogger());
    updateGlobalSettings({ dualPressDirections: "tap-decreases" });
    expect(getDualPressDirections()).toBe("tap-decreases");
  });

  it("falls back when the stored value is unrecognised", () => {
    // The GlobalSettingsSchema enum rejects invalid values, so an unrecognised
    // dualPressDirections can only reach the reader if the settings cache is
    // bypassed. Stub getGlobalSettings directly to exercise the defensive branch.
    type Settings = ReturnType<typeof globalSettings.getGlobalSettings>;
    const spy = vi.spyOn(globalSettings, "getGlobalSettings");

    // Sanity check the spy is intercepting: "tap-decreases" is not the cache
    // default, so getting it back proves the reader read through the stub.
    spy.mockReturnValue({ dualPressDirections: "tap-decreases" } as unknown as Settings);
    expect(getDualPressDirections()).toBe("tap-decreases");

    // An unrecognised value resolves to the defensive fallback.
    spy.mockReturnValue({ dualPressDirections: "sideways" } as unknown as Settings);
    expect(getDualPressDirections()).toBe(DUAL_PRESS_DIRECTIONS_FALLBACK);

    spy.mockRestore();
  });
});
