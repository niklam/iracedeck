import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, type Mock, type MockInstance, vi } from "vitest";

import { classifyDialRelease } from "./dial-gesture.js";
import { createFakeSimConnection, type FakeSimConnection } from "./fake-sim-connection.js";
import {
  _resetPressSounds,
  DEFAULT_DIAL_PRESS_SHAPE,
  DEFAULT_KEY_PRESS_SHAPE,
  getPressSoundMode,
  initPressSounds,
  type PressSound,
  withPressSounds,
} from "./press-sounds.js";
import { _resetSimConnection, initializeSimConnection } from "./sim-connection.js";
import type {
  IDeckActionContext,
  IDeckActionHandler,
  IDeckDialDownEvent,
  IDeckDialRotateEvent,
  IDeckEvent,
  IDeckKeyDownEvent,
  IDeckTouchTapEvent,
  PressShape,
} from "./types.js";

// The mode is a global-settings name, so it is mocked on @iracedeck/settings (#1351).
const { settings } = vi.hoisted(() => ({ settings: { current: {} as Record<string, unknown> } }));

vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: vi.fn(() => settings.current),
}));

const THRESHOLD = 500;

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

const context = (id: string): IDeckActionContext => ({ id }) as IDeckActionContext;

const ev = (id = "ctx-1"): IDeckEvent<unknown> => ({ action: context(id), payload: { settings: {} } });

const rotateEv = (pressed: boolean, id = "ctx-1"): IDeckDialRotateEvent<unknown> => ({
  action: context(id),
  payload: { settings: {}, ticks: 1, pressed },
});

const touchEv = (hold: boolean, id = "ctx-1"): IDeckTouchTapEvent<unknown> => ({
  action: context(id),
  payload: { settings: {}, tapPos: [0, 0], hold },
});

type ShapeSource = PressShape | (() => PressShape) | undefined;

/** A handler with every press member, declaring `shape` (or none when `undefined`). */
function makeHandler(shape?: ShapeSource) {
  const handler = {
    onKeyDown: vi.fn(async (_ev: IDeckKeyDownEvent<unknown>) => {}),
    onKeyUp: vi.fn(async (_ev: IDeckEvent<unknown>) => {}),
    onDialDown: vi.fn(async (_ev: IDeckDialDownEvent<unknown>) => {}),
    onDialUp: vi.fn(async (_ev: IDeckEvent<unknown>) => {}),
    onDialRotate: vi.fn(async (_ev: IDeckDialRotateEvent<unknown>) => {}),
    onTouchTap: vi.fn(async (_ev: IDeckTouchTapEvent<unknown>) => {}),
    onWillDisappear: vi.fn(async (_ev: IDeckEvent<unknown>) => {}),
    onDidReceiveSettings: vi.fn(async (_ev: IDeckEvent<unknown>) => {}),
    pressShape: undefined as
      | ((ev: IDeckKeyDownEvent<unknown> | IDeckDialDownEvent<unknown> | IDeckTouchTapEvent<unknown>) => PressShape)
      | undefined,
  } satisfies IDeckActionHandler<unknown>;

  if (shape !== undefined) {
    handler.pressShape = vi.fn(() => (typeof shape === "function" ? shape() : shape));
  }

  return handler;
}

const release = (short: boolean, long: boolean, thresholdMs = THRESHOLD): PressShape => ({
  kind: "release",
  thresholdMs,
  short,
  long,
});

let played: PressSound[];
let play: Mock<(sound: PressSound) => void>;
let logger: ILogger;
let sim: FakeSimConnection;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  played = [];
  play = vi.fn<(sound: PressSound) => void>((sound) => {
    played.push(sound);
  });
  logger = createMockLogger();
  settings.current = { pressSound: "both" };
  sim = createFakeSimConnection();
  initializeSimConnection(sim.connection);
  initPressSounds({ play, logger });
});

afterEach(() => {
  _resetPressSounds();
  _resetSimConnection();
  vi.useRealTimers();
});

/** Down on a key, hold for `ms`, release. */
async function keyPress(wrapped: IDeckActionHandler<unknown>, ms: number, id = "ctx-1"): Promise<void> {
  await wrapped.onKeyDown!(ev(id));
  vi.advanceTimersByTime(ms);
  await wrapped.onKeyUp!(ev(id));
}

async function dialPress(wrapped: IDeckActionHandler<unknown>, ms: number, id = "ctx-1"): Promise<void> {
  await wrapped.onDialDown!(ev(id));
  vi.advanceTimersByTime(ms);
  await wrapped.onDialUp!(ev(id));
}

describe("withPressSounds — shapes (issue #269)", () => {
  it("tap: clicks at down and never bleeps", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "tap" }));

    await wrapped.onKeyDown!(ev());
    expect(played).toEqual(["tap"]);

    vi.advanceTimersByTime(10_000);
    await wrapped.onKeyUp!(ev());
    expect(played).toEqual(["tap"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hold: clicks at down and bleeps once at the threshold, not before and not again", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onKeyDown!(ev());
    expect(played).toEqual(["tap"]);

    vi.advanceTimersByTime(THRESHOLD - 1);
    expect(played).toEqual(["tap"]);

    vi.advanceTimersByTime(1);
    expect(played).toEqual(["tap", "long"]);

    vi.advanceTimersByTime(10_000);
    await wrapped.onKeyUp!(ev());
    expect(played).toEqual(["tap", "long"]);
  });

  it("hold: a release before the threshold never bleeps", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await keyPress(wrapped, THRESHOLD - 1);
    vi.advanceTimersByTime(10_000);

    expect(played).toEqual(["tap"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("release: clicks at a short release with short set, not at down", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onKeyDown!(ev());
    expect(played).toEqual([]);

    vi.advanceTimersByTime(100);
    await wrapped.onKeyUp!(ev());
    expect(played).toEqual(["tap"]);
  });

  it("release: no click at a short release with short unset", async () => {
    const wrapped = withPressSounds(makeHandler(release(false, true)));

    await keyPress(wrapped, 100);

    expect(played).toEqual([]);
  });

  it("release: never clicks at a long release", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, false)));

    await keyPress(wrapped, THRESHOLD + 200);

    expect(played).toEqual([]);
  });

  it("release: bleeps at the threshold with long set, and the long release does not click", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    vi.advanceTimersByTime(THRESHOLD - 1);
    expect(played).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(played).toEqual(["long"]);

    vi.advanceTimersByTime(300);
    await wrapped.onDialUp!(ev());
    expect(played).toEqual(["long"]);
  });

  it("release: never bleeps with long unset, and arms no timer", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, false)));

    await wrapped.onDialDown!(ev());
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(played).toEqual([]);
  });

  it("a pressed rotation disarms the bleep and silences the release", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    vi.advanceTimersByTime(100);
    await wrapped.onDialRotate!(rotateEv(true));
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(THRESHOLD);
    await wrapped.onDialUp!(ev());
    expect(played).toEqual([]);
  });

  it("a short push+turn is silent at release too", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    await wrapped.onDialRotate!(rotateEv(true));
    vi.advanceTimersByTime(50);
    await wrapped.onDialUp!(ev());

    expect(played).toEqual([]);
  });

  it("a rotation that comes after the bleep still silences the release", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    vi.advanceTimersByTime(THRESHOLD + 50);
    await wrapped.onDialRotate!(rotateEv(true));
    await wrapped.onDialUp!(ev());

    expect(played).toEqual(["long"]);
  });

  it("an unpressed rotation changes nothing", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    await wrapped.onDialRotate!(rotateEv(false));
    vi.advanceTimersByTime(THRESHOLD);

    expect(played).toEqual(["long"]);
  });

  it("long: bleeps at once", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "long" }));

    await wrapped.onKeyDown!(ev());
    expect(played).toEqual(["long"]);

    await wrapped.onTouchTap!(touchEv(true));
    expect(played).toEqual(["long", "long"]);
  });

  it("none: plays nothing and arms nothing", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "none" }));

    await wrapped.onKeyDown!(ev());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    await wrapped.onKeyUp!(ev());
    await wrapped.onTouchTap!(touchEv(false));

    expect(played).toEqual([]);
  });

  it("a threshold no timer can hold (Infinity) arms nothing and never bleeps", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "release", thresholdMs: Infinity, short: true, long: true }));

    await wrapped.onDialDown!(ev());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    await wrapped.onDialUp!(ev());

    // Never long at an infinite threshold, so the release is short and clicks.
    expect(played).toEqual(["tap"]);
  });
});

describe("withPressSounds — defaults when a handler declares no shape", () => {
  it("a key is a tap", async () => {
    const wrapped = withPressSounds(makeHandler());

    await keyPress(wrapped, THRESHOLD + 500);

    expect(played).toEqual(["tap"]);
    expect(DEFAULT_KEY_PRESS_SHAPE).toEqual({ kind: "tap" });
  });

  it("a dial is a release at 500 ms that clicks when short and never bleeps", async () => {
    expect(DEFAULT_DIAL_PRESS_SHAPE).toEqual({ kind: "release", thresholdMs: 500, short: true, long: false });

    const wrapped = withPressSounds(makeHandler());

    await dialPress(wrapped, 499);
    expect(played).toEqual(["tap"]);

    await dialPress(wrapped, 500);
    expect(played).toEqual(["tap"]);
  });

  it("a touch is a tap", async () => {
    const wrapped = withPressSounds(makeHandler());

    await wrapped.onTouchTap!(touchEv(false));
    await wrapped.onTouchTap!(touchEv(true));

    expect(played).toEqual(["tap", "tap"]);
  });
});

describe("withPressSounds — touch", () => {
  it("asks pressShape with the touch event", async () => {
    const handler = makeHandler({ kind: "tap" });
    const wrapped = withPressSounds(handler);
    const touch = touchEv(true);

    await wrapped.onTouchTap!(touch);

    expect(handler.pressShape).toHaveBeenCalledWith(touch);
    expect(handler.onTouchTap).toHaveBeenCalledWith(touch);
  });

  it("a release shape reads the touch's own hold flag", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onTouchTap!(touchEv(false));
    await wrapped.onTouchTap!(touchEv(true));
    expect(played).toEqual(["tap", "long"]);

    const silent = withPressSounds(makeHandler(release(false, false)));

    await silent.onTouchTap!(touchEv(false));
    await silent.onTouchTap!(touchEv(true));
    expect(played).toEqual(["tap", "long"]);
  });

  it("touch arms no timer and records no press", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onTouchTap!(touchEv(false));
    expect(vi.getTimerCount()).toBe(0);
    expect(played).toEqual(["tap"]);
  });
});

describe("withPressSounds — modes", () => {
  it("taps plays clicks only", async () => {
    settings.current = { pressSound: "taps" };
    const hold = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));
    const rel = withPressSounds(makeHandler(release(true, true)));
    const long = withPressSounds(makeHandler({ kind: "long" }));

    await keyPress(hold, THRESHOLD + 100);
    await keyPress(rel, 100, "ctx-2");
    await keyPress(rel, THRESHOLD + 100, "ctx-2");
    await long.onKeyDown!(ev("ctx-3"));

    expect(played).toEqual(["tap", "tap"]);
  });

  it("taps arms no bleep timer", async () => {
    settings.current = { pressSound: "taps" };
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onKeyDown!(ev());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("long-press plays bleeps only", async () => {
    settings.current = { pressSound: "long-press" };
    const tap = withPressSounds(makeHandler({ kind: "tap" }));
    const hold = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));
    const rel = withPressSounds(makeHandler(release(true, true)));

    await keyPress(tap, 10);
    await keyPress(hold, THRESHOLD + 100, "ctx-2");
    await keyPress(rel, 100, "ctx-3");
    await keyPress(rel, THRESHOLD + 100, "ctx-3");

    expect(played).toEqual(["long", "long"]);
  });

  it("both plays clicks and bleeps", async () => {
    const hold = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await keyPress(hold, THRESHOLD + 100);

    expect(played).toEqual(["tap", "long"]);
  });

  it("none arms nothing and never calls pressShape", async () => {
    settings.current = { pressSound: "none" };
    const handler = makeHandler({ kind: "hold", thresholdMs: THRESHOLD });
    const wrapped = withPressSounds(handler);

    await keyPress(wrapped, 10);
    await wrapped.onKeyDown!(ev());
    expect(vi.getTimerCount()).toBe(0);
    await wrapped.onDialDown!(ev("ctx-2"));
    await wrapped.onTouchTap!(touchEv(true, "ctx-3"));
    vi.advanceTimersByTime(10_000);

    expect(handler.pressShape).not.toHaveBeenCalled();
    expect(played).toEqual([]);
    // The press itself still reaches the action.
    expect(handler.onKeyDown).toHaveBeenCalledTimes(2);
    expect(handler.onDialDown).toHaveBeenCalledTimes(1);
    expect(handler.onTouchTap).toHaveBeenCalledTimes(1);
  });

  it("a missing or unknown stored mode reads as none", async () => {
    for (const value of [undefined, "clicks", 3, null]) {
      settings.current = { pressSound: value };
      const handler = makeHandler({ kind: "tap" });

      await withPressSounds(handler).onKeyDown!(ev());

      expect(handler.pressShape).not.toHaveBeenCalled();
    }

    expect(played).toEqual([]);
  });

  it("a mode change mid-press does not change that press", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onKeyDown!(ev());
    settings.current = { pressSound: "none" };
    vi.advanceTimersByTime(THRESHOLD);

    expect(played).toEqual(["tap", "long"]);
  });

  it("a mode switched on mid-press does not sound that press", async () => {
    settings.current = { pressSound: "none" };
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onKeyDown!(ev());
    settings.current = { pressSound: "both" };
    vi.advanceTimersByTime(100);
    await wrapped.onKeyUp!(ev());

    expect(played).toEqual([]);
  });
});

describe("withPressSounds — the sim connection", () => {
  it("disconnected at down plays nothing and never calls pressShape", async () => {
    sim.state.connected = false;
    const handler = makeHandler({ kind: "hold", thresholdMs: THRESHOLD });
    const wrapped = withPressSounds(handler);

    await keyPress(wrapped, THRESHOLD + 100);
    await wrapped.onTouchTap!(touchEv(false));

    expect(handler.pressShape).not.toHaveBeenCalled();
    expect(played).toEqual([]);
    expect(handler.onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("a disconnect mid-press does not change that press", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onKeyDown!(ev());
    sim.state.connected = false;
    vi.advanceTimersByTime(THRESHOLD);

    expect(played).toEqual(["tap", "long"]);
  });

  it("a connect mid-press does not sound that press", async () => {
    sim.state.connected = false;
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onKeyDown!(ev());
    sim.state.connected = true;
    vi.advanceTimersByTime(100);
    await wrapped.onKeyUp!(ev());

    expect(played).toEqual([]);
  });

  it("a connection that throws reads as disconnected", async () => {
    const handler = makeHandler({ kind: "tap" });
    sim.connection.isConnected = () => {
      throw new Error("sim gone");
    };

    await withPressSounds(handler).onKeyDown!(ev());

    expect(played).toEqual([]);
    expect(handler.onKeyDown).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalled();
  });

  it("before a sim connection exists nothing plays", async () => {
    _resetSimConnection();

    await withPressSounds(makeHandler({ kind: "tap" })).onKeyDown!(ev());

    expect(played).toEqual([]);
  });
});

describe("withPressSounds — lifecycle", () => {
  it("onWillDisappear mid-hold arms nothing further and forwards", async () => {
    const handler = makeHandler({ kind: "hold", thresholdMs: THRESHOLD });
    const wrapped = withPressSounds(handler);

    await wrapped.onKeyDown!(ev());
    await wrapped.onWillDisappear!(ev());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(THRESHOLD * 2);

    expect(played).toEqual(["tap"]);
    expect(handler.onWillDisappear).toHaveBeenCalledTimes(1);
  });

  it("onDidReceiveSettings mid-press arms nothing further, silences the release, and forwards", async () => {
    const handler = makeHandler(release(true, true));
    const wrapped = withPressSounds(handler);

    await wrapped.onDialDown!(ev());
    await wrapped.onDidReceiveSettings!(ev());
    vi.advanceTimersByTime(THRESHOLD * 2);
    await wrapped.onDialUp!(ev());

    expect(played).toEqual([]);
    expect(handler.onDidReceiveSettings).toHaveBeenCalledTimes(1);
  });

  it("a second down replaces a press whose up was lost", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    vi.advanceTimersByTime(300);
    await wrapped.onDialDown!(ev());
    expect(vi.getTimerCount()).toBe(1);

    // The first press's bleep would have been due at 500.
    vi.advanceTimersByTime(THRESHOLD - 1);
    expect(played).toEqual([]);

    // The second press is short from its own down.
    await wrapped.onDialUp!(ev());
    expect(played).toEqual(["tap"]);
  });

  it("a second down with the mode now none still drops the lost press", async () => {
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onKeyDown!(ev());
    settings.current = { pressSound: "none" };
    await wrapped.onKeyDown!(ev());
    vi.advanceTimersByTime(THRESHOLD * 2);

    expect(played).toEqual(["tap"]);
  });

  it("an up with no down plays nothing", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onKeyUp!(ev());
    await wrapped.onDialUp!(ev());

    expect(played).toEqual([]);
  });

  it("an up from the other surface does not end the press", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev());
    await wrapped.onKeyUp!(ev());
    vi.advanceTimersByTime(100);
    await wrapped.onDialUp!(ev());

    expect(played).toEqual(["tap"]);
  });

  it("presses on separate contexts are independent", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true)));

    await wrapped.onDialDown!(ev("a"));
    vi.advanceTimersByTime(200);
    await wrapped.onDialDown!(ev("b"));
    vi.advanceTimersByTime(100);
    await wrapped.onDialUp!(ev("a")); // 300 ms: short
    vi.advanceTimersByTime(THRESHOLD);
    await wrapped.onDialUp!(ev("b")); // 600 ms: long, bleeped at 500

    expect(played).toEqual(["tap", "long"]);
  });

  it("before initPressSounds nothing plays and pressShape is never called", async () => {
    _resetPressSounds();
    const handler = makeHandler({ kind: "hold", thresholdMs: THRESHOLD });

    await keyPress(withPressSounds(handler), THRESHOLD + 100);

    expect(handler.pressShape).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it("initPressSounds refuses a second call", () => {
    expect(() => initPressSounds({ play })).toThrow(/already initialized/);
  });
});

describe("withPressSounds — failures never escape", () => {
  it("a throwing pressShape plays nothing, is logged at debug, and the press still runs", async () => {
    const handler = makeHandler(() => {
      throw new Error("bad shape");
    });
    const wrapped = withPressSounds(handler);

    await keyPress(wrapped, THRESHOLD + 100);
    await wrapped.onTouchTap!(touchEv(false));
    await dialPress(wrapped, 50, "ctx-2");

    expect(played).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("bad shape"));
    expect(handler.onKeyDown).toHaveBeenCalledTimes(1);
    expect(handler.onKeyUp).toHaveBeenCalledTimes(1);
  });

  it("a throwing play inside the timer does not escape", async () => {
    play.mockImplementation((sound) => {
      if (sound === "long") throw new Error("device gone");
    });
    const wrapped = withPressSounds(makeHandler({ kind: "hold", thresholdMs: THRESHOLD }));

    await wrapped.onKeyDown!(ev());

    expect(() => vi.advanceTimersByTime(THRESHOLD)).not.toThrow();
    expect(play).toHaveBeenCalledWith("long");
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("device gone"));
  });

  it("a throwing play at down or up does not fail the press", async () => {
    play.mockImplementation(() => {
      throw new Error("device gone");
    });
    const handler = makeHandler(release(true, true));
    const tap = makeHandler({ kind: "tap" });

    await expect(withPressSounds(tap).onKeyDown!(ev())).resolves.toBeUndefined();
    await expect(keyPress(withPressSounds(handler), 50, "ctx-2")).resolves.toBeUndefined();

    expect(play).toHaveBeenCalledTimes(2);
    expect(tap.onKeyDown).toHaveBeenCalledTimes(1);
    expect(handler.onKeyUp).toHaveBeenCalledTimes(1);
  });

  it("a play that returns a rejected promise is caught", async () => {
    play.mockImplementation(() => Promise.reject(new Error("async failure")) as unknown as void);

    await withPressSounds(makeHandler({ kind: "tap" })).onKeyDown!(ev());
    await vi.runAllTimersAsync();

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("async failure"));
  });

  it("a mode read that throws plays nothing and the press still runs", async () => {
    const handler = makeHandler({ kind: "tap" });
    settings.current = new Proxy(
      {},
      {
        get: () => {
          throw new Error("cache broken");
        },
      },
    );

    await withPressSounds(handler).onKeyDown!(ev());

    expect(played).toEqual([]);
    expect(handler.onKeyDown).toHaveBeenCalledTimes(1);
  });
});

describe("withPressSounds — ordering against the handler", () => {
  it("the down sound plays after the handler's synchronous part and before its promise settles", async () => {
    const order: string[] = [];
    let finish!: () => void;
    const handler = makeHandler({ kind: "tap" });
    handler.onKeyDown.mockImplementation(() => {
      order.push("handler-sync");

      return new Promise<void>((resolve) => {
        finish = () => {
          order.push("handler-settled");
          resolve();
        };
      });
    });
    play.mockImplementation((sound) => {
      order.push(`play:${sound}`);
    });

    const pending = withPressSounds(handler).onKeyDown!(ev());

    expect(order).toEqual(["handler-sync", "play:tap"]);

    finish();
    await pending;
    expect(order).toEqual(["handler-sync", "play:tap", "handler-settled"]);
  });

  it("pressShape is asked before the handler runs", async () => {
    const order: string[] = [];
    const handler = makeHandler(() => {
      order.push("shape");

      return { kind: "tap" };
    });
    handler.onDialDown.mockImplementation(async () => {
      order.push("handler");
    });

    await withPressSounds(handler).onDialDown!(ev());

    expect(order).toEqual(["shape", "handler"]);
  });

  it("the up click plays after the handler's synchronous part and before its promise settles", async () => {
    const order: string[] = [];
    let finish!: () => void;
    const handler = makeHandler(release(true, true));
    handler.onDialUp.mockImplementation(() => {
      order.push("handler-sync");

      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    play.mockImplementation((sound) => {
      order.push(`play:${sound}`);
    });
    const wrapped = withPressSounds(handler);

    await wrapped.onDialDown!(ev());
    vi.advanceTimersByTime(100);
    const pending = wrapped.onDialUp!(ev());

    expect(order).toEqual(["handler-sync", "play:tap"]);
    finish();
    await pending;
  });

  it("a handler rejection reaches the caller, after the sound", async () => {
    const handler = makeHandler({ kind: "tap" });
    handler.onKeyDown.mockRejectedValue(new Error("press failed"));

    await expect(withPressSounds(handler).onKeyDown!(ev())).rejects.toThrow("press failed");
    expect(played).toEqual(["tap"]);
  });

  it("a synchronous throw from the handler reaches the caller, plays nothing and records nothing", async () => {
    const handler = makeHandler({ kind: "hold", thresholdMs: THRESHOLD });
    handler.onKeyDown.mockImplementation(() => {
      throw new Error("sync failure");
    });

    await expect(withPressSounds(handler).onKeyDown!(ev())).rejects.toThrow("sync failure");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(THRESHOLD);
    expect(played).toEqual([]);
  });
});

describe("the threshold boundary (positive control)", () => {
  it("a release exactly at the threshold is long for both the wrapper and classifyDialRelease", async () => {
    expect(
      classifyDialRelease({ pressStartMs: 0, nowMs: THRESHOLD, rotatedWhilePressed: false, thresholdMs: THRESHOLD }),
    ).toBe("long");

    // short-only: a long release is silent, so silence at exactly the threshold
    // shows the wrapper read it as long.
    const wrapped = withPressSounds(makeHandler(release(true, false)));
    await keyPress(wrapped, THRESHOLD);
    expect(played).toEqual([]);
  });

  it("one millisecond under the threshold is short for both", async () => {
    expect(
      classifyDialRelease({
        pressStartMs: 0,
        nowMs: THRESHOLD - 1,
        rotatedWhilePressed: false,
        thresholdMs: THRESHOLD,
      }),
    ).toBe("short");

    const wrapped = withPressSounds(makeHandler(release(true, false)));
    await keyPress(wrapped, THRESHOLD - 1);
    expect(played).toEqual(["tap"]);
  });

  it("follows the shape's own threshold, not the default", async () => {
    const wrapped = withPressSounds(makeHandler(release(true, true, 800)));

    await wrapped.onKeyDown!(ev());
    vi.advanceTimersByTime(799);
    expect(played).toEqual([]);
    await wrapped.onKeyUp!(ev());

    expect(played).toEqual(["tap"]);
  });
});

describe("withPressSounds — forwarding every IDeckActionHandler member", () => {
  type Member = keyof IDeckActionHandler<unknown>;

  const MEMBERS = [
    "pressShape",
    "onWillAppear",
    "onWillDisappear",
    "onDidReceiveSettings",
    "onKeyDown",
    "onKeyUp",
    "onDialRotate",
    "onDialDown",
    "onDialUp",
    "onTouchTap",
  ] as const satisfies readonly Member[];

  it("lists every member of the interface (a member added later fails this typecheck)", () => {
    expectTypeOf<Member>().toEqualTypeOf<(typeof MEMBERS)[number]>();
  });

  it("the wrapper has exactly the interface's members as keys", () => {
    const wrapped = withPressSounds({});

    expect(Object.keys(wrapped).sort()).toEqual([...MEMBERS].sort());
  });

  it("calls every member on the original handler, with the same event, `this` and result", async () => {
    settings.current = { pressSound: "none" };
    const thisSeen: Partial<Record<Member, unknown>> = {};
    const shape: PressShape = { kind: "tap" };

    class Handler implements IDeckActionHandler<unknown> {
      pressShape(_ev: unknown): PressShape {
        thisSeen.pressShape = this;

        return shape;
      }
      async onWillAppear(): Promise<void> {
        thisSeen.onWillAppear = this;
      }
      async onWillDisappear(): Promise<void> {
        thisSeen.onWillDisappear = this;
      }
      async onDidReceiveSettings(): Promise<void> {
        thisSeen.onDidReceiveSettings = this;
      }
      async onKeyDown(): Promise<void> {
        thisSeen.onKeyDown = this;
      }
      async onKeyUp(): Promise<void> {
        thisSeen.onKeyUp = this;
      }
      async onDialRotate(): Promise<void> {
        thisSeen.onDialRotate = this;
      }
      async onDialDown(): Promise<void> {
        thisSeen.onDialDown = this;
      }
      async onDialUp(): Promise<void> {
        thisSeen.onDialUp = this;
      }
      async onTouchTap(): Promise<void> {
        thisSeen.onTouchTap = this;
      }
    }

    const handler = new Handler();
    const spies = Object.fromEntries(MEMBERS.map((m) => [m, vi.spyOn(handler, m)])) as unknown as Record<
      Member,
      MockInstance
    >;
    const wrapped = withPressSounds(handler);
    const e = ev();
    const rotate = rotateEv(true);
    const touch = touchEv(false);

    expect(wrapped.pressShape!(e)).toBe(shape);
    await wrapped.onWillAppear!(e);
    await wrapped.onWillDisappear!(e);
    await wrapped.onDidReceiveSettings!(e);
    await wrapped.onKeyDown!(e);
    await wrapped.onKeyUp!(e);
    await wrapped.onDialRotate!(rotate);
    await wrapped.onDialDown!(e);
    await wrapped.onDialUp!(e);
    await wrapped.onTouchTap!(touch);

    for (const member of MEMBERS) {
      expect(spies[member], member).toHaveBeenCalledTimes(1);
      expect(thisSeen[member], member).toBe(handler);
    }

    expect(spies.onDialRotate).toHaveBeenCalledWith(rotate);
    expect(spies.onTouchTap).toHaveBeenCalledWith(touch);
    expect(spies.onKeyDown).toHaveBeenCalledWith(e);
  });

  it("a member the handler lacks stays undefined, except the ones that end a press", async () => {
    const wrapped = withPressSounds({});

    expect(wrapped.pressShape).toBeUndefined();
    expect(wrapped.onWillAppear).toBeUndefined();
    expect(wrapped.onKeyDown).toBeUndefined();
    expect(wrapped.onDialDown).toBeUndefined();
    expect(wrapped.onTouchTap).toBeUndefined();

    // Defined and harmless: forwarding through optional chaining.
    await expect(wrapped.onKeyUp!(ev())).resolves.toBeUndefined();
    await expect(wrapped.onDialUp!(ev())).resolves.toBeUndefined();
    await expect(wrapped.onDialRotate!(rotateEv(true))).resolves.toBeUndefined();
    await expect(wrapped.onWillDisappear!(ev())).resolves.toBeUndefined();
    await expect(wrapped.onDidReceiveSettings!(ev())).resolves.toBeUndefined();
  });
});

describe("getPressSoundMode", () => {
  it.each(["none", "taps", "long-press", "both"])("reads %s", (mode) => {
    settings.current = { pressSound: mode };

    expect(getPressSoundMode()).toBe(mode);
  });

  it("falls back to none when missing or unknown", () => {
    for (const value of [undefined, "", "BOTH", 1, true, null, {}]) {
      settings.current = { pressSound: value };

      expect(getPressSoundMode()).toBe("none");
    }

    settings.current = {};
    expect(getPressSoundMode()).toBe("none");
  });
});
