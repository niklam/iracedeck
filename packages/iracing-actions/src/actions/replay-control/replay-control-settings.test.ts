/**
 * Replay Control's settings through the REAL schema (#1316). The action's own
 * suite (`replay-control.test.ts`) mocks `CommonSettings.extend` as an identity
 * parse, which cannot see what a schema field does to a stored object; here
 * the mock builds a real zod object from the action's shape, so the `dial`
 * root key is parsed exactly as in production — only the `CommonSettings`
 * base fields are absent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReplayControlDialSettings } from "./replay-control-dial-settings.js";
import { ReplayControl } from "./replay-control.js";

const dialSurface = vi.hoisted(() => ({
  willAppear: vi.fn(async (_action: unknown, _dial: unknown) => {}),
  didReceiveSettings: vi.fn(async (_action: unknown, _dial: unknown) => {}),
  rotate: vi.fn((_action: unknown, _dial: unknown, _ticks: number, _pressed: boolean) => {}),
  down: vi.fn((_action: unknown, _dial: unknown) => {}),
  touchTap: vi.fn((_action: unknown, _dial: unknown, _hold: boolean) => {}),
}));

// The dial surface has its own suite; here it only records the `dial` the
// action parsed and handed it.
vi.mock("./replay-control-dial-surface.js", () => ({
  ReplayControlDialSurface: class MockReplayControlDialSurface {
    willAppear = dialSurface.willAppear;
    willDisappear = vi.fn();
    didReceiveSettings = dialSurface.didReceiveSettings;
    rotate = dialSurface.rotate;
    down = dialSurface.down;
    up = vi.fn();
    touchTap = dialSurface.touchTap;
    onTick = vi.fn();
  },
}));

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getCommands: vi.fn(() => ({ replay: {}, camera: {} })),
}));

vi.mock("@iracedeck/deck-core", async () => {
  const { z } = await import("zod");

  return {
    CommonSettings: { extend: (shape: never) => z.object(shape).passthrough() },
    ConnectionStateAwareAction: class MockConnectionStateAwareAction {
      logger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        createScope: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
      };
      sdkController = {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        getCurrentTelemetry: vi.fn(() => null),
        getSessionInfo: vi.fn(() => null),
      };
      async onWillAppear() {}
      async onDidReceiveSettings() {}
      async onWillDisappear() {}
    },
  };
});

vi.mock("@iracedeck/replay-store", () => ({
  getReplaySessionStore: vi.fn(),
  isReplaySessionStoreInitialized: vi.fn(() => false),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalColors: vi.fn(() => ({})),
  getGlobalSettings: vi.fn(() => ({})),
}));

/** The dial a keypad instance, or a dial that never opened its settings, parses to. */
const DEFAULT_DIAL = ReplayControlDialSettings.parse(undefined);

function parse(action: ReplayControl, stored: unknown): Record<string, unknown> {
  return action["parseSettings"](stored) as Record<string, unknown>;
}

function dialEvent(settings: unknown, payload: Record<string, unknown> = {}) {
  return {
    action: { id: "dial-1", isDial: () => true, setTitle: vi.fn(), setImage: vi.fn() },
    payload: { settings, ...payload },
  };
}

describe("ReplayControl settings (#1316)", () => {
  let action: ReplayControl;

  beforeEach(() => {
    vi.clearAllMocks();
    action = new ReplayControl();
  });

  describe("an existing keypad instance", () => {
    it.each<[string, Record<string, unknown>]>([
      ["a transport key", { mode: "play-pause", speed: "1", stepRate: 1, fastestLapTarget: "viewed-car" }],
      ["a set-speed key", { mode: "set-speed", speed: "s4", stepRate: 1, fastestLapTarget: "viewed-car" }],
      ["a step-rate key", { mode: "fast-forward", speed: "1", stepRate: 7, fastestLapTarget: "viewed-car" }],
      [
        "a fastest-lap key",
        { mode: "jump-to-fastest-lap", speed: "1", stepRate: 1, fastestLapTarget: "always-my-car" },
      ],
    ])("parses %s exactly as before, with the dial defaults beside it", (_name, stored) => {
      const { dial, ...keypad } = parse(action, stored);

      expect(keypad).toEqual(stored);
      expect(dial).toEqual(DEFAULT_DIAL);
    });

    it("keeps filling the keypad defaults of a key that stored nothing", () => {
      const { dial, ...keypad } = parse(action, {});

      expect(keypad).toEqual({ mode: "play-pause", speed: "1", stepRate: 1, fastestLapTarget: "viewed-car" });
      expect(dial).toEqual(DEFAULT_DIAL);
    });

    it("keeps coercing a step rate the Property Inspector stored as text", () => {
      expect(parse(action, { mode: "rewind", stepRate: "3" }).stepRate).toBe(3);
    });

    it("keeps the keys the schema does not name", () => {
      const stored = { mode: "next-lap", flagsOverlay: true, colorOverrides: { backgroundColor: "#112233" } };

      expect(parse(action, stored)).toMatchObject(stored);
    });

    it("still falls back to the full defaults when a keypad field is invalid", () => {
      const parsed = parse(action, { mode: "not-a-mode", speed: "8" });

      expect(parsed.mode).toBe("play-pause");
      expect(parsed.speed).toBe("1");
    });
  });

  describe("the dial root key", () => {
    it("parses what a dial stored and fills the rest", () => {
      const parsed = parse(action, {
        mode: "play-pause",
        dial: { pressAction: "reverse", speedStops: { "16": true, s4: false }, colors: { valueColor: "#ff0000" } },
      });
      const dial = parsed.dial as ReplayControlDialSettings;

      expect(dial.mode).toBe("speed");
      expect(dial.pressAction).toBe("reverse");
      expect(dial.longPressAction).toBe("set-1x-play");
      expect(dial.speedStops["16"]).toBe(true);
      expect(dial.speedStops.s4).toBe(false);
      expect(dial.speedStops["8"]).toBe(true);
      expect(dial.colors.valueColor).toBe("#ff0000");
    });

    it.each<[string, unknown]>([
      ["a string", "speed"],
      ["an array", ["speed"]],
      ["a number", 7],
      ["null", null],
    ])("degrades a dial that is %s to the dial defaults without resetting the keypad's mode", (_name, dial) => {
      const parsed = parse(action, { mode: "next-incident", speed: "4", dial });

      expect(parsed.mode).toBe("next-incident");
      expect(parsed.speed).toBe("4");
      expect(parsed.dial).toEqual(DEFAULT_DIAL);
    });

    it("keeps the keypad's mode when a dial field holds a value from a newer build", () => {
      const parsed = parse(action, { mode: "stop", dial: { mode: "a-newer-mode", pressAction: "a-newer-gesture" } });

      expect(parsed.mode).toBe("stop");
      expect(parsed.dial).toEqual(DEFAULT_DIAL);
    });

    it("ignores the keypad's mode on a dial: the dial's own mode is parsed beside it", () => {
      const parsed = parse(action, { mode: "next-lap", dial: {} });

      expect(parsed.mode).toBe("next-lap");
      expect((parsed.dial as ReplayControlDialSettings).mode).toBe("speed");
    });
  });

  describe("what a dial event hands the surface", () => {
    it("a dial that never stored settings appears with the full dial defaults", async () => {
      const ev = dialEvent({});

      await action.onWillAppear(ev as never);

      expect(dialSurface.willAppear).toHaveBeenCalledWith(ev.action, DEFAULT_DIAL);
    });

    it("every dial event parses the stored dial through the schema", async () => {
      const stored = { dial: { pressAction: "jump-to-live", tapAction: "not-a-gesture" } };
      const expected = ReplayControlDialSettings.parse(stored.dial);

      await action.onWillAppear(dialEvent(stored) as never);
      await action.onDidReceiveSettings(dialEvent(stored) as never);
      await action.onDialRotate(dialEvent(stored, { ticks: 2, pressed: false }) as never);
      await action.onDialDown(dialEvent(stored) as never);
      await action.onTouchTap(dialEvent(stored, { hold: true }) as never);

      expect(expected.pressAction).toBe("jump-to-live");
      expect(expected.tapAction).toBe("none");
      expect(dialSurface.willAppear).toHaveBeenCalledWith(expect.anything(), expected);
      expect(dialSurface.didReceiveSettings).toHaveBeenCalledWith(expect.anything(), expected);
      expect(dialSurface.rotate).toHaveBeenCalledWith(expect.anything(), expected, 2, false);
      expect(dialSurface.down).toHaveBeenCalledWith(expect.anything(), expected);
      expect(dialSurface.touchTap).toHaveBeenCalledWith(expect.anything(), expected, true);
    });
  });
});
