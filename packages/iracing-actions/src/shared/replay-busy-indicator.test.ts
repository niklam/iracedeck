import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayBusyIndicator,
  getReplayBusyLook,
  registerReplayBusySurface,
  REPLAY_BUSY_FRAME_MS,
  REPLAY_BUSY_MAX_SHOW_MS,
  REPLAY_BUSY_NOT_DONE_MS,
  type ReplayBusyLook,
  reportReplayPressIgnored,
  setReplayBusyIndicatorLogger,
} from "./replay-busy-indicator.js";
import type { ReplayGateFactEnd, ReplayGateNotice, ReplayGateView } from "./replay-command-gate.js";

/** A fake of the gate's state seam: views per token, and notices a test emits. */
const gate = vi.hoisted(() => {
  const views = new Map<string, ReplayGateView>();
  const listeners = new Set<(notice: ReplayGateNotice) => void>();

  return { views, listeners };
});

vi.mock("./replay-command-gate.js", () => ({
  getReplayGateView: (origin: string): ReplayGateView => gate.views.get(origin) ?? { underWay: null, waiting: null },
  subscribeReplayGate: (listener: (notice: ReplayGateNotice) => void) => {
    gate.listeners.add(listener);

    return () => {
      gate.listeners.delete(listener);
    };
  },
}));

type Fact = { underWay?: number; waiting?: number };

/** Sets the gate's view of `origin` without telling anyone, as a change the indicator only reads. */
function setView(origin: string, fact: Fact): ReplayGateView {
  const view: ReplayGateView = {
    underWay: fact.underWay === undefined ? null : { since: fact.underWay, seen: false },
    waiting: fact.waiting === undefined ? null : { since: fact.waiting },
  };

  if (view.underWay === null && view.waiting === null) gate.views.delete(origin);
  else gate.views.set(origin, view);

  return view;
}

/** Sets the view and sends the gate's notice for it. */
function notify(origin: string, fact: Fact, ended: ReplayGateFactEnd[] = []): void {
  const view = setView(origin, fact);

  for (const listener of [...gate.listeners]) listener({ origin, view, ended });
}

const completed = (fact: "underWay" | "waiting" = "underWay"): ReplayGateFactEnd => ({
  fact,
  class: "completed",
  reason: fact === "waiting" ? "sent-on-landing" : "read-back",
});
const superseded: ReplayGateFactEnd = { fact: "underWay", class: "superseded", reason: "replaced" };
const gaveUp: ReplayGateFactEnd = { fact: "underWay", class: "gave-up", reason: "nothing-moved" };

function surface(token: string, drawsWorking = true) {
  const looks: ReplayBusyLook[] = [];
  const redraw = vi.fn((look: ReplayBusyLook) => {
    looks.push(look);
  });

  return { token, drawsWorking, redraw, looks };
}

const kinds = (looks: ReplayBusyLook[]): string[] =>
  looks.map((l) => (l.kind === "working" ? `working@${l.tick}` : l.kind));

function makeLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  };

  logger.withLevel.mockReturnValue(logger);
  logger.createScope.mockReturnValue(logger);

  return logger;
}

describe("replay busy indicator", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    gate.views.clear();
    gate.listeners.clear();
    _resetReplayBusyIndicator();
    logger = makeLogger();
    setReplayBusyIndicatorLogger(logger);
  });

  afterEach(() => {
    _resetReplayBusyIndicator();
    vi.useRealTimers();
  });

  it("draws nothing and holds no timer while no fact stands", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    vi.advanceTimersByTime(5_000);

    expect(key.redraw).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(getReplayBusyLook("k1")).toEqual({ kind: "rest" });
  });

  it("subscribes to the gate lazily, once, and the reset drops it", () => {
    expect(gate.listeners.size).toBe(0);

    registerReplayBusySurface(surface("k1"));
    registerReplayBusySurface(surface("k2"));

    expect(gate.listeners.size).toBe(1);

    _resetReplayBusyIndicator();

    expect(gate.listeners.size).toBe(0);
  });

  it("an unregistered token reads rest even with a fact standing", () => {
    setView("k1", { underWay: 1 });

    expect(getReplayBusyLook("k1")).toEqual({ kind: "rest" });
  });

  it("draws working on the first notice and steps every 125 ms", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: Date.now() });

    expect(kinds(key.looks)).toEqual(["working@0"]);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS - 1);
    expect(key.redraw).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(kinds(key.looks)).toEqual(["working@0", "working@1"]);

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 9);
    expect(kinds(key.looks).at(-1)).toBe("working@10");
    expect(getReplayBusyLook("k1")).toEqual({ kind: "working", tick: 10 });
  });

  it("logs the start and the end at debug and nothing at info", () => {
    registerReplayBusySurface(surface("k1"));
    notify("k1", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 4);
    notify("k1", {}, [completed()]);

    const debug = logger.debug.mock.calls.map((c) => String(c[0]));

    expect(debug.filter((m) => m.startsWith("Replay busy look started"))).toEqual([
      "Replay busy look started: k1 working (notice)",
    ]);
    expect(debug.filter((m) => m.startsWith("Replay busy look ended"))).toEqual([
      "Replay busy look ended: k1 was working (read-back)",
    ]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a fact that ends inside the first frame draws working once and rest once, and leaves no interval", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: Date.now() });
    vi.advanceTimersByTime(70);
    notify("k1", {}, [completed()]);

    expect(kinds(key.looks)).toEqual(["working@0", "rest"]);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(key.redraw).toHaveBeenCalledTimes(2);
  });

  it("waiting draws once and creates no interval", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { waiting: Date.now() });

    expect(kinds(key.looks)).toEqual(["waiting"]);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(key.redraw).toHaveBeenCalledTimes(1);
  });

  it("both facts draw waiting, with no interval", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: 1, waiting: 2 });

    expect(kinds(key.looks)).toEqual(["waiting"]);
    expect(getReplayBusyLook("k1")).toEqual({ kind: "waiting" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["completed", completed()],
    ["superseded", superseded],
  ])("%s returns to rest with one redraw", (_name, end) => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 3);
    key.redraw.mockClear();
    key.looks.length = 0;

    notify("k1", {}, [end]);

    expect(kinds(key.looks)).toEqual(["rest"]);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(key.redraw).toHaveBeenCalledTimes(1);
  });

  it("gave up draws not done at once and rest one second later", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 2);
    key.looks.length = 0;

    notify("k1", {}, [gaveUp]);

    expect(kinds(key.looks)).toEqual(["not-done"]);
    expect(getReplayBusyLook("k1")).toEqual({ kind: "not-done" });
    // The not-done timer only; the interval is gone.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(REPLAY_BUSY_NOT_DONE_MS - 1);
    expect(kinds(key.looks)).toEqual(["not-done"]);

    vi.advanceTimersByTime(1);
    expect(kinds(key.looks)).toEqual(["not-done", "rest"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a gave-up waiting fact draws not done too", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { waiting: 1 });
    notify("k1", {}, [{ fact: "waiting", class: "gave-up", reason: "wait-ran-out" }]);

    expect(kinds(key.looks)).toEqual(["waiting", "not-done"]);
  });

  it("an ignored press draws not done for one second", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    reportReplayPressIgnored("k1");

    expect(kinds(key.looks)).toEqual(["not-done"]);

    vi.advanceTimersByTime(REPLAY_BUSY_NOT_DONE_MS);
    expect(kinds(key.looks)).toEqual(["not-done", "rest"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an ignored press pressed again keeps not done without a second redraw, and restarts its second", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    reportReplayPressIgnored("k1");
    vi.advanceTimersByTime(600);
    reportReplayPressIgnored("k1");
    vi.advanceTimersByTime(600);

    expect(kinds(key.looks)).toEqual(["not-done"]);

    vi.advanceTimersByTime(400);
    expect(kinds(key.looks)).toEqual(["not-done", "rest"]);
  });

  it("an ignored press draws nothing on a key already working or waiting", () => {
    const working = surface("k1");
    const waiting = surface("k2");

    registerReplayBusySurface(working);
    registerReplayBusySurface(waiting);
    notify("k1", { underWay: Date.now() });
    notify("k2", { waiting: Date.now() });

    reportReplayPressIgnored("k1");
    reportReplayPressIgnored("k2");

    expect(kinds(working.looks)).toEqual(["working@0"]);
    expect(kinds(waiting.looks)).toEqual(["waiting"]);

    // Nothing stale once the facts end cleanly.
    notify("k1", {}, [completed()]);
    notify("k2", {}, [completed("waiting")]);
    vi.advanceTimersByTime(2_000);

    expect(kinds(working.looks)).toEqual(["working@0", "rest"]);
    expect(kinds(waiting.looks)).toEqual(["waiting", "rest"]);
  });

  it("an ignored press on an unregistered token does nothing", () => {
    reportReplayPressIgnored("nobody");

    expect(vi.getTimerCount()).toBe(0);
    expect(getReplayBusyLook("nobody")).toEqual({ kind: "rest" });
  });

  it("a not done pending when a fact starts standing is cleared, never shown after the fact ends cleanly", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    reportReplayPressIgnored("k1");
    vi.advanceTimersByTime(200);
    notify("k1", { underWay: Date.now() });

    expect(kinds(key.looks)).toEqual(["not-done", "working@0"]);

    vi.advanceTimersByTime(100);
    notify("k1", {}, [completed()]);

    expect(kinds(key.looks)).toEqual(["not-done", "working@0", "rest"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a gave-up and a new run in one notice keep working, with no not done after it", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: 1 });
    notify("k1", { underWay: 2 }, [gaveUp]);

    expect(kinds(key.looks)).toEqual(["working@0"]);

    notify("k1", {}, [completed()]);
    expect(kinds(key.looks)).toEqual(["working@0", "rest"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hand-over from waiting to under way goes waiting to working with no rest between", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { waiting: 10 });
    notify("k1", { underWay: 10 }, [completed("waiting")]);

    expect(kinds(key.looks)).toEqual(["waiting", "working@0"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a spin of detents on one token draws no rest between notices", () => {
    const key = surface("k1");
    const since = Date.now();

    registerReplayBusySurface(key);

    for (let i = 0; i < 6; i++) {
      notify("k1", { underWay: since }, i === 0 ? [] : [superseded]);
      vi.advanceTimersByTime(60);
    }

    expect(kinds(key.looks).every((k) => k.startsWith("working"))).toBe(true);
    // One draw on the first notice, then only the frames.
    expect(kinds(key.looks)).toEqual(["working@0", "working@1", "working@2"]);
  });

  it("a key that disappears is not redrawn, and the interval ends with the last one", () => {
    const a = surface("k1");
    const b = surface("k2");
    const offA = registerReplayBusySurface(a);
    const offB = registerReplayBusySurface(b);

    notify("k1", { underWay: Date.now() });
    notify("k2", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS);

    offA();
    const aCalls = a.redraw.mock.calls.length;

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 2);
    expect(a.redraw).toHaveBeenCalledTimes(aCalls);
    expect(vi.getTimerCount()).toBe(1);

    offB();
    expect(vi.getTimerCount()).toBe(0);

    notify("k1", {}, [gaveUp]);
    vi.advanceTimersByTime(2_000);
    expect(a.redraw).toHaveBeenCalledTimes(aCalls);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.debug.mock.calls.map((c) => String(c[0]))).toContain(
      "Replay busy look ended: k1 was working (unregistered)",
    );
  });

  it("a key that registers while a fact stands reads working at once, and the interval runs", () => {
    setView("k1", { underWay: Date.now() });

    const key = surface("k1");

    registerReplayBusySurface(key);

    expect(key.redraw).not.toHaveBeenCalled();
    expect(getReplayBusyLook("k1")).toEqual({ kind: "working", tick: 0 });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS);
    expect(kinds(key.looks)).toEqual(["working@1"]);
  });

  it("a key that registers while waiting reads waiting and starts no interval", () => {
    setView("k1", { waiting: Date.now() });
    registerReplayBusySurface(surface("k1"));

    expect(getReplayBusyLook("k1")).toEqual({ kind: "waiting" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a tick that finds the fact gone stops without a notice", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: Date.now() });
    setView("k1", {});
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS);

    expect(kinds(key.looks)).toEqual(["working@0", "rest"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.debug.mock.calls.map((c) => String(c[0]))).toContain("Replay busy look ended: k1 was working (tick)");
  });

  it("the five-minute ceiling stops the spinner while the fact stands, and warns once", () => {
    const key = surface("k1");
    const since = Date.now();

    registerReplayBusySurface(key);
    notify("k1", { underWay: since });

    vi.advanceTimersByTime(REPLAY_BUSY_MAX_SHOW_MS - REPLAY_BUSY_FRAME_MS);
    expect(key.looks.at(-1)?.kind).toBe("working");
    expect(logger.warn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS);
    expect(key.looks.at(-1)).toEqual({ kind: "rest" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getReplayBusyLook("k1")).toEqual({ kind: "rest" });

    // The same run, noticed again: still rest, no second warning.
    const calls = key.redraw.mock.calls.length;

    notify("k1", { underWay: since }, [superseded]);
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 10);
    expect(key.redraw).toHaveBeenCalledTimes(calls);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // A new run spins again.
    notify("k1", { underWay: since + 1 }, [completed()]);
    expect(key.looks.at(-1)).toEqual({ kind: "working", tick: 0 });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("the ceiling counts from when the key started showing working, kept across a page turn", () => {
    const key = surface("k1");
    const since = Date.now();
    const off = registerReplayBusySurface(key);

    notify("k1", { underWay: since });
    vi.advanceTimersByTime(REPLAY_BUSY_MAX_SHOW_MS / 2);
    off();
    vi.advanceTimersByTime(1_000);

    const back = surface("k1");

    registerReplayBusySurface(back);
    vi.advanceTimersByTime(REPLAY_BUSY_MAX_SHOW_MS / 2);

    expect(back.looks.at(-1)).toEqual({ kind: "rest" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("a redraw that throws does not stop the others or the interval", () => {
    const bad = surface("k1");
    const good = surface("k2");

    bad.redraw.mockImplementation(() => {
      throw new Error("host gone");
    });
    registerReplayBusySurface(bad);
    registerReplayBusySurface(good);
    notify("k1", { underWay: Date.now() });
    notify("k2", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 3);

    expect(bad.redraw).toHaveBeenCalledTimes(4);
    expect(kinds(good.looks)).toEqual(["working@0", "working@1", "working@2", "working@3"]);
    expect(logger.debug.mock.calls.some((c) => String(c[0]).startsWith("Replay busy redraw failed for k1"))).toBe(true);
  });

  it("two keys spinning share one interval and one step", () => {
    const a = surface("k1");
    const b = surface("k2");

    registerReplayBusySurface(a);
    registerReplayBusySurface(b);
    notify("k1", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 2);
    notify("k2", { underWay: Date.now() });

    expect(vi.getTimerCount()).toBe(1);
    expect(kinds(b.looks)).toEqual(["working@2"]);

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS);
    expect(a.looks.at(-1)).toEqual({ kind: "working", tick: 3 });
    expect(b.looks.at(-1)).toEqual({ kind: "working", tick: 3 });

    notify("k1", {}, [completed()]);
    expect(vi.getTimerCount()).toBe(1);

    notify("k2", {}, [completed()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the step counter starts from 0 each time the interval starts from none", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    notify("k1", { underWay: 1 });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 5);
    notify("k1", {}, [completed()]);
    notify("k1", { underWay: 2 });

    expect(key.looks.at(-1)).toEqual({ kind: "working", tick: 0 });
  });

  it("drawsWorking false never draws working, but does draw waiting and not done", () => {
    const key = surface("k1", false);

    registerReplayBusySurface(key);
    notify("k1", { underWay: Date.now() });
    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 20);

    expect(key.redraw).not.toHaveBeenCalled();
    expect(getReplayBusyLook("k1")).toEqual({ kind: "rest" });
    expect(vi.getTimerCount()).toBe(0);

    // A run of its own jumps that gives up part-way draws not done even as the next one stands.
    notify("k1", { underWay: Date.now() }, [gaveUp]);
    expect(kinds(key.looks)).toEqual(["not-done"]);

    vi.advanceTimersByTime(REPLAY_BUSY_NOT_DONE_MS);
    expect(kinds(key.looks)).toEqual(["not-done", "rest"]);

    notify("k1", { underWay: Date.now(), waiting: Date.now() });
    expect(kinds(key.looks)).toEqual(["not-done", "rest", "waiting"]);

    notify("k1", { underWay: Date.now() }, [completed("waiting")]);
    expect(kinds(key.looks)).toEqual(["not-done", "rest", "waiting", "rest"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unregistering an old registration leaves a newer one for the same token", () => {
    const first = surface("k1");
    const second = surface("k1");
    const offFirst = registerReplayBusySurface(first);

    registerReplayBusySurface(second);
    offFirst();

    notify("k1", { underWay: Date.now() });

    expect(first.redraw).not.toHaveBeenCalled();
    expect(kinds(second.looks)).toEqual(["working@0"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("registering again replaces the entry without a redraw, and its drawsWorking applies", () => {
    const spinning = surface("k1");

    registerReplayBusySurface(spinning);
    notify("k1", { underWay: Date.now() });
    expect(vi.getTimerCount()).toBe(1);

    // The key's mode changed to one whose own command is not a jump.
    const still = surface("k1", false);

    registerReplayBusySurface(still);

    expect(still.redraw).not.toHaveBeenCalled();
    expect(getReplayBusyLook("k1")).toEqual({ kind: "rest" });
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(REPLAY_BUSY_FRAME_MS * 4);
    expect(spinning.redraw).toHaveBeenCalledTimes(1);
  });

  it("the reset clears every timer, registration and look", () => {
    const key = surface("k1");

    registerReplayBusySurface(key);
    registerReplayBusySurface(surface("k2"));
    notify("k1", { underWay: Date.now() });
    reportReplayPressIgnored("k2");
    expect(vi.getTimerCount()).toBe(2);

    _resetReplayBusyIndicator();

    expect(vi.getTimerCount()).toBe(0);
    expect(getReplayBusyLook("k1")).toEqual({ kind: "rest" });
    expect(getReplayBusyLook("k2")).toEqual({ kind: "rest" });
  });

  it("unrefs its timers where the runtime offers it", () => {
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      handler: () => void,
      ms?: number,
    ): ReturnType<typeof setInterval> => {
      const handle = realSetInterval(handler, ms);

      return Object.assign(handle, { unref });
    }) as typeof setInterval);

    registerReplayBusySurface(surface("k1"));
    notify("k1", { underWay: Date.now() });

    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
