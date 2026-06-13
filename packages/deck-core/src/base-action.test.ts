/**
 * Tests for BaseAction flag-overlay duration auto-stop (issue #490).
 *
 * The harness mocks getController so the flag-overlay subscription
 * registers a callback the test can drive directly via fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAction } from "./base-action.js";
import type { IDeckActionContext, IDeckDidReceiveSettingsEvent, IDeckWillAppearEvent } from "./types.js";

type TelemetryCallback = (telemetry: { SessionFlags?: number } | undefined, isConnected: boolean) => void;

const { mockSubscribe, mockUnsubscribe, getCapturedCallback } = vi.hoisted(() => {
  let captured: TelemetryCallback | null = null;

  return {
    mockSubscribe: vi.fn((_id: string, cb: TelemetryCallback) => {
      captured = cb;
    }),
    mockUnsubscribe: vi.fn(() => {
      captured = null;
    }),
    getCapturedCallback: () => captured,
  };
});

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
}));

vi.mock("./sdk-singleton.js", () => ({
  getController: () => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
  }),
}));

vi.mock("./global-settings.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  return {
    ...actual,
    getGlobalSettings: mockGetGlobalSettings,
    onGlobalSettingsChange: vi.fn(() => () => {}),
  };
});

// iRacing flag bitfield values used by resolveAllActiveFlags.
// Mirrors @iracedeck/iracing-native Flags enum (Yellow = 0x08, Blue = 0x20).
const FLAG_YELLOW = 0x08;
const FLAG_BLUE = 0x20;

class TestAction extends BaseAction {
  // Expose the protected `flagOverlayActive` set for assertions.
  getOverlayActive(): Set<string> {
    return (this as unknown as { flagOverlayActive: Set<string> }).flagOverlayActive;
  }

  // Expose protected setKeyImage so tests can register a context — the
  // overlay code skips contexts that aren't in `this.contexts`.
  registerKey(ev: IDeckWillAppearEvent<Record<string, unknown>>, svg: string): Promise<void> {
    return (this as unknown as { setKeyImage: (e: unknown, s: string) => Promise<void> }).setKeyImage(ev, svg);
  }
}

interface TestContext {
  action: TestAction;
  fakeAction: IDeckActionContext;
  setImageSpy: ReturnType<typeof vi.fn>;
  driveTelemetry: (sessionFlags: number | undefined) => void;
}

function createTestContext(): TestContext {
  const action = new TestAction();
  const setImageSpy = vi.fn().mockResolvedValue(undefined);
  const fakeAction: IDeckActionContext = {
    id: "ctx-1",
    isKey: () => true,
    isDial: () => false,
    setImage: setImageSpy,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
  };

  const willAppear = {
    action: fakeAction,
    payload: { settings: {} },
  } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

  // Synchronous part of onWillAppear runs before the function's first await
  // (skipped here because plugin-config is not initialized in tests). Safe
  // to fire-and-forget.
  void action.onWillAppear(willAppear);

  // Register the context in `this.contexts` so applyFlagOverlayToContexts
  // can find it. Synchronous side effect (contexts.set) happens before the
  // awaited setImage call, so void-await is safe here too.
  void action.registerKey(willAppear, "<svg/>");

  // Opt the context into flag overlay + ensure telemetry subscription registers.
  const settingsEvent = {
    action: fakeAction,
    payload: { settings: { flagsOverlay: true } },
  } as unknown as IDeckDidReceiveSettingsEvent<Record<string, unknown>>;

  void action.onDidReceiveSettings(settingsEvent);

  return {
    action,
    fakeAction,
    setImageSpy,
    driveTelemetry: (sessionFlags) => {
      const cb = getCapturedCallback();

      if (!cb) throw new Error("Telemetry callback was never captured — subscription did not register");

      cb(sessionFlags === undefined ? undefined : { SessionFlags: sessionFlags }, sessionFlags !== undefined);
    },
  };
}

describe("BaseAction flag flash duration (issue #490)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({ flagFlashDurationSeconds: 5 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-stops the flash after flagFlashDurationSeconds", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });

  it("does not auto-stop when flagFlashDurationSeconds is 0 (forever)", () => {
    mockGetGlobalSettings.mockReturnValue({ flagFlashDurationSeconds: 0 });

    const ctx = createTestContext();
    ctx.driveTelemetry(FLAG_YELLOW);

    // Advance well past the default duration; flash must still be active.
    vi.advanceTimersByTime(60_000);

    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);
  });

  it("restarts the auto-stop timer on a new flag transition", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    vi.advanceTimersByTime(4000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    // New transition (Yellow + Blue is a different state-key than Yellow alone).
    ctx.driveTelemetry(FLAG_YELLOW | FLAG_BLUE);

    // 4000 ms after the FIRST trigger, but only 0 ms into the SECOND window.
    vi.advanceTimersByTime(4000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    // Another 1500 ms (5500 ms into the second window) — now past the limit.
    vi.advanceTimersByTime(1500);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });

  it("does not retrigger when the same flag continues in telemetry after auto-stop", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    vi.advanceTimersByTime(5000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);

    const callsBeforeRetick = ctx.setImageSpy.mock.calls.length;

    // Same telemetry value comes in again — onFlagTelemetryUpdate should
    // short-circuit because lastFlagStateKey is still "YELLOW".
    ctx.driveTelemetry(FLAG_YELLOW);

    expect(ctx.setImageSpy.mock.calls.length).toBe(callsBeforeRetick);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });

  it("restarts the flash when the same flag returns after a clear", () => {
    const ctx = createTestContext();

    ctx.driveTelemetry(FLAG_YELLOW);
    vi.advanceTimersByTime(5000); // auto-stop fires

    ctx.driveTelemetry(0); // flags clear → stopFlagFlash() resets cache

    ctx.driveTelemetry(FLAG_YELLOW); // fresh transition — should retrigger
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);
  });
});
