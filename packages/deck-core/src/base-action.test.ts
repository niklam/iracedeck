/**
 * Tests for BaseAction flag-overlay duration auto-stop (issue #490).
 *
 * The harness serves a fake sim connection so the flag-overlay and title
 * subscriptions register callbacks the test can drive directly via fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAction } from "./base-action.js";
import { createFakeSimConnection, type FakeSimConnection } from "./fake-sim-connection.js";
import { _resetSimConnection, initializeSimConnection, type OverlayFlag } from "./sim-connection.js";
import type {
  IDeckActionContext,
  IDeckDidReceiveSettingsEvent,
  IDeckWillAppearEvent,
  IDeckWillDisappearEvent,
} from "./types.js";

// The real sim-connection singleton, initialised with a fake per test, so the
// pre-initialisation queue and its replay are exercised as they run in the plugin.
const sim: { fake: FakeSimConnection | null } = { fake: null };

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
}));

vi.mock("@iracedeck/settings", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;

  return {
    ...actual,
    getGlobalSettings: mockGetGlobalSettings,
    onGlobalSettingsChange: vi.fn(() => () => {}),
  };
});

const FLAG_YELLOW: OverlayFlag = { label: "YELLOW", color: "#f1c40f", textColor: "#1a1a1a", pulse: false };
const FLAG_BLUE: OverlayFlag = { label: "BLUE", color: "#3498db", textColor: "#ffffff", pulse: false };

beforeEach(() => {
  _resetSimConnection();
  sim.fake = createFakeSimConnection();
  initializeSimConnection(sim.fake.connection);
});

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
  driveFlags: (flags: OverlayFlag[]) => void;
}

/**
 * Make a key context appear on `action` with the flag overlay switched on, the
 * way the deck host does: appear, first image, then the settings that opt in.
 */
function appearWithFlagOverlay(
  action: TestAction,
  contextId: string,
): { fakeAction: IDeckActionContext; setImageSpy: ReturnType<typeof vi.fn> } {
  const setImageSpy = vi.fn().mockResolvedValue(undefined);
  const fakeAction: IDeckActionContext = {
    id: contextId,
    isKey: () => true,
    isDial: () => false,
    setImage: setImageSpy,
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setFeedbackLayout: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
    dialCanvas: () => null,
    setDialCanvas: vi.fn().mockResolvedValue(undefined),
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

  // Opt the context into flag overlay + ensure the flag subscription registers.
  const settingsEvent = {
    action: fakeAction,
    payload: { settings: { flagsOverlay: true } },
  } as unknown as IDeckDidReceiveSettingsEvent<Record<string, unknown>>;

  void action.onDidReceiveSettings(settingsEvent);

  return { fakeAction, setImageSpy };
}

function createTestContext(): TestContext {
  const action = new TestAction();
  const { fakeAction, setImageSpy } = appearWithFlagOverlay(action, "ctx-1");

  return {
    action,
    fakeAction,
    setImageSpy,
    driveFlags: (flags) => {
      if (sim.fake!.subscribers.size === 0) {
        throw new Error("Flag callback was never captured — subscription did not register");
      }

      sim.fake!.state.flags = flags;
      sim.fake!.tick();
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

    ctx.driveFlags([FLAG_YELLOW]);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    vi.advanceTimersByTime(5000);

    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });

  it("does not auto-stop when flagFlashDurationSeconds is 0 (forever)", () => {
    mockGetGlobalSettings.mockReturnValue({ flagFlashDurationSeconds: 0 });

    const ctx = createTestContext();
    ctx.driveFlags([FLAG_YELLOW]);

    // Advance well past the default duration; flash must still be active.
    vi.advanceTimersByTime(60_000);

    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);
  });

  it("restarts the auto-stop timer on a new flag transition", () => {
    const ctx = createTestContext();

    ctx.driveFlags([FLAG_YELLOW]);
    vi.advanceTimersByTime(4000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    // New transition (Yellow + Blue is a different state-key than Yellow alone).
    ctx.driveFlags([FLAG_YELLOW, FLAG_BLUE]);

    // 4000 ms after the FIRST trigger, but only 0 ms into the SECOND window.
    vi.advanceTimersByTime(4000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);

    // Another 1500 ms (5500 ms into the second window) — now past the limit.
    vi.advanceTimersByTime(1500);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });

  it("does not retrigger when the same flag continues after auto-stop", () => {
    const ctx = createTestContext();

    ctx.driveFlags([FLAG_YELLOW]);
    vi.advanceTimersByTime(5000);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);

    const callsBeforeRetick = ctx.setImageSpy.mock.calls.length;

    // Same flags come in again — onFlagUpdate should short-circuit
    // because lastFlagStateKey is still "YELLOW".
    ctx.driveFlags([FLAG_YELLOW]);

    expect(ctx.setImageSpy.mock.calls.length).toBe(callsBeforeRetick);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
  });

  it("restarts the flash when the same flag returns after a clear", () => {
    const ctx = createTestContext();

    ctx.driveFlags([FLAG_YELLOW]);
    vi.advanceTimersByTime(5000); // auto-stop fires

    ctx.driveFlags([]); // flags clear → stopFlagFlash() resets cache

    ctx.driveFlags([FLAG_YELLOW]); // fresh transition — should retrigger
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(true);
  });
});

describe("BaseAction flag overlay sim connection (#1351)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({ flagFlashDurationSeconds: 5 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flashes every context that appeared before the sim connection existed, once it is initialised", () => {
    _resetSimConnection();
    const action = new TestAction();
    const contexts = ["ctx-1", "ctx-2", "ctx-3"].map((id) => ({ id, ...appearWithFlagOverlay(action, id) }));

    expect(sim.fake!.subscribers.size).toBe(0);

    initializeSimConnection(sim.fake!.connection);
    expect(sim.fake!.subscribers.size).toBe(1);

    sim.fake!.state.flags = [FLAG_YELLOW];
    sim.fake!.tick();

    for (const { id, setImageSpy } of contexts) {
      expect(action.getOverlayActive().has(id)).toBe(true);
      // The last image pushed is the flag overlay, not the key's own "<svg/>".
      expect(setImageSpy.mock.lastCall?.[0]).not.toBe("<svg/>");
    }
  });

  it("skips a tick whose activeFlags throws, keeping the previous flag state", () => {
    const ctx = createTestContext();

    ctx.driveFlags([FLAG_YELLOW]);
    vi.advanceTimersByTime(5000); // the duration setting ends the flash
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);

    const callsBeforeThrow = ctx.setImageSpy.mock.calls.length;
    const activeFlags = vi.spyOn(sim.fake!.connection, "activeFlags").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    expect(() => sim.fake!.tick()).not.toThrow();
    expect(activeFlags).toHaveBeenCalled();
    // The throwing tick is skipped: no image is pushed.
    expect(ctx.setImageSpy.mock.calls.length).toBe(callsBeforeThrow);

    // The next good tick with the same flag does not restart the ended flash.
    ctx.driveFlags([FLAG_YELLOW]);
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
    expect(ctx.setImageSpy.mock.calls.length).toBe(callsBeforeThrow);
  });

  it("clears the overlay when a tick reports the sim disconnected", () => {
    const ctx = createTestContext();

    ctx.driveFlags([FLAG_YELLOW]);
    const activeFlags = vi.spyOn(sim.fake!.connection, "activeFlags");

    sim.fake!.state.connected = false;
    sim.fake!.tick();

    expect(activeFlags).not.toHaveBeenCalled();
    expect(ctx.action.getOverlayActive().has("ctx-1")).toBe(false);
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
      dialCanvas: () => null,
      setDialCanvas: vi.fn().mockResolvedValue(undefined),
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

  // What the fake connection resolves `{{self.car_number}}` to; undefined
  // renders it empty, as a disconnected sim does. Every call to
  // `resolveTitle` is one title resolution.
  let carNumber: string | undefined;
  const resolveTitle = vi.fn((text: string) => text.replaceAll("{{self.car_number}}", carNumber ?? ""));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetGlobalSettings.mockReturnValue({});
    carNumber = undefined;
    sim.fake!.state.resolve = resolveTitle;
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
      dialCanvas: () => null,
      setDialCanvas: vi.fn().mockResolvedValue(undefined),
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
        const onTick = titleSubscriber();

        if (!onTick) throw new Error("Title template callback was never captured — subscription did not register");

        onTick(true);
      },
    };
  }

  function titleSubscriber(): ((isConnected: boolean) => void) | undefined {
    for (const [id, onTick] of sim.fake!.subscribers) {
      if (id.startsWith(TITLE_TEMPLATE_PREFIX)) return onTick;
    }

    return undefined;
  }

  function setDisplayValue(value: string | undefined): void {
    carNumber = value;
  }

  it("subscribes to the sim connection when a context's user title contains a template", () => {
    createTitleContext("CAR {{self.car_number}}");

    expect(titleSubscriber()).toBeDefined();
  });

  it("does not subscribe for titles without templates", () => {
    createTitleContext("PLAIN TITLE");

    expect(titleSubscriber()).toBeUndefined();
  });

  it("does not subscribe when no title override is set", () => {
    createTitleContext(undefined);

    expect(titleSubscriber()).toBeUndefined();
  });

  it("re-renders through the regenerate callback when the resolved title changes", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    setDisplayValue("34");
    ctx.action.registerRegenerateCallback(CONTEXT_ID, () => {
      return `<svg>${carNumber ?? ""}</svg>`;
    });
    expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>34</svg>");

    // Step past the 10 Hz window so the next change renders immediately.
    vi.advanceTimersByTime(200);
    setDisplayValue("35");
    ctx.driveTick();

    expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>35</svg>");
  });

  it("re-resolves a templated title on tick", () => {
    const ctx = createTitleContext("{{x}}");
    const regenerate = vi.fn(() => "<svg>regenerated</svg>");

    ctx.action.registerRegenerateCallback(CONTEXT_ID, regenerate);
    vi.advanceTimersByTime(200);
    regenerate.mockClear();

    sim.fake!.state.resolve = () => "A";
    sim.fake!.tick();
    expect(regenerate).toHaveBeenCalledOnce();

    // Past the 10 Hz window, a tick that resolves differently regenerates again.
    vi.advanceTimersByTime(200);
    sim.fake!.state.resolve = () => "B";
    sim.fake!.tick();
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it("subscribes a title tracked before the sim connection existed once it is initialised", () => {
    _resetSimConnection();
    createTitleContext("{{self.car_number}}");
    expect(titleSubscriber()).toBeUndefined();

    initializeSimConnection(sim.fake!.connection);
    expect(titleSubscriber()).toBeDefined();
  });

  it("does not re-render when the resolved title is unchanged", () => {
    const ctx = createTitleContext("{{self.car_number}}");

    setDisplayValue("34");
    ctx.action.registerRegenerateCallback(CONTEXT_ID, () => {
      return `<svg>${carNumber ?? ""}</svg>`;
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
      return `<svg>${carNumber ?? ""}</svg>`;
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

  describe("resolution inside the throttle (#1339)", () => {
    // The regenerate callback reads `shown` rather than resolving a title,
    // so every resolveTitle call counted here is a title resolution made by
    // the tick path.
    let shown = "34";
    const regenerate = vi.fn(() => `<svg>${shown}</svg>`);

    function setShown(value: string): void {
      shown = value;
      setDisplayValue(value);
    }

    function prepare(): ReturnType<typeof createTitleContext> {
      const ctx = createTitleContext("{{self.car_number}}");

      setShown("34");
      ctx.action.registerRegenerateCallback(CONTEXT_ID, regenerate);
      // One tick past the window records "34" as the last resolved title.
      vi.advanceTimersByTime(200);
      ctx.driveTick();
      vi.advanceTimersByTime(200);
      resolveTitle.mockClear();
      regenerate.mockClear();
      ctx.setImageSpy.mockClear();

      return ctx;
    }

    it("a burst of ticks inside one window resolves the title at most on the leading and trailing edge", () => {
      const ctx = prepare();

      for (let i = 0; i < 10; i++) {
        ctx.driveTick();
        vi.advanceTimersByTime(5);
      }

      // Only the leading tick resolved; the other nine are one pending flush.
      expect(resolveTitle).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);

      expect(resolveTitle).toHaveBeenCalledTimes(2);
    });

    it("an unchanged title neither regenerates nor pushes", () => {
      const ctx = prepare();

      for (let i = 0; i < 10; i++) {
        ctx.driveTick();
        vi.advanceTimersByTime(5);
      }

      vi.advanceTimersByTime(100);

      expect(regenerate).not.toHaveBeenCalled();
      expect(ctx.setImageSpy).not.toHaveBeenCalled();
    });

    it("a changed title pushes once, however many ticks carry the change", () => {
      const ctx = prepare();

      setShown("35");

      for (let i = 0; i < 10; i++) {
        ctx.driveTick();
        vi.advanceTimersByTime(5);
      }

      vi.advanceTimersByTime(100);

      expect(ctx.setImageSpy).toHaveBeenCalledTimes(1);
      expect(ctx.setImageSpy).toHaveBeenLastCalledWith("<svg>35</svg>");
    });

    it("a pending flush does nothing once the context is untracked", () => {
      const ctx = prepare();

      ctx.driveTick();
      setShown("35");
      ctx.driveTick();
      resolveTitle.mockClear();

      const settingsEvent = {
        action: ctx.fakeAction,
        payload: { settings: { titleOverrides: { titleText: "PLAIN" } } },
      } as unknown as IDeckDidReceiveSettingsEvent<Record<string, unknown>>;

      void ctx.action.onDidReceiveSettings(settingsEvent);
      ctx.setImageSpy.mockClear();
      vi.advanceTimersByTime(200);

      expect(resolveTitle).not.toHaveBeenCalled();
      expect(ctx.setImageSpy).not.toHaveBeenCalled();
    });
  });

  it("stops tracking when settings change to a non-templated title", () => {
    const ctx = createTitleContext("{{self.car_number}}");
    expect(titleSubscriber()).toBeDefined();

    const settingsEvent = {
      action: ctx.fakeAction,
      payload: { settings: { titleOverrides: { titleText: "PLAIN" } } },
    } as unknown as IDeckDidReceiveSettingsEvent<Record<string, unknown>>;

    void ctx.action.onDidReceiveSettings(settingsEvent);

    expect(titleSubscriber()).toBeUndefined();
  });

  it("unsubscribes when the last templated context disappears", () => {
    const ctx = createTitleContext("{{self.car_number}}");
    expect(titleSubscriber()).toBeDefined();

    const disappearEvent = {
      action: ctx.fakeAction,
      payload: { settings: {} },
    } as unknown as IDeckWillDisappearEvent<Record<string, unknown>>;

    void ctx.action.onWillDisappear(disappearEvent);

    expect(titleSubscriber()).toBeUndefined();
  });
});
