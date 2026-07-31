/**
 * Tests for BaseAction flag-overlay duration auto-stop (issue #490).
 *
 * The harness mocks getController so the flag-overlay subscription
 * registers a callback the test can drive directly via fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAction } from "./base-action.js";
import type {
  IDeckActionContext,
  IDeckDidReceiveSettingsEvent,
  IDeckWillAppearEvent,
  IDeckWillDisappearEvent,
} from "./types.js";

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

const { mockGetCurrentTemplateContext } = vi.hoisted(() => ({
  mockGetCurrentTemplateContext: vi.fn(() => ({ display: {} as Record<string, string>, raw: {} })),
}));

vi.mock("./sdk-singleton.js", () => ({
  getController: () => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    getCurrentTemplateContext: mockGetCurrentTemplateContext,
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

  // Expose protected setRegenerateCallback for issue #642 reconciliation tests.
  registerRegenerateCallback(contextId: string, regenerate: () => string): void {
    return (this as unknown as { setRegenerateCallback: (id: string, r: () => string) => void }).setRegenerateCallback(
      contextId,
      regenerate,
    );
  }

  // Expose protected getKeyImage for issue #642 reconciliation tests.
  getStoredSvg(contextId: string): string | undefined {
    return (this as unknown as { getKeyImage: (id: string) => string | undefined }).getKeyImage(contextId);
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
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
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

describe("BaseAction regenerate-callback reconciliation (issue #642)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({});
  });

  function createReconciliationContext(): {
    action: TestAction;
    fakeAction: IDeckActionContext;
    setImageSpy: ReturnType<typeof vi.fn>;
  } {
    const action = new TestAction();
    const setImageSpy = vi.fn().mockResolvedValue(undefined);
    const fakeAction: IDeckActionContext = {
      id: "ctx-regen",
      isKey: () => true,
      isDial: () => false,
      setImage: setImageSpy,
      setTitle: vi.fn().mockResolvedValue(undefined),
      setSettings: vi.fn().mockResolvedValue(undefined),
      setFeedback: vi.fn().mockResolvedValue(undefined),
      setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
      setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    };

    return { action, fakeAction, setImageSpy };
  }

  it("reconciles the icon when settings changed during the setKeyImage() await, closing the startup race", async () => {
    const { action, fakeAction, setImageSpy } = createReconciliationContext();
    const willAppear = {
      action: fakeAction,
      payload: { settings: {} },
    } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

    // Simulates: render svg "A" (e.g. bindingMissing=true because the global
    // settings cache was empty), then setKeyImage's await lets a settings
    // change land before the regenerate callback is registered.
    await action.registerKey(willAppear, "A");
    expect(setImageSpy).toHaveBeenLastCalledWith("A");

    // Registration now reconciles: the settings arrived, so regenerate()
    // returns the corrected icon "B".
    action.registerRegenerateCallback(fakeAction.id, () => "B");

    expect(setImageSpy).toHaveBeenLastCalledWith("B");
    expect(action.getStoredSvg(fakeAction.id)).toBe("B");
  });

  it("does not push a second setImage when the regenerated icon is unchanged", async () => {
    const { action, fakeAction, setImageSpy } = createReconciliationContext();
    const willAppear = {
      action: fakeAction,
      payload: { settings: {} },
    } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

    await action.registerKey(willAppear, "A");
    expect(setImageSpy).toHaveBeenCalledTimes(1);

    action.registerRegenerateCallback(fakeAction.id, () => "A");

    expect(setImageSpy).toHaveBeenCalledTimes(1);
    expect(action.getStoredSvg(fakeAction.id)).toBe("A");
  });

  it("does not crash and keeps the stored svg when the regenerate callback throws", async () => {
    const { action, fakeAction, setImageSpy } = createReconciliationContext();
    const willAppear = {
      action: fakeAction,
      payload: { settings: {} },
    } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

    await action.registerKey(willAppear, "A");
    expect(setImageSpy).toHaveBeenCalledTimes(1);

    expect(() =>
      action.registerRegenerateCallback(fakeAction.id, () => {
        throw new Error("boom");
      }),
    ).not.toThrow();

    expect(action.getStoredSvg(fakeAction.id)).toBe("A");
    expect(setImageSpy).toHaveBeenCalledTimes(1);
  });

  it("stores the reconciled svg but skips the visual push while flag overlay is active", async () => {
    const { action, fakeAction, setImageSpy } = createReconciliationContext();
    const willAppear = {
      action: fakeAction,
      payload: { settings: {} },
    } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

    await action.registerKey(willAppear, "A");
    expect(setImageSpy).toHaveBeenCalledTimes(1);

    // Simulate an active flag flash for this context (same set the flag
    // overlay machinery uses to gate visual updates in updateKeyImage).
    action.getOverlayActive().add(fakeAction.id);

    action.registerRegenerateCallback(fakeAction.id, () => "B");

    expect(action.getStoredSvg(fakeAction.id)).toBe("B");
    expect(setImageSpy).toHaveBeenCalledTimes(1);
  });
});

describe("BaseAction title template live updates (issue #899)", () => {
  const CONTEXT_ID = "ctx-title";
  const TITLE_TEMPLATE_PREFIX = "__title_template__";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({});
    mockGetCurrentTemplateContext.mockReturnValue({ display: {}, raw: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTitleContext(titleText: string | undefined): {
    action: TestAction;
    fakeAction: IDeckActionContext;
    setImageSpy: ReturnType<typeof vi.fn>;
    driveTick: () => void;
  } {
    const action = new TestAction();
    const setImageSpy = vi.fn().mockResolvedValue(undefined);
    const fakeAction: IDeckActionContext = {
      id: CONTEXT_ID,
      isKey: () => true,
      isDial: () => false,
      setImage: setImageSpy,
      setTitle: vi.fn().mockResolvedValue(undefined),
      setSettings: vi.fn().mockResolvedValue(undefined),
      setFeedback: vi.fn().mockResolvedValue(undefined),
      setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
      setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    };
    const willAppear = {
      action: fakeAction,
      payload: { settings: titleText === undefined ? {} : { titleOverrides: { titleText } } },
    } as unknown as IDeckWillAppearEvent<Record<string, unknown>>;

    void action.onWillAppear(willAppear);
    void action.registerKey(willAppear, "<svg>initial</svg>");

    return {
      action,
      fakeAction,
      setImageSpy,
      driveTick: () => {
        const call = mockSubscribe.mock.calls.find(([id]) => String(id).startsWith(TITLE_TEMPLATE_PREFIX));

        if (!call) throw new Error("Title template callback was never captured — subscription did not register");

        (call[1] as () => void)();
      },
    };
  }

  function setDisplayValue(value: string | undefined): void {
    mockGetCurrentTemplateContext.mockReturnValue({
      display: value === undefined ? {} : { "self.car_number": value },
      raw: {},
    });
  }

  it("subscribes to telemetry when a context's user title contains a template", () => {
    createTitleContext("CAR {{self.car_number}}");

    expect(mockSubscribe.mock.calls.some(([id]) => String(id).startsWith(TITLE_TEMPLATE_PREFIX))).toBe(true);
  });

  it("does not subscribe for titles without templates", () => {
    createTitleContext("PLAIN TITLE");

    expect(mockSubscribe.mock.calls.some(([id]) => String(id).startsWith(TITLE_TEMPLATE_PREFIX))).toBe(false);
  });

  it("does not subscribe when no title override is set", () => {
    createTitleContext(undefined);

    expect(mockSubscribe.mock.calls.some(([id]) => String(id).startsWith(TITLE_TEMPLATE_PREFIX))).toBe(false);
  });

  it("re-renders through the regenerate callback when the resolved title changes", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    setDisplayValue("34");
    ctx.action.registerRegenerateCallback(CONTEXT_ID, () => {
      const context = mockGetCurrentTemplateContext();

      return `<svg>${context.display["self.car_number"] ?? ""}</svg>`;
    });
    expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>34</svg>");

    // Step past the 10 Hz window so the next change renders immediately.
    vi.advanceTimersByTime(200);
    setDisplayValue("35");
    ctx.driveTick();

    expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>35</svg>");
  });

  it("does not re-render when the resolved title is unchanged", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    setDisplayValue("34");
    ctx.action.registerRegenerateCallback(CONTEXT_ID, () => {
      const context = mockGetCurrentTemplateContext();

      return `<svg>${context.display["self.car_number"] ?? ""}</svg>`;
    });

    vi.advanceTimersByTime(200);
    ctx.driveTick();
    const callsAfterFirstTick = ctx.setImageSpy.mock.calls.length;

    vi.advanceTimersByTime(200);
    ctx.driveTick();

    expect(ctx.setImageSpy.mock.calls.length).toBe(callsAfterFirstTick);
  });

  it("coalesces rapid changes through the 10 Hz throttle and renders the latest value", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    setDisplayValue("34");
    ctx.action.registerRegenerateCallback(CONTEXT_ID, () => {
      const context = mockGetCurrentTemplateContext();

      return `<svg>${context.display["self.car_number"] ?? ""}</svg>`;
    });

    vi.advanceTimersByTime(200);
    setDisplayValue("35");
    ctx.driveTick();
    expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>35</svg>");
    const callsAfterImmediate = ctx.setImageSpy.mock.calls.length;

    // Second change inside the window — must coalesce, not render immediately.
    setDisplayValue("36");
    ctx.driveTick();
    expect(ctx.setImageSpy.mock.calls.length).toBe(callsAfterImmediate);

    // Trailing flush renders the latest value.
    vi.advanceTimersByTime(100);
    expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>36</svg>");
  });

  it("stops tracking when settings change to a non-templated title", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    const settingsEvent = {
      action: ctx.fakeAction,
      payload: { settings: { titleOverrides: { titleText: "PLAIN" } } },
    } as unknown as IDeckDidReceiveSettingsEvent<Record<string, unknown>>;

    void ctx.action.onDidReceiveSettings(settingsEvent);

    expect(mockUnsubscribe).toHaveBeenCalled();
  });

  it("unsubscribes when the last templated context disappears", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    const disappearEvent = {
      action: ctx.fakeAction,
      payload: { settings: {} },
    } as unknown as IDeckWillDisappearEvent<Record<string, unknown>>;

    void ctx.action.onWillDisappear(disappearEvent);

    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
