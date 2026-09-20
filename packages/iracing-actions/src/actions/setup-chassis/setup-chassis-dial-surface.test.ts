import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  DialSettings,
  formatDialValue,
  nextSpringSide,
  pendingGesturePreview,
} from "./setup-chassis-dial-surface.js";
import { SetupChassis } from "./setup-chassis.js";

const {
  mockGetCurrentTelemetry,
  mockTapBinding,
  mockTapBindingSequence,
  mockIsBindingMissing,
  mockDualPressThreshold,
  globalListeners,
} = vi.hoisted(() => ({
  mockGetCurrentTelemetry: vi.fn<() => unknown>(() => null),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockTapBindingSequence: vi.fn().mockResolvedValue(true),
  mockIsBindingMissing: vi.fn(() => false),
  mockDualPressThreshold: { value: 500 },
  globalListeners: [] as Array<() => void>,
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");
  // deck-core's dial-gesture module, reached by PATH rather than through the
  // mocked barrel (the `mouse-to-sim.test.ts` pattern): the hold preview's
  // timer behaviour is the thing under test, so the REAL helper has to run — a
  // stub would only assert the stub. That module has zero imports of its own,
  // so reaching it directly drags in none of the barrel's graph. The path is
  // inlined because `vi.mock` is hoisted above every top-level const.
  const dialGesture = await vi.importActual<typeof import("../../../../deck-core/src/dial-gesture.js")>(
    "../../../../deck-core/src/dial-gesture.js",
  );

  return {
    createHoldPreview: dialGesture.createHoldPreview,
    IconUpdateThrottle: class {
      schedule(_id: string, render: () => unknown): void {
        try {
          void Promise.resolve(render()).catch(() => {});
        } catch {
          // Swallow sync throws — matches the production render contract.
        }
      }
      clear(): void {}
      clearAll(): void {}
    },
    CommonSettings: {
      extend: (shape: never) => z.object(shape).passthrough(),
    },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      sdkController = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getCurrentTelemetry: mockGetCurrentTelemetry,
        getSessionInfo: vi.fn(() => null),
      };
      setKeyImage = vi.fn().mockResolvedValue(undefined);
      setRegenerateCallback = vi.fn();
      updateKeyImage = vi.fn().mockResolvedValue(false);
      setActiveBinding = vi.fn();
      tapBinding = mockTapBinding;
      tapBindingSequence = mockTapBindingSequence;
      isBindingMissing = mockIsBindingMissing;
      async onWillAppear() {}
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
    DualPressTracker: class {
      recordKeyDown = vi.fn();
      computeOutcome = vi.fn(() => undefined);
      clear = vi.fn();
    },
    getDualPressDirections: vi.fn(() => "tap-increases"),
    getDualPressThresholdMs: () => mockDualPressThreshold.value,
    onGlobalSettingsChange: vi.fn((listener: () => void) => {
      globalListeners.push(listener);

      return vi.fn();
    }),
    classifyDialRelease: (args: {
      pressStartMs: number;
      nowMs: number;
      rotatedWhilePressed: boolean;
      thresholdMs?: number;
    }) => {
      if (args.rotatedWhilePressed) return "push-turn";

      return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
    },
    applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
    escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
  };
});

function dialContext(id: string) {
  return {
    id,
    isKey: () => false,
    isDial: () => true,
    setImage: vi.fn().mockResolvedValue(undefined),
    setTitle: vi.fn().mockResolvedValue(undefined),
    setSettings: vi.fn().mockResolvedValue(undefined),
    setFeedback: vi.fn().mockResolvedValue(undefined),
    setTriggerDescription: vi.fn().mockResolvedValue(undefined),
  };
}

type DialContext = ReturnType<typeof dialContext>;

function rotateEvent(action: DialContext, settings: Record<string, unknown>, ticks: number, pressed = false) {
  return { action, payload: { settings, ticks, pressed } };
}

function basicEvent(action: DialContext, settings: Record<string, unknown> = {}) {
  return { action, payload: { settings } };
}

function dialSettings(dial: Record<string, unknown>) {
  return { dial };
}

describe("setup-chassis dial-surface pure helpers", () => {
  describe("formatDialValue", () => {
    it("formats readback settings as plain integers", () => {
      expect(formatDialValue("differential-preload", { dcDiffPreload: 3 } as never)).toBe("3");
      expect(formatDialValue("power-steering", { dcPowerSteering: 2 } as never)).toBe("2");
    });

    it("returns empty (identity-only) for the shocks", () => {
      expect(formatDialValue("lf-shock", { dcDiffPreload: 3 } as never)).toBe("");
      expect(formatDialValue("rr-shock", { dcDiffPreload: 3 } as never)).toBe("");
    });

    it("formats the pending pit-stop spring offset per the sim's display units (#953)", () => {
      expect(formatDialValue("lr-spring", { dpWeightJackerLeft: 2.54, DisplayUnits: 1 } as never)).toBe("3 mm");
      expect(formatDialValue("rr-spring", { dpWeightJackerRight: 3.175, DisplayUnits: 0 } as never)).toBe('0.125"');
    });

    it("shows the placeholder for a spring whose field the car does not expose (SRX one-sided case)", () => {
      expect(formatDialValue("lr-spring", { dpWeightJackerRight: 157, DisplayUnits: 1 } as never)).toBe("---");
    });

    it("forces the spring units when the dial units setting is not auto (#953)", () => {
      const metricSim = { dpWeightJackerLeft: 3.175, DisplayUnits: 1 } as never;
      const imperialSim = { dpWeightJackerLeft: 2.54, DisplayUnits: 0 } as never;

      expect(formatDialValue("lr-spring", metricSim, "imperial")).toBe('0.125"');
      expect(formatDialValue("lr-spring", imperialSim, "metric")).toBe("3 mm");
      expect(formatDialValue("lr-spring", metricSim, "auto")).toBe("3 mm");
      expect(formatDialValue("lr-spring", imperialSim, "auto")).toBe('0.100"');
    });

    it("parses the dial units setting with an auto default", () => {
      expect(DialSettings.parse({}).units).toBe("auto");
      expect(DialSettings.parse({ units: "imperial" }).units).toBe("imperial");
      // A value from a newer plugin version degrades to auto instead of
      // resetting the whole dial object (the 2.0-contamination lesson).
      const degraded = DialSettings.parse({ setting: "rr-spring", units: "furlongs" });
      expect(degraded.units).toBe("auto");
      expect(degraded.setting).toBe("rr-spring");
    });

    it("shows the placeholder when a readback setting has no telemetry", () => {
      expect(formatDialValue("differential-preload", null)).toBe("---");
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the bound setting on rotate and offers no press gesture", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "differential-preload" }));

      expect(desc.rotate).toBe("Adjust Diff Preload");
      expect(desc.push).toBeUndefined();
    });

    it("names an identity-only setting", () => {
      const desc = buildTriggerDescription(DialSettings.parse({ setting: "lf-shock" }));

      expect(desc.rotate).toBe("Adjust LF Shock");
    });

    it("names the pit-stop gesture on push (#953)", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "lr-spring", pressAction: "show-pit-stop-black-box" }),
      );

      expect(desc.push).toBe("Show Pit Stop Box");
    });

    it("names the spring-side toggle on push (#953)", () => {
      const desc = buildTriggerDescription(
        DialSettings.parse({ setting: "lr-spring", pressAction: "toggle-spring-side" }),
      );

      expect(desc.push).toBe("Switch LR/RR");
    });
  });

  describe("nextSpringSide / pendingGesturePreview (#1120)", () => {
    it("previews the side the gesture will select, from the same helper the gesture uses", () => {
      for (const from of ["lr-spring", "rr-spring", "differential-preload", "lf-shock"] as const) {
        const preview = pendingGesturePreview("toggle-spring-side", from, "#2ecc71");

        expect(preview).not.toBeNull();
        // The preview's setting IS the gesture's next side — one definition.
        expect(preview?.setting).toBe(nextSpringSide(from));
      }
    });

    it("labels the pending side with that side's own dash-box abbreviation", () => {
      expect(pendingGesturePreview("toggle-spring-side", "lr-spring", "#2ecc71")).toEqual({
        pending: { text: "RR SPR", color: "#2ecc71" },
        setting: "rr-spring",
      });
      expect(pendingGesturePreview("toggle-spring-side", "rr-spring", "#2ecc71")).toEqual({
        pending: { text: "LR SPR", color: "#2ecc71" },
        setting: "lr-spring",
      });
      // Any non-spring setting jumps to LR, exactly as the gesture does.
      expect(pendingGesturePreview("toggle-spring-side", "differential-preload", "#2ecc71")?.pending.text).toBe(
        "LR SPR",
      );
    });

    it("previews nothing for the black box or a none slot", () => {
      // Telemetry never reports which black box is open, so the plugin cannot
      // say what the press leaves on screen — it shows nothing rather than guess.
      expect(pendingGesturePreview("show-pit-stop-black-box", "lr-spring", "#2ecc71")).toBeNull();
      expect(pendingGesturePreview("none", "lr-spring", "#2ecc71")).toBeNull();
    });
  });
});

describe("SetupChassis dial surface", () => {
  let action: SetupChassis;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDualPressThreshold.value = 500;
    mockIsBindingMissing.mockReturnValue(false);
    mockGetCurrentTelemetry.mockReturnValue({ dcDiffPreload: 3, dcPowerSteering: 2 });
    globalListeners.length = 0;
    action = new SetupChassis();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function appear(ctx: DialContext, settings: Record<string, unknown> = {}) {
    await action.onWillAppear(basicEvent(ctx, settings) as never);
  }

  describe("dial units on the strip (#953)", () => {
    it("renders the forced imperial value on a metric-display sim", async () => {
      mockGetCurrentTelemetry.mockReturnValue({ dpWeightJackerLeft: 3.175, DisplayUnits: 1 });
      const ctx = dialContext("d1");
      await appear(ctx, dialSettings({ setting: "lr-spring", units: "imperial" }));

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;

      expect(decodeURIComponent(feedback)).toContain('>0.125"<');
    });
  });

  describe("Switch LR/RR Spring gesture (#953)", () => {
    it("accepts the gesture in the dial schema", () => {
      expect(DialSettings.parse({ pressAction: "toggle-spring-side" }).pressAction).toBe("toggle-spring-side");
      expect(DialSettings.parse({ longPressAction: "toggle-spring-side" }).longPressAction).toBe("toggle-spring-side");
    });

    it("flips the dial from LR to RR spring on a short press, preserving the keypad settings", async () => {
      const ctx = dialContext("d1");
      const settings = {
        setting: "differential-preload",
        dial: { setting: "lr-spring", pressAction: "toggle-spring-side" },
      };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(ctx.setSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          setting: "differential-preload",
          dial: expect.objectContaining({ setting: "rr-spring", pressAction: "toggle-spring-side" }),
        }),
      );
    });

    it("re-renders the strip for the new side after the flip", async () => {
      const ctx = dialContext("d1");
      const settings = { dial: { setting: "lr-spring", pressAction: "toggle-spring-side" } };
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;
      const svg = decodeURIComponent(feedback);
      const litRight = /<polygon data-side="right"[^>]*>/.exec(svg)?.[0];
      expect(litRight).toBeDefined();
      expect(litRight).not.toContain("opacity");
      expect(svg).toContain("RR SPR");
    });

    it("toggles back on the next press without a settings echo", async () => {
      const ctx = dialContext("d1");
      const settings = { dial: { setting: "lr-spring", pressAction: "toggle-spring-side" } };
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);
      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      const lastWrite = ctx.setSettings.mock.calls.at(-1)?.[0] as { dial: { setting: string } };
      expect(lastWrite.dial.setting).toBe("lr-spring");
    });

    it("jumps to the LR spring when a non-spring setting is selected", async () => {
      const ctx = dialContext("d1");
      const settings = { dial: { setting: "differential-preload", tapAction: "toggle-spring-side" } };
      await appear(ctx, settings);

      await action.onTouchTap({ action: ctx, payload: { settings, hold: false } } as never);

      const lastWrite = ctx.setSettings.mock.calls.at(-1)?.[0] as { dial: { setting: string } };
      expect(lastWrite.dial.setting).toBe("lr-spring");
    });
  });

  describe("spring side-arrow markers (#953)", () => {
    it("renders both side triangles for a spring setting, lighting the edited side", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, dialSettings({ setting: "lr-spring" }));

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;
      const svg = decodeURIComponent(feedback);

      expect(svg).toContain('data-side="left"');
      expect(svg).toContain('data-side="right"');
    });

    it("renders no side markers for non-spring settings", async () => {
      const ctx = dialContext("d1");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const feedback = (ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box;

      expect(decodeURIComponent(feedback)).not.toContain("data-side");
    });
  });

  describe("Show Pit Stop Black Box gesture (#953)", () => {
    it("accepts the gesture in the dial schema", () => {
      expect(DialSettings.parse({ pressAction: "show-pit-stop-black-box" }).pressAction).toBe(
        "show-pit-stop-black-box",
      );
    });

    it("shows the Pit Stop black box on a short press via the atomic prime+target sequence", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "lr-spring", pressAction: "show-pit-stop-black-box" });
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxPitStop"], 0);
    });

    it("shows the box on a touch tap", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "lr-spring", tapAction: "show-pit-stop-black-box" });
      await appear(ctx, settings);

      await action.onTouchTap({ action: ctx, payload: { settings, hold: false } } as never);

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxPitStop"], 0);
    });
  });

  describe("onDialRotate", () => {
    it("taps the increase binding on a clockwise turn", async () => {
      const ctx = dialContext("d1");
      const settings = dialSettings({ setting: "differential-preload" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisDifferentialPreloadIncrease");
    });

    it("adjusts an identity-only setting (a shock) too", async () => {
      const ctx = dialContext("d3");
      const settings = dialSettings({ setting: "lf-shock" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, -1) as never);

      expect(mockTapBinding).toHaveBeenCalledWith("setupChassisLfShockDecrease");
    });
  });

  describe("press gestures (none configured)", () => {
    it("does nothing on a short press", async () => {
      const ctx = dialContext("p1");
      const settings = dialSettings({ setting: "differential-preload" });
      await appear(ctx, settings);
      mockTapBinding.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the dash box with the live value on a readback setting", async () => {
      const ctx = dialContext("f1");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">PRELD<");
      expect(decoded).toContain(">3<");
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const ctx = dialContext("a811");
      await appear(
        ctx,
        dialSettings({
          setting: "differential-preload",
          colors: { borderColor: "#112233", backgroundColor: "#445566" },
        }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes a label-only strip for a shock (identity-only)", async () => {
      const ctx = dialContext("fb");
      await appear(ctx, dialSettings({ setting: "rf-shock" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">RF<");
      expect((decoded.match(/<text/g) ?? []).length).toBe(1);
    });

    it("pushes the two-line name icon as the deck-app dial image (#800)", async () => {
      const ctx = dialContext("f7");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">SETUP<");
      expect(img).toContain(">CHASSIS<");
    });

    it("dims the strip under the #612 warning when a rotation binding is missing", async () => {
      mockIsBindingMissing.mockReturnValue(true);
      const ctx = dialContext("f6");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(mockIsBindingMissing).toHaveBeenCalledWith([
        "setupChassisDifferentialPreloadIncrease",
        "setupChassisDifferentialPreloadDecrease",
      ]);
      expect(decoded).toContain("binding-warning");
    });
  });

  describe("hold preview (#1120)", () => {
    /** The last pushed touch-strip pixmap, decoded back to SVG. */
    function lastBox(ctx: DialContext): string {
      return decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);
    }

    /** The `<polygon>` for one side marker, or undefined when the box draws none. */
    function marker(svg: string, side: "left" | "right"): string | undefined {
      return new RegExp(`<polygon data-side="${side}"[^>]*>`).exec(svg)?.[0];
    }

    const held = (dial: Record<string, unknown> = {}) =>
      dialSettings({ setting: "lr-spring", pressAction: "none", longPressAction: "toggle-spring-side", ...dial });

    it("draws the pending side when the hold passes the threshold, and not before", async () => {
      const ctx = dialContext("hp1");
      const settings = held();
      mockGetCurrentTelemetry.mockReturnValue({ dpWeightJackerLeft: 2.54, DisplayUnits: 1 });
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(499);

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      const decoded = lastBox(ctx);

      expect(decoded).toContain(">RR SPR<");
      expect(decoded).toContain("data-pending-bar");
      // The live spring offset is replaced for the duration.
      expect(decoded).not.toContain(">3 mm<");
    });

    it("flips the side marker with the previewed text so the arrow cannot disagree", async () => {
      const ctx = dialContext("hp2");
      const settings = held();
      await appear(ctx, settings);

      const before = lastBox(ctx);

      // Before the hold: LR is the edited side, so the left arrow is lit.
      expect(marker(before, "left")).not.toContain("opacity");
      expect(marker(before, "right")).toContain("opacity");

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);

      const during = lastBox(ctx);

      expect(during).toContain(">RR SPR<");
      expect(marker(during, "right")).not.toContain("opacity");
      expect(marker(during, "left")).toContain("opacity");
    });

    it("previews LR SPR from a non-spring setting, which has no marker of its own", async () => {
      const ctx = dialContext("hp3");
      const settings = held({ setting: "differential-preload" });
      await appear(ctx, settings);

      expect(lastBox(ctx)).not.toContain("data-side");

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);

      const during = lastBox(ctx);

      expect(during).toContain(">LR SPR<");
      expect(marker(during, "left")).not.toContain("opacity");
    });

    it("selects the side the preview promised when the hold is released", async () => {
      const ctx = dialContext("hp4");
      const settings = held();
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);
      const promised = lastBox(ctx).includes(">RR SPR<") ? "rr-spring" : "lr-spring";
      ctx.setFeedback.mockClear();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      const lastWrite = ctx.setSettings.mock.calls.at(-1)?.[0] as { dial: { setting: string } };

      expect(lastWrite.dial.setting).toBe(promised);
      // The normal frame is back: the new side as the LABEL, no pending mark.
      const decoded = lastBox(ctx);

      expect(decoded).not.toContain("data-pending-bar");
      expect(decoded).toContain(">RR SPR<");
    });

    it("follows the configured long-press threshold rather than a constant", async () => {
      mockDualPressThreshold.value = 900;
      const ctx = dialContext("hp5");
      const settings = held();
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(800);

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);

      expect(lastBox(ctx)).toContain(">RR SPR<");
    });

    it("reverts at once on a push+turn mid-hold", async () => {
      const ctx = dialContext("hp6");
      const settings = held();
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);

      expect(lastBox(ctx)).toContain("data-pending-bar");
      ctx.setFeedback.mockClear();

      await action.onDialRotate(rotateEvent(ctx, settings, 1, true) as never);

      expect(ctx.setFeedback).toHaveBeenCalled();
      const decoded = lastBox(ctx);

      expect(decoded).not.toContain("data-pending-bar");
      // The arrow came back with the text: LR is still the edited side.
      expect(marker(decoded, "left")).not.toContain("opacity");

      // A push+turn fires no gesture on release and needs no second revert.
      ctx.setFeedback.mockClear();
      ctx.setSettings.mockClear();
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setSettings).not.toHaveBeenCalled();
    });

    it("pushes neither a preview nor a revert for a release before the threshold", async () => {
      const ctx = dialContext("hp7");
      const settings = held();
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(200);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      // The disarmed timer must not fire after the release either.
      vi.advanceTimersByTime(1000);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("previews NOTHING for the black box, whose outcome telemetry never reports", async () => {
      const ctx = dialContext("hp8");
      const settings = held({ longPressAction: "show-pit-stop-black-box" });
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(mockTapBindingSequence).toHaveBeenCalled();
    });

    it("previews nothing when the long-press slot is none", async () => {
      const ctx = dialContext("hp9");
      const settings = held({ longPressAction: "none" });
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });

    it("keeps the preview up when telemetry ticks mid-hold", async () => {
      const ctx = dialContext("hp10");
      mockGetCurrentTelemetry.mockReturnValue({ dpWeightJackerLeft: 2.54, DisplayUnits: 1 });
      const settings = held();
      await appear(ctx, settings);

      const onTick = (
        action as unknown as { sdkController: { subscribe: ReturnType<typeof vi.fn> } }
      ).sdkController.subscribe.mock.calls.at(-1)?.[1] as (telemetry: unknown) => void;

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);
      ctx.setFeedback.mockClear();

      // Past the change-render throttle window, with a moved live value.
      vi.advanceTimersByTime(150);
      mockGetCurrentTelemetry.mockReturnValue({ dpWeightJackerLeft: 5.08, DisplayUnits: 1 });
      onTick({ dpWeightJackerLeft: 5.08, DisplayUnits: 1 });

      const decoded = lastBox(ctx);

      expect(decoded).toContain(">RR SPR<");
      expect(decoded).toContain("data-pending-bar");
      expect(marker(decoded, "right")).not.toContain("opacity");
    });

    it("survives a global-settings refresh mid-hold", async () => {
      const ctx = dialContext("hp11");
      const settings = held();
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);
      ctx.setFeedback.mockClear();

      for (const listener of globalListeners) listener();

      expect(lastBox(ctx)).toContain("data-pending-bar");
    });

    it("drops the preview when the settings change mid-hold", async () => {
      const ctx = dialContext("hp12");
      const settings = held();
      await appear(ctx, settings);

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(500);

      expect(lastBox(ctx)).toContain("data-pending-bar");

      await action.onDidReceiveSettings(basicEvent(ctx, held({ setting: "rear-arb" })) as never);

      expect(lastBox(ctx)).not.toContain("data-pending-bar");
    });

    it("pushes nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const ctx = dialContext("hp13");
      const settings = held();
      await appear(ctx, settings);
      ctx.setFeedback.mockClear();

      await action.onDialDown(basicEvent(ctx, settings) as never);
      vi.advanceTimersByTime(600);
      await action.onDialUp(basicEvent(ctx, settings) as never);

      expect(ctx.setFeedback).not.toHaveBeenCalled();
    });
  });

  describe("legacy flat-setting migration (#800)", () => {
    it("seeds dial.setting from a pre-merge encoder placement's flat setting", async () => {
      const ctx = dialContext("m1");
      const legacy = { setting: "rr-shock", direction: "decrease" };
      await appear(ctx, legacy);

      expect(ctx.setSettings).toHaveBeenCalledWith({ ...legacy, dial: { setting: "rr-shock" } });
    });

    it("does not seed for View modes", async () => {
      const ctx2 = dialContext("m3");
      await appear(ctx2, { setting: "view-diff-preload" });

      expect(ctx2.setSettings).not.toHaveBeenCalled();
    });
  });

  describe("subscription lifecycle", () => {
    it("subscribes on appear and unsubscribes on disappear", async () => {
      const ctx = dialContext("s1");
      await appear(ctx, dialSettings({ setting: "differential-preload" }));

      const sdk = (
        action as unknown as {
          sdkController: { subscribe: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn> };
        }
      ).sdkController;

      expect(sdk.subscribe).toHaveBeenCalled();

      await action.onWillDisappear(basicEvent(ctx, dialSettings({ setting: "differential-preload" })) as never);

      expect(sdk.unsubscribe).toHaveBeenCalledWith("s1");
    });
  });
});
