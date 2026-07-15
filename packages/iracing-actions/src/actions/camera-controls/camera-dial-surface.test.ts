import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTriggerDescription,
  CameraDialSurface,
  computeFocusReadout,
  DialSettings,
  formatReadout,
} from "./camera-dial-surface.js";

const { mockGroups, mockCarNumber } = vi.hoisted(() => ({
  // Mutable session lookups the SDK helper mocks read, so tests can flip
  // in-session / out-of-session and change the focused car per case.
  mockGroups: { value: [{ groupNum: 9, groupName: "Cockpit" }] as Array<{ groupNum: number; groupName: string }> },
  mockCarNumber: { value: "42" as string | null },
}));

vi.mock("@iracedeck/deck-core", () => ({
  // push-turn when rotated while held, else long/short vs the threshold.
  classifyDialRelease: (args: {
    pressStartMs: number;
    nowMs: number;
    rotatedWhilePressed: boolean;
    thresholdMs?: number;
  }) => {
    if (args.rotatedWhilePressed) return "push-turn";

    return args.nowMs - args.pressStartMs >= (args.thresholdMs ?? 500) ? "long" : "short";
  },
  getDualPressThresholdMs: () => 500,
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
  escapeXml: (str: string) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  svgToDataUri: (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`,
}));

vi.mock("@iracedeck/iracing-sdk", () => ({
  getCameraGroupsFromSessionInfo: vi.fn(() => mockGroups.value),
  getCarNumberFromSessionInfo: vi.fn(() => mockCarNumber.value),
}));

/** Fake dial (encoder) action context. */
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

const TELEMETRY = { CamGroupNumber: 9, CamCarIdx: 3 };

function makeHost(over: Partial<Record<string, unknown>> = {}) {
  return {
    logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getTelemetry: vi.fn(() => TELEMETRY as never),
    getSessionInfo: vi.fn(() => ({}) as unknown),
    cycle: vi.fn(),
    focusMyCar: vi.fn(),
    changeCamera: vi.fn(),
    ...over,
  };
}

function dial(over: Record<string, unknown> = {}) {
  return DialSettings.parse(over);
}

beforeEach(() => {
  mockGroups.value = [{ groupNum: 9, groupName: "Cockpit" }];
  mockCarNumber.value = "42";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("camera dial-surface pure helpers", () => {
  describe("computeFocusReadout", () => {
    it("resolves the focused car number and camera group name", () => {
      expect(computeFocusReadout(TELEMETRY as never, {})).toEqual({ groupName: "Cockpit", carNumber: "42" });
    });

    it("returns nulls when telemetry is unavailable", () => {
      expect(computeFocusReadout(null, {})).toEqual({ groupName: null, carNumber: null });
    });

    it("returns a null group when the CamGroupNumber is not in the session groups", () => {
      mockGroups.value = [{ groupNum: 17, groupName: "TV1" }];

      expect(computeFocusReadout(TELEMETRY as never, {})).toEqual({ groupName: null, carNumber: "42" });
    });

    it("returns a null car number when the focused car is not in the driver list", () => {
      mockCarNumber.value = null;

      expect(computeFocusReadout(TELEMETRY as never, {})).toEqual({ groupName: "Cockpit", carNumber: null });
    });
  });

  describe("formatReadout", () => {
    it("shows the group name as the label and the #-car-number as the value", () => {
      expect(formatReadout("car", TELEMETRY as never, {})).toEqual({ label: "COCKPIT", value: "#42" });
    });

    it("falls back to the mode identity label with an empty value out of session", () => {
      expect(formatReadout("car", null, {})).toEqual({ label: "CAR", value: "" });
      expect(formatReadout("camera", null, {})).toEqual({ label: "CAMERA", value: "" });
      expect(formatReadout("sub-camera", null, {})).toEqual({ label: "SUB CAM", value: "" });
      expect(formatReadout("driving", null, {})).toEqual({ label: "DRIVING", value: "" });
    });

    it("uses the identity label but keeps the car number when the group is unknown", () => {
      mockGroups.value = [];

      expect(formatReadout("car", TELEMETRY as never, {})).toEqual({ label: "CAR", value: "#42" });
    });
  });

  describe("buildTriggerDescription", () => {
    it("names the cycled target on rotate and rides the long-press on push", () => {
      const desc = buildTriggerDescription(
        dial({ mode: "car", pressAction: "focus-my-car", longPressAction: "change-camera" }),
      );

      expect(desc.rotate).toBe("Cycle Cars");
      expect(desc.push).toBe("Focus My Car (hold: Change Camera)");
      expect(desc.touch).toBeUndefined();
      expect(desc.longTouch).toBeUndefined();
    });

    it("maps the touch slots and omits none slots", () => {
      const desc = buildTriggerDescription(
        dial({ mode: "camera", pressAction: "none", tapAction: "focus-my-car", longTouchAction: "change-camera" }),
      );

      expect(desc.rotate).toBe("Cycle Cameras");
      expect(desc.push).toBeUndefined();
      expect(desc.touch).toBe("Focus My Car");
      expect(desc.longTouch).toBe("Change Camera");
    });
  });
});

describe("CameraDialSurface", () => {
  describe("rotation → keypad cycle dispatch", () => {
    it("cycles the mapped target forward on a clockwise turn", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d1") as never, dial({ mode: "car" }), 1, false);

      expect(host.cycle).toHaveBeenCalledWith("cycle-car", "next");
    });

    it("cycles backward on a counter-clockwise turn", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d2") as never, dial({ mode: "car" }), -1, false);

      expect(host.cycle).toHaveBeenCalledWith("cycle-car", "previous");
    });

    it("maps each dial mode to its keypad cycle target", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d3") as never, dial({ mode: "camera" }), 1, false);
      surface.rotate(dialContext("d3") as never, dial({ mode: "sub-camera" }), 1, false);
      surface.rotate(dialContext("d3") as never, dial({ mode: "driving" }), 1, false);

      expect(host.cycle).toHaveBeenNthCalledWith(1, "cycle-camera", "next");
      expect(host.cycle).toHaveBeenNthCalledWith(2, "cycle-sub-camera", "next");
      expect(host.cycle).toHaveBeenNthCalledWith(3, "cycle-driving", "next");
    });

    it("dispatches one cycle step per rotate event regardless of tick magnitude", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      // A fast spin coalesces to ticks=3; the stateful camera commands compute
      // the next car/group from the CURRENT telemetry, so it is one step per event.
      surface.rotate(dialContext("d4") as never, dial({ mode: "car" }), 3, false);

      expect(host.cycle).toHaveBeenCalledTimes(1);
    });

    it("does nothing on a zero-tick event", () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      surface.rotate(dialContext("d5") as never, dial({ mode: "car" }), 0, false);

      expect(host.cycle).not.toHaveBeenCalled();
    });
  });

  describe("press gestures", () => {
    it("fires the press gesture (focus my car) on a short press", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("p1");
      const settings = dial({ pressAction: "focus-my-car" });

      surface.down(ctx as never, settings);
      await surface.up("p1");

      expect(host.focusMyCar).toHaveBeenCalled();
    });

    it("fires the long-press gesture (change camera) when held past the threshold", async () => {
      vi.useFakeTimers();
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("p2");
      const settings = dial({ pressAction: "none", longPressAction: "change-camera" });

      surface.down(ctx as never, settings);
      vi.advanceTimersByTime(600);
      await surface.up("p2");

      expect(host.changeCamera).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("fires no gesture on a push+turn (rotated while pressed)", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("p3");
      const settings = dial({ mode: "car", pressAction: "focus-my-car" });

      surface.down(ctx as never, settings);
      surface.rotate(ctx as never, settings, 1, true);

      // The rotation still cycles even while the button is held.
      expect(host.cycle).toHaveBeenCalledWith("cycle-car", "next");

      await surface.up("p3");

      expect(host.focusMyCar).not.toHaveBeenCalled();
    });

    it("does nothing when the press gesture is none", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("p4");
      const settings = dial({ pressAction: "none" });

      surface.down(ctx as never, settings);
      await surface.up("p4");

      expect(host.focusMyCar).not.toHaveBeenCalled();
      expect(host.changeCamera).not.toHaveBeenCalled();
    });
  });

  describe("touch gestures", () => {
    it("fires the tap gesture on a short touch", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      await surface.touchTap(dialContext("t1") as never, dial({ tapAction: "focus-my-car" }), false);

      expect(host.focusMyCar).toHaveBeenCalled();
    });

    it("fires the long-touch gesture on a long touch", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      await surface.touchTap(dialContext("t2") as never, dial({ longTouchAction: "change-camera" }), true);

      expect(host.changeCamera).toHaveBeenCalled();
    });

    it("does nothing when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      await surface.touchTap(dialContext("t3") as never, dial({ tapAction: "focus-my-car" }), false);

      expect(host.focusMyCar).not.toHaveBeenCalled();
    });
  });

  describe("feedback rendering", () => {
    it("pushes the focus dash box as a single touch-strip pixmap on willAppear", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f1");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));

      expect(ctx.setFeedback).toHaveBeenCalled();
      const feedback = ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string };

      expect(feedback.box).toContain("data:image/svg+xml");
      const decoded = decodeURIComponent(feedback.box);

      expect(decoded).toContain(">COCKPIT<");
      expect(decoded).toContain(">#42<");
    });

    it("shows an identity-only label box when out of session", async () => {
      const host = makeHost({ getTelemetry: vi.fn(() => null) });
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f2");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">CAR<");
      // Exactly one text node (label only — no value line).
      expect(decoded.match(/<text/g)?.length).toBe(1);
    });

    it("applies dash-box color overrides from dial settings (#811)", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f3");
      await surface.willAppear(
        ctx as never,
        dial({ mode: "car", colors: { borderColor: "#112233", backgroundColor: "#445566" } }),
      );

      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain('stroke="#112233"');
      expect(decoded).toContain('fill="#445566"');
    });

    it("pushes the encoder trigger description and the two-line name icon", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f4");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      const img = decodeURIComponent(ctx.setImage.mock.calls.at(-1)?.[0] as string);

      expect(img).toContain(">CAMERA<");
      expect(img).toContain(">CONTROLS<");
    });

    it("throttles feedback to the change-render window so the setFeedback cap holds", async () => {
      vi.useFakeTimers();
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f5");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));
      ctx.setFeedback.mockClear();

      // Within the 100 ms window: the focused car changes but the push is throttled.
      vi.advanceTimersByTime(50);
      mockCarNumber.value = "7";
      surface.onTelemetry("f5", TELEMETRY as never);

      expect(ctx.setFeedback).not.toHaveBeenCalled();

      // Past the window: the next change flushes one feedback push with the latest value.
      vi.advanceTimersByTime(100);
      mockCarNumber.value = "9";
      surface.onTelemetry("f5", TELEMETRY as never);

      expect(ctx.setFeedback).toHaveBeenCalledTimes(1);
      const decoded = decodeURIComponent((ctx.setFeedback.mock.calls.at(-1)?.[0] as { box: string }).box);

      expect(decoded).toContain(">#9<");
      vi.useRealTimers();
    });

    it("re-renders the box and trigger description when the settings change", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f6");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));
      ctx.setFeedback.mockClear();
      ctx.setTriggerDescription.mockClear();

      await surface.didReceiveSettings(ctx as never, dial({ mode: "camera" }));

      expect(ctx.setTriggerDescription).toHaveBeenCalled();
      expect(ctx.setFeedback).toHaveBeenCalled();
    });

    it("does not push feedback when dial feedback is disabled", async () => {
      vi.stubGlobal("__FEATURE_DIAL_FEEDBACK__", false);
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f7");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));

      expect(ctx.setFeedback).not.toHaveBeenCalled();
      expect(ctx.setTriggerDescription).not.toHaveBeenCalled();
    });

    it("re-renders every context on refreshAll (dash-box appearance edits offline)", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("f8");
      await surface.willAppear(ctx as never, dial({ mode: "car" }));
      ctx.setFeedback.mockClear();

      surface.refreshAll();

      expect(ctx.setFeedback).toHaveBeenCalled();
    });
  });

  describe("context lifecycle", () => {
    it("drops the context on willDisappear so a later release is a no-op", async () => {
      const host = makeHost();
      const surface = new CameraDialSurface(host as never);
      const ctx = dialContext("l1");
      await surface.willAppear(ctx as never, dial({ pressAction: "focus-my-car" }));

      surface.down(ctx as never, dial({ pressAction: "focus-my-car" }));
      surface.willDisappear("l1");
      await surface.up("l1");

      expect(host.focusMyCar).not.toHaveBeenCalled();
    });
  });
});
