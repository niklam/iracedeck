/**
 * The line ends on their own (issue #1514): the three predicates that read
 * a playing fire's position — over fresh and resumed fires, in the preroll,
 * mid-body, in a trailing pause and in the close — and `LineEnds` over a
 * fake bus, a real `BusTable` and spies for the scheduler, the triggers and
 * playback: one subscription per event, the two passes in table order, and
 * each outcome's call and note.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventName } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "./dsl.js";
import { DEFAULT_FRAME } from "./dsl.js";
import {
  type ActiveFire,
  type ActiveFireView,
  BusTable,
  type CompiledScenario,
  type ExecOp,
  type WaitingFire,
} from "./engine-types.js";
import { LineEnds, lineFinished, startedSourceOps, wordsHeard } from "./line-ends.js";
import { PendingQueue } from "./pending-queue.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const play = (path: string, frame?: ExecOp["frame"]): ExecOp => ({
  kind: "play",
  channel: AudioChannel.Voice,
  path,
  frame,
});
const sfx = (path: string, frame?: ExecOp["frame"]): ExecOp => ({
  kind: "play",
  channel: AudioChannel.SFX,
  path,
  frame,
});
const pause = (ms: number, frame?: ExecOp["frame"]): ExecOp => ({ kind: "pause", ms, frame });
const ambient = (action: "start" | "stop", frame?: ExecOp["frame"]): ExecOp => ({ kind: "ambient", action, frame });

/** A framed body: open (tick, bed), two words, a trailing pause, close (bed stop, tick). */
const FRAMED: ExecOp[] = [
  sfx("tick-open.mp3", "open"),
  ambient("start", "open"),
  play("one.mp3"),
  play("two.mp3"),
  pause(400),
  ambient("stop", "close"),
  sfx("tick-close.mp3", "close"),
];

/** A fresh fire `index` ops in: `sourceOps === ops`, no preroll. */
function fresh(ops: ExecOp[], index: number): ActiveFireView {
  return fire({ ops, sourceOps: ops, sourceStart: 0, prerollCount: 0, index });
}

/**
 * A fire resumed at `sourceStart` of `sourceOps` with the open replayed
 * ahead of the tail, `index` ops into the RESUMED list.
 */
function resumed(sourceOps: ExecOp[], sourceStart: number, index: number): ActiveFireView {
  const preroll = sourceOps.slice(0, sourceStart).filter((op) => op.frame === "open");

  return fire({
    ops: [...preroll, ...sourceOps.slice(sourceStart)],
    sourceOps,
    sourceStart,
    prerollCount: preroll.length,
    index,
  });
}

function fire(
  f: Pick<ActiveFire, "ops" | "sourceOps" | "sourceStart" | "prerollCount" | "index"> & Partial<ActiveFire>,
): ActiveFire {
  return {
    id: "pit-crew.x",
    bus: AudioBus.Voice,
    weight: 50,
    cancelled: false,
    pauseTimer: null,
    usedChannels: new Set(),
    event: null,
    sessionGeneration: 0,
    cutTail: [],
    ended: false,
    ...f,
  };
}

// ─── the predicates ──────────────────────────────────────────────────────────

describe("startedSourceOps / wordsHeard / lineFinished", () => {
  it.each<[string, ActiveFireView, number, boolean, boolean]>([
    // A fresh fire: `index` points one past the op in flight.
    ["a fresh fire before its first op", fresh(FRAMED, 0), 0, false, false],
    ["a fresh fire in its open tick", fresh(FRAMED, 1), 1, false, false],
    ["a fresh fire in its open bed", fresh(FRAMED, 2), 2, false, false],
    ["a fresh fire in its first word", fresh(FRAMED, 3), 3, true, false],
    ["a fresh fire in its last word", fresh(FRAMED, 4), 4, true, false],
    ["a fresh fire in its trailing pause", fresh(FRAMED, 5), 5, true, true],
    ["a fresh fire in its close", fresh(FRAMED, 7), 7, true, true],
    // Resumed at the second word (source op 3): the preroll is the tick and the bed.
    ["a resumed fire in its preroll tick", resumed(FRAMED, 3, 1), 4, true, false],
    ["a resumed fire in its preroll bed", resumed(FRAMED, 3, 2), 4, true, false],
    ["a resumed fire in the word it resumed at", resumed(FRAMED, 3, 3), 4, true, false],
    ["a resumed fire in its trailing pause", resumed(FRAMED, 3, 4), 5, true, true],
    ["a resumed fire in its close", resumed(FRAMED, 3, 6), 7, true, true],
    // Resumed inside a two-beep open (source op 1): no words were heard before the cut.
    ["a fire resumed inside its open, in the preroll", resumed(FRAMED, 1, 1), 2, false, false],
    ["a fire resumed inside its open, in the bed it resumed at", resumed(FRAMED, 1, 2), 2, false, false],
    ["a fire resumed inside its open, in its first word", resumed(FRAMED, 1, 3), 3, true, false],
    // Resumed into the close (source op 5): finished even while its preroll plays.
    ["a fire resumed into its close, in the preroll", resumed(FRAMED, 5, 1), 6, true, true],
    // An unframed body (`frame: "none"`): the first clip is words.
    ["an unframed body in its first clip", fresh([play("one.mp3"), play("two.mp3")], 1), 1, true, false],
    ["an unframed body in its last clip", fresh([play("one.mp3"), play("two.mp3")], 2), 2, true, false],
    // A body that opens with a pause counts as heard once the pause is consumed.
    ["a body opening with a pause, in the pause", fresh([pause(100), play("one.mp3")], 1), 1, true, false],
  ])("%s", (_name, f, started, heard, finished) => {
    expect(startedSourceOps(f)).toBe(started);
    expect(wordsHeard(f)).toBe(heard);
    expect(lineFinished(f)).toBe(finished);
  });
});

// ─── LineEnds ────────────────────────────────────────────────────────────────

type Call =
  | ["cancelPending", string]
  | ["dropWaiting", AudioBus, string]
  | ["drain", AudioBus]
  | ["playCutTail", AudioBus]
  | ["cancelActiveFire", AudioBus];

type Harness = {
  lineEnds: LineEnds;
  buses: BusTable;
  calls: Call[];
  contracts: Map<string, CompiledScenario>;
  /** Ids `cancelPending` reports as having had a timer. */
  pending: Set<string>;
  /** `bus:id` pairs `dropWaiting` reports as having waited. */
  waiting: Set<string>;
  subscriptions: Map<SimEventName, Array<() => void>>;
  define(c: Omit<ScenarioContract, "bus" | "channel">): CompiledScenario;
  /** Put a fire on a bus, as playback would. */
  playing(bus: AudioBus, f: ActiveFire): ActiveFire;
  publish(event: SimEventName): void;
};

function harness(): Harness {
  const calls: Call[] = [];
  const contracts = new Map<string, CompiledScenario>();
  const subscriptions = new Map<SimEventName, Array<() => void>>();
  const buses = new BusTable(() => new PendingQueue<WaitingFire>(() => false));
  const bus = {
    subscribe: (event: SimEventName, handler: () => void) => {
      subscriptions.set(event, [...(subscriptions.get(event) ?? []), handler]);

      return () => {
        subscriptions.set(
          event,
          (subscriptions.get(event) ?? []).filter((h) => h !== handler),
        );
      };
    },
  } as unknown as IEventBus;
  const h: Harness = {
    lineEnds: undefined as unknown as LineEnds,
    buses,
    calls,
    contracts,
    pending: new Set(),
    waiting: new Set(),
    subscriptions,
    define(c) {
      const raw: ScenarioContract = { bus: AudioBus.Voice, channel: AudioChannel.Voice, ...c };
      const entry: CompiledScenario = {
        raw,
        resolvedSequence: null,
        frame: raw.frame ?? DEFAULT_FRAME,
        enabled: true,
        unsubscribe: null,
        lastFireAt: 0,
        pendingTriggerTimer: null,
      };
      contracts.set(raw.id, entry);
      h.lineEnds.watch(entry);

      return entry;
    },
    playing(target, f) {
      buses.get(target).transport.active = f;

      return f;
    },
    publish(event) {
      for (const handler of [...(subscriptions.get(event) ?? [])]) handler();
    },
  };
  h.lineEnds = new LineEnds(bus, logger, buses, {
    contracts: { entries: contracts },
    scheduler: {
      dropWaiting: (target, id) => {
        calls.push(["dropWaiting", target, id]);

        return h.waiting.delete(`${target}:${id}`);
      },
      drain: (target) => {
        calls.push(["drain", target]);
      },
    },
    triggers: {
      cancelPending: (entry) => {
        calls.push(["cancelPending", entry.raw.id]);

        return h.pending.delete(entry.raw.id);
      },
    },
    playback: {
      playCutTail: (target) => {
        calls.push(["playCutTail", target]);
        // The tail takes the fire's place, marked ended.
        const state = buses.get(target);
        state.transport.active = fire({ ...state.transport.active!, ended: true });
      },
      cancelActiveFire: (target) => {
        calls.push(["cancelActiveFire", target]);
        buses.get(target).transport.active = null;
      },
    },
  });

  return h;
}

const EXIT: SimEventName = "pitLane.exited";
const ENTER: SimEventName = "pitLane.entered";
const endsOn = (event: SimEventName) => ({ event, description: `when ${event}` });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LineEnds", () => {
  it("subscribes once per distinct `endsOn` event, nothing for a contract without one, and releases all on `dispose`", () => {
    const h = harness();

    h.define({ id: "a", endsOn: endsOn(EXIT) });
    h.define({ id: "b", endsOn: endsOn(EXIT) });
    h.define({ id: "c", endsOn: endsOn(ENTER) });
    h.define({ id: "d" });

    expect(h.subscriptions.get(EXIT)).toHaveLength(1);
    expect(h.subscriptions.get(ENTER)).toHaveLength(1);

    h.lineEnds.dispose();

    expect(h.subscriptions.get(EXIT)).toHaveLength(0);
    expect(h.subscriptions.get(ENTER)).toHaveLength(0);
  });

  it("ends only the contracts naming the event, and says nothing for one with nothing to end", () => {
    const h = harness();
    h.define({ id: "a", endsOn: endsOn(EXIT) });
    h.define({ id: "other", endsOn: endsOn(ENTER) });
    h.pending.add("other");
    h.buses.get(AudioBus.Voice);

    h.publish(EXIT);

    expect(h.calls).toEqual([
      ["cancelPending", "a"],
      ["dropWaiting", AudioBus.Voice, "a"],
    ]);
    expect(vi.mocked(logger.debug).mock.calls).toEqual([]);
  });

  it("runs two passes — every timer and waiting fire first, then the playing fires — contracts outside, buses inside, in table order", () => {
    const h = harness();
    h.define({ id: "a", endsOn: endsOn(EXIT) });
    h.define({ id: "b", endsOn: endsOn(EXIT) });
    // Background was used first: it leads the table's order.
    h.buses.get(AudioBus.Background);
    h.playing(
      AudioBus.Voice,
      fire({ id: "a", ops: FRAMED, sourceOps: FRAMED, sourceStart: 0, prerollCount: 0, index: 3 }),
    );
    h.pending.add("b");
    h.waiting.add(`${AudioBus.Voice}:b`);

    h.publish(EXIT);

    expect(h.calls).toEqual([
      ["cancelPending", "a"],
      ["dropWaiting", AudioBus.Background, "a"],
      ["dropWaiting", AudioBus.Voice, "a"],
      ["cancelPending", "b"],
      ["dropWaiting", AudioBus.Background, "b"],
      ["dropWaiting", AudioBus.Voice, "b"],
      ["cancelActiveFire", AudioBus.Voice],
      ["drain", AudioBus.Voice],
    ]);
    // One line per contract, in the order each first had something to end: `b` in the first pass, `a` in the second.
    expect(vi.mocked(logger.debug).mock.calls.map(([l]) => String(l))).toEqual([
      'Scenario "b" ended by pitLane.exited (pending, waiting)',
      'Scenario "a" ended by pitLane.exited (playing → silent)',
    ]);
  });

  it("plays the cut tail once words have been heard and the tail is not empty, stops silently otherwise", () => {
    const h = harness();
    h.define({ id: "tail", endsOn: endsOn(EXIT) });
    h.define({ id: "no-tail", endsOn: endsOn(EXIT) });
    h.define({ id: "no-words", endsOn: endsOn(EXIT) });
    const cutTail = [play("never-mind.mp3", "cut")];
    h.playing(
      AudioBus.Voice,
      fire({ id: "tail", ops: FRAMED, sourceOps: FRAMED, sourceStart: 0, prerollCount: 0, index: 3, cutTail }),
    );
    h.playing(
      AudioBus.Background,
      fire({ id: "no-tail", ops: FRAMED, sourceOps: FRAMED, sourceStart: 0, prerollCount: 0, index: 3 }),
    );
    h.playing(
      AudioBus.Alerts,
      fire({ id: "no-words", ops: FRAMED, sourceOps: FRAMED, sourceStart: 0, prerollCount: 0, index: 1, cutTail }),
    );

    h.publish(EXIT);

    expect(h.calls.filter(([kind]) => kind !== "cancelPending" && kind !== "dropWaiting")).toEqual([
      ["playCutTail", AudioBus.Voice],
      ["cancelActiveFire", AudioBus.Background],
      ["drain", AudioBus.Background],
      ["cancelActiveFire", AudioBus.Alerts],
      ["drain", AudioBus.Alerts],
    ]);
    expect(vi.mocked(logger.debug).mock.calls.map(([l]) => String(l))).toEqual([
      'Scenario "tail" ended by pitLane.exited (playing → tail)',
      'Scenario "no-tail" ended by pitLane.exited (playing → silent)',
      'Scenario "no-words" ended by pitLane.exited (playing → silent)',
    ]);
  });

  it("leaves a finished line to close, and a cut tail already playing alone — a second end is a no-op", () => {
    const h = harness();
    h.define({ id: "closing", endsOn: endsOn(EXIT) });
    h.define({ id: "tail", endsOn: endsOn(EXIT) });
    h.playing(
      AudioBus.Voice,
      fire({ id: "closing", ops: FRAMED, sourceOps: FRAMED, sourceStart: 0, prerollCount: 0, index: 6 }),
    );
    const cut = [play("never-mind.mp3", "cut")];
    h.playing(
      AudioBus.Background,
      fire({ id: "tail", ops: cut, sourceOps: cut, sourceStart: 0, prerollCount: 0, index: 1, ended: true }),
    );

    h.publish(EXIT);
    h.publish(EXIT);

    expect(h.calls.filter(([kind]) => kind !== "cancelPending" && kind !== "dropWaiting")).toEqual([]);
    expect(vi.mocked(logger.debug).mock.calls.map(([l]) => String(l))).toEqual([
      'Scenario "closing" ended by pitLane.exited (playing → closing)',
      'Scenario "closing" ended by pitLane.exited (playing → closing)',
    ]);
  });
});
