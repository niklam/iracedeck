/**
 * The scheduler on its own (issue #1514): arbitration over a real `BusTable`
 * and real `PendingQueue`s, with a fake expansion that hands back whatever
 * ops a test names (or `null`) and a fake playback that only records the
 * bus take, the step and the cut — "arbitration without expanding frames or
 * playing clips". The order of what the scheduler asks of the two fakes is
 * what most cases pin: expand, gate, commit, cut, take.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "./dsl.js";
import { DEFAULT_FRAME } from "./dsl.js";
import {
  type ActiveFire,
  BusTable,
  type CompiledScenario,
  type ExecOp,
  fireContext,
  FRAME_PREVIEW_ID,
  type WaitingFire,
} from "./engine-types.js";
import type { PreparedCallout, PreparedFramePreview } from "./expansion.js";
import { PendingQueue } from "./pending-queue.js";
import type { FireStart } from "./playback.js";
import { Scheduler, type SchedulerDeps } from "./scheduler.js";
import type { CompiledVoiceScript } from "./script-compiler.js";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const logged = (level: "debug" | "info" | "warn" | "error"): string[] =>
  vi.mocked(logger[level]).mock.calls.map(([line]) => String(line));

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
const pause = (ms: number): ExecOp => ({ kind: "pause", ms });

/** What the scheduler asked of the fakes, in order. */
type Call =
  | ["prepare", string]
  | ["gate", string]
  | ["commit", string]
  | ["restoreHead", number]
  | ["prepareFrame", string]
  | ["ensureCompiled"]
  | ["takeBus", string]
  | ["stepNext", AudioBus]
  | ["cancel", string];

type Harness = {
  scheduler: Scheduler;
  buses: BusTable;
  calls: Call[];
  /** The last `takeBus` argument, for the fields the fire was started with. */
  starts: FireStart[];
  contracts: Map<string, CompiledScenario>;
  /** Ids whose `prepare` returns `null`, as an abort or a missing script would. */
  silent: Set<string>;
  /** What `prepare` expands an id to; one body clip named after the id by default. */
  opsFor: Map<string, ExecOp[]>;
  /** What `prepareFrame` returns, or `null` for a frame that aborted. */
  previewFrame: { open: ExecOp[]; close: ExecOp[] } | null;
  voice: string | null;
  generation: number;
  /** The frames the active voice's compiled script defines, for the preview. */
  frames: Set<string>;
  /** Register a contract on the Voice bus; the entry is what the scheduler is handed. */
  define(c: Omit<ScenarioContract, "bus" | "channel"> & Partial<Pick<ScenarioContract, "bus">>): CompiledScenario;
  /** Fire a contract by id, as the facade's `fire` and the triggers do. */
  fire(id: string, event?: SimEventOf<SimEventName> | null): void;
  active(bus?: AudioBus): ActiveFire | null;
  waiting(bus?: AudioBus): string[];
  /** End the playing fire as playback would: idle the bus, then `fireFinished`. */
  finish(bus?: AudioBus): void;
  /** Only the kinds named, in order — the order assertions read better without the rest. */
  only(...kinds: Call[0][]): Call[];
};

function harness(): Harness {
  const calls: Call[] = [];
  const starts: FireStart[] = [];
  const contracts = new Map<string, CompiledScenario>();
  const buses = new BusTable(
    () =>
      new PendingQueue<WaitingFire>((follower, leader) =>
        (contracts.get(follower)?.raw.queueBehind ?? []).includes(leader),
      ),
  );
  const h: Harness = {
    scheduler: undefined as unknown as Scheduler,
    buses,
    calls,
    starts,
    contracts,
    silent: new Set(),
    opsFor: new Map(),
    previewFrame: { open: [sfx("tick-open.mp3", "open")], close: [sfx("tick-close.mp3", "close")] },
    voice: "v1",
    generation: 0,
    frames: new Set(["radio"]),
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

      return entry;
    },
    fire(id, event = null) {
      const entry = contracts.get(id);

      if (!entry) throw new Error(`no contract ${id}`);

      h.scheduler.attemptFire(entry, event);
    },
    active: (bus = AudioBus.Voice) => buses.peek(bus)?.transport.active ?? null,
    waiting: (bus = AudioBus.Voice) => (buses.peek(bus)?.schedule.queue.ordered() ?? []).map((e) => e.id),
    finish(bus = AudioBus.Voice) {
      const state = buses.get(bus);
      const fire = state.transport.active;

      if (!fire) throw new Error("nothing playing");

      state.transport.active = null;
      h.scheduler.fireFinished(bus, fire.id);
    },
    only: (...kinds) => calls.filter((c) => kinds.includes(c[0])),
  };
  const deps: SchedulerDeps = {
    contracts: { get: (id) => contracts.get(id) },
    scripts: {
      get generation() {
        return h.generation;
      },
      ensureCompiled: () => {
        calls.push(["ensureCompiled"]);
      },
      compiled: (voice) =>
        voice === h.voice && h.frames.size > 0
          ? ({ frames: new Map([...h.frames].map((f) => [f, {}])) } as unknown as CompiledVoiceScript)
          : undefined,
    },
    pools: {
      currentManifest: () => ({
        clips: [],
        ambientLoop: "loop.mp3",
        ticks: { open: "tick-open.mp3", close: "tick-close.mp3" },
      }),
      restoreHeadPoolIndices: (head) => {
        calls.push(["restoreHead", head.length]);
      },
    },
    expansion: {
      prepare: (entry, event): PreparedCallout | null => {
        const id = entry.raw.id;
        calls.push(["prepare", id]);

        if (h.silent.has(id)) return null;

        const ops = h.opsFor.get(id) ?? [play(`${id}.mp3`)];

        return {
          fire: { ops, cutTail: [] },
          ctx: fireContext(event),
          commit: () => {
            calls.push(["commit", id]);
          },
        };
      },
      prepareFrame: (frameName): PreparedFramePreview | null => {
        calls.push(["prepareFrame", frameName]);

        if (h.previewFrame === null) return null;

        return {
          frame: { ...h.previewFrame, cut: [] },
          commit: () => {
            calls.push(["commit", FRAME_PREVIEW_ID]);
          },
        };
      },
    },
    playback: {
      takeBus: (start) => {
        // As `Playback.takeBus` does: the listener first, then the fire.
        h.scheduler.busTaken(start.bus);
        buses.get(start.bus).transport.active = {
          ...start,
          index: 0,
          cancelled: false,
          pauseTimer: null,
          usedChannels: new Set(),
        };
        calls.push(["takeBus", start.id]);
        starts.push(start);
      },
      stepNext: (bus) => {
        calls.push(["stepNext", bus]);
      },
      cancelActiveFire: (bus) => {
        const state = buses.peek(bus);
        const fire = state?.transport.active;

        if (!state || !fire) return;

        fire.cancelled = true;
        state.transport.active = null;
        calls.push(["cancel", fire.id]);
      },
    },
  };
  h.scheduler = new Scheduler(logger, () => h.voice, buses, deps);

  return h;
}

/** A gate that answers `answer` and records being asked. */
function gate(h: Harness, id: string, answer: boolean | Error): ScenarioContract["speakGate"] {
  return {
    description: `gate of ${id}`,
    admit: () => {
      h.calls.push(["gate", id]);

      if (answer instanceof Error) throw answer;

      return answer;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── weight and interrupt ────────────────────────────────────────────────────

describe("weight and interrupt", () => {
  it("takes an idle bus: expand, commit, take, log, step — and stamps the cooldown", () => {
    const h = harness();
    const a = h.define({ id: "a", cooldown: 1000 });
    vi.setSystemTime(5000);

    h.fire("a");

    expect(h.calls).toEqual([
      ["prepare", "a"],
      ["commit", "a"],
      ["takeBus", "a"],
      ["stepNext", AudioBus.Voice],
    ]);
    expect(h.active()?.id).toBe("a");
    expect(a.lastFireAt).toBe(5000);
    expect(logged("info")).toEqual(['Playing scenario "a"']);
    expect(logged("debug")).toEqual([`Ops (1): play[${AudioChannel.Voice}] a.mp3`]);
  });

  it("drops a fire inside its cooldown before it expands", () => {
    const h = harness();
    h.define({ id: "a", cooldown: 1000 });
    vi.setSystemTime(5000);
    h.fire("a");
    h.finish();
    h.calls.length = 0;

    vi.setSystemTime(5500);
    h.fire("a");
    expect(h.calls).toEqual([]);

    vi.setSystemTime(6000);
    h.fire("a");
    expect(h.only("takeBus")).toEqual([["takeBus", "a"]]);
  });

  it("a heavier `interrupt` arrival expands BEFORE it cuts the line, stashes a queueable line, and takes the bus", () => {
    const h = harness();
    h.define({ id: "a", weight: 10, queueable: true });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.fire("a");
    h.calls.length = 0;

    h.fire("b");

    expect(h.calls).toEqual([
      ["prepare", "b"],
      ["commit", "b"],
      ["cancel", "a"],
      ["takeBus", "b"],
      ["stepNext", AudioBus.Voice],
    ]);
    expect(h.active()?.id).toBe("b");
    expect(h.waiting()).toEqual(["a"]);
    // The stash already passed its gate.
    expect(h.buses.get(AudioBus.Voice).schedule.queue.ordered()[0]?.fire.admitted).toBe(true);
    expect(logged("debug")).toContain('Scenario "a" pending (1 of 1) — stashed (preempted)');
  });

  it("a heavier `interrupt` arrival that expands to nothing leaves the line playing", () => {
    const h = harness();
    h.define({ id: "a", weight: 10, queueable: true });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.fire("a");
    h.calls.length = 0;
    h.silent.add("b");

    h.fire("b");

    expect(h.calls).toEqual([["prepare", "b"]]);
    expect(h.active()?.id).toBe("a");
    expect(h.waiting()).toEqual([]);
  });

  it("a heavier arrival without `interrupt` waits for the line to finish, queueable or not", () => {
    const h = harness();
    h.define({ id: "a", weight: 10 });
    h.define({ id: "b", weight: 20 });
    h.fire("a");
    h.calls.length = 0;

    h.fire("b");

    expect(h.calls).toEqual([]);
    expect(h.active()?.id).toBe("a");
    expect(h.waiting()).toEqual(["b"]);
    expect(logged("debug")).toContain('Scenario "b" pending (1 of 1) — waiting for bus (higher weight, no interrupt)');

    h.finish();
    expect(h.only("takeBus")).toEqual([["takeBus", "b"]]);
  });

  it("a same-family arrival replaces the line whatever the weights, and never stashes it", () => {
    const h = harness();
    h.define({ id: "a", weight: 50, family: "tires", queueable: true });
    h.define({ id: "b", weight: 10, family: "tires" });
    h.fire("a");
    h.calls.length = 0;

    h.fire("b");

    expect(h.calls).toEqual([
      ["prepare", "b"],
      ["commit", "b"],
      ["cancel", "a"],
      ["takeBus", "b"],
      ["stepNext", AudioBus.Voice],
    ]);
    expect(h.waiting()).toEqual([]);
  });

  it("a fire that is not stashed as a resume replays whole, and a resumable one continues from the cut with its head's takes put back", () => {
    const h = harness();
    const ops = [sfx("tick-open.mp3", "open"), play("one.mp3"), play("two.mp3"), play("three.mp3")];
    h.define({ id: "a", weight: 10, queueable: true, resumable: true });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.opsFor.set("a", ops);
    h.fire("a");
    // The third op is in flight: `index` points one past it.
    h.active()!.index = 3;
    h.fire("b");
    h.calls.length = 0;

    h.finish();

    // Commit comes before the put-back of the head's takes (item 13).
    expect(h.only("prepare", "commit", "restoreHead", "takeBus")).toEqual([
      ["prepare", "a"],
      ["commit", "a"],
      ["restoreHead", 2],
      ["takeBus", "a"],
    ]);
    const start = h.starts.at(-1)!;
    expect(start.sourceStart).toBe(2);
    expect(start.prerollCount).toBe(1);
    expect(start.ops).toEqual([ops[0], ops[2], ops[3]]);
    expect(logged("info")).toContain('Resuming scenario "a"');
    expect(logged("debug")).toContain("Resumed at op 2/4");
  });

  it("replays whole, saying why, when the expansion changed while stashed", () => {
    const h = harness();
    h.define({ id: "a", weight: 10, queueable: true, resumable: true });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.opsFor.set("a", [play("one.mp3"), play("two.mp3"), play("three.mp3")]);
    h.fire("a");
    h.active()!.index = 2;
    h.fire("b");
    h.opsFor.set("a", [play("one.mp3"), play("other.mp3"), play("three.mp3")]);
    h.calls.length = 0;

    h.finish();

    expect(h.only("restoreHead")).toEqual([]);
    expect(h.starts.at(-1)?.sourceStart).toBe(0);
    expect(logged("debug")).toContain('Scenario "a" replays whole — the expansion changed while stashed');
  });
});

// ─── queue or drop ───────────────────────────────────────────────────────────

describe("queue or drop", () => {
  it("defers a queueable fire of equal weight behind the line, and drops one that is not", () => {
    const h = harness();
    h.define({ id: "a" });
    h.define({ id: "queued", queueable: true });
    h.define({ id: "dropped" });
    h.fire("a");
    h.calls.length = 0;
    vi.mocked(logger.debug).mockClear();

    h.fire("queued");
    h.fire("dropped");

    // Neither reached the expansion.
    expect(h.calls).toEqual([]);
    expect(h.waiting()).toEqual(["queued"]);
    expect(logged("debug")).toEqual([
      'Scenario "queued" pending (1 of 1) — deferred (bus busy)',
      'Scenario "dropped" dropped (bus busy)',
    ]);
  });

  it("drains the queue as the bus idles, and a replay that takes nothing hands the bus to the next at once", () => {
    const h = harness();
    h.define({ id: "a" });
    h.define({ id: "b", queueable: true, weight: 60 });
    h.define({ id: "c", queueable: true, weight: 40 });
    h.fire("a");
    h.fire("c");
    h.fire("b");
    h.silent.add("b");
    h.calls.length = 0;

    h.finish();

    expect(h.only("prepare", "takeBus")).toEqual([
      ["prepare", "b"],
      ["prepare", "c"],
      ["takeBus", "c"],
    ]);
    expect(h.waiting()).toEqual([]);
    expect(logged("debug")).toEqual(
      expect.arrayContaining(['Replaying pending scenario "b"', 'Replaying pending scenario "c"']),
    );
  });

  it("drops a waiting fire whose contract was disabled meanwhile", () => {
    const h = harness();
    h.define({ id: "a" });
    const b = h.define({ id: "b", queueable: true });
    h.fire("a");
    h.fire("b");
    b.enabled = false;
    h.calls.length = 0;

    h.finish();

    expect(h.only("prepare")).toEqual([]);
    expect(logged("debug")).toContain('Scenario "b" dropped — disabled');
  });

  it("a newer fire of a group supersedes the older one still waiting", () => {
    const h = harness();
    h.define({ id: "a", pendingHoldMs: 300 });
    h.define({ id: "old", queueable: true, supersedeGroup: "fuel" });
    h.define({ id: "new", queueable: true, supersedeGroup: "fuel" });
    h.fire("a");
    h.fire("old");
    // The hold keeps `old` waiting on an idle bus.
    h.finish();
    h.calls.length = 0;

    h.fire("new");

    expect(h.waiting()).toEqual([]);
    expect(h.active()?.id).toBe("new");
    expect(logged("debug")).toContain('Scenario "old" dropped — superseded by "new"');
  });

  it("a follower waits behind its pending leader even on an idle bus", () => {
    const h = harness();
    h.define({ id: "a", pendingHoldMs: 300 });
    h.define({ id: "leader", queueable: true });
    h.define({ id: "follower", queueBehind: ["leader"] });
    h.fire("a");
    h.fire("leader");
    h.finish();
    h.calls.length = 0;

    h.fire("follower");

    expect(h.calls).toEqual([]);
    expect(h.waiting()).toEqual(["leader", "follower"]);
    expect(logged("debug")).toContain(
      'Scenario "follower" pending (2 of 2) behind "leader" — the fire it waits behind is pending',
    );

    vi.advanceTimersByTime(300);
    expect(h.only("takeBus")).toEqual([["takeBus", "leader"]]);
    h.finish();
    expect(h.only("takeBus")).toEqual([
      ["takeBus", "leader"],
      ["takeBus", "follower"],
    ]);
  });

  it("`dropWaiting` removes and logs a waiting fire and says whether there was one; `drain` replays what waits", () => {
    const h = harness();
    h.define({ id: "a" });
    h.define({ id: "b", queueable: true });
    h.define({ id: "c", queueable: true });
    h.fire("a");
    h.fire("b");
    h.fire("c");

    expect(h.scheduler.dropWaiting(AudioBus.Voice, "b", { kind: "ended" })).toBe(true);
    expect(h.scheduler.dropWaiting(AudioBus.Voice, "b", { kind: "ended" })).toBe(false);
    expect(h.scheduler.dropWaiting(AudioBus.Background, "b", { kind: "ended" })).toBe(false);
    expect(h.waiting()).toEqual(["c"]);
    expect(logged("debug")).toContain('Scenario "b" dropped — ended');

    // A silent stop: the caller cuts through playback, then drains.
    h.buses.get(AudioBus.Voice).transport.active = null;
    h.calls.length = 0;
    h.scheduler.drain(AudioBus.Voice);

    expect(h.only("takeBus")).toEqual([["takeBus", "c"]]);
  });

  it("`cancelDisabled` cuts the line, drops the waiting entry and drains the bus", () => {
    const h = harness();
    h.define({ id: "a" });
    h.define({ id: "b", queueable: true });
    h.define({ id: "c", queueable: true });
    h.fire("a");
    h.fire("b");
    h.fire("c");
    h.calls.length = 0;

    h.scheduler.cancelDisabled("a");

    expect(h.only("cancel", "takeBus")).toEqual([
      ["cancel", "a"],
      ["takeBus", "b"],
    ]);
    h.calls.length = 0;
    vi.mocked(logger.debug).mockClear();

    h.scheduler.cancelDisabled("c");

    expect(h.calls).toEqual([]);
    expect(h.waiting()).toEqual([]);
    expect(logged("debug")).toEqual(['Scenario "c" dropped — disabled']);
  });
});

// ─── the focus floor ─────────────────────────────────────────────────────────

describe("the focus floor", () => {
  it("holds back a non-owner below the floor, lets the owner's own and anything at or above it through", () => {
    const h = harness();
    h.define({ id: "chatter", weight: 20, queueable: true });
    h.define({ id: "dropped", weight: 20 });
    h.define({ id: "own", weight: 10, focusOwner: "spotter" });
    h.define({ id: "safety", weight: 50 });
    h.scheduler.acquireFocus(AudioBus.Voice, "spotter", 50);

    h.fire("chatter");
    h.fire("dropped");
    expect(h.calls).toEqual([]);
    expect(h.waiting()).toEqual(["chatter"]);
    expect(logged("debug")).toEqual([
      'Focus acquired on bus 0 by "spotter" (floor 50)',
      'Scenario "chatter" pending (1 of 1) — deferred (below focus floor (spotter))',
      'Scenario "dropped" dropped (below focus floor (spotter))',
    ]);

    h.fire("own");
    expect(h.active()?.id).toBe("own");
    h.finish();
    // The drain leaves `chatter` parked below the floor.
    expect(h.waiting()).toEqual(["chatter"]);

    h.fire("safety");
    expect(h.active()?.id).toBe("safety");
  });

  it("releasing the floor drains what it parked; another owner's release is a no-op", () => {
    const h = harness();
    h.define({ id: "chatter", weight: 20, queueable: true });
    h.scheduler.acquireFocus(AudioBus.Voice, "spotter", 50);
    h.fire("chatter");

    h.scheduler.releaseFocus(AudioBus.Voice, "someone-else");
    expect(h.waiting()).toEqual(["chatter"]);
    expect(h.buses.get(AudioBus.Voice).schedule.focus).toEqual({ ownerId: "spotter", floor: 50 });

    h.scheduler.releaseFocus(AudioBus.Voice, "spotter");
    expect(h.buses.get(AudioBus.Voice).schedule.focus).toBeNull();
    expect(h.only("takeBus")).toEqual([["takeBus", "chatter"]]);
    expect(logged("debug")).toContain('Focus released on bus 0 by "spotter"');
  });

  it("the drain skips, in place, what is still below a held floor", () => {
    const h = harness();
    h.define({ id: "a", weight: 50 });
    h.define({ id: "low", weight: 20, queueable: true });
    h.define({ id: "high", weight: 60, queueable: true });
    h.scheduler.acquireFocus(AudioBus.Voice, "spotter", 50);
    h.fire("a");
    h.fire("low");
    h.fire("high");
    h.calls.length = 0;

    h.finish();

    expect(h.only("takeBus")).toEqual([["takeBus", "high"]]);
    expect(h.waiting()).toEqual(["low"]);
  });
});

// ─── the hold ────────────────────────────────────────────────────────────────

describe("the hold", () => {
  it("a finishing fire with `pendingHoldMs` and something waiting holds the drain for its window", () => {
    const h = harness();
    h.define({ id: "mark", pendingHoldMs: 300 });
    h.define({ id: "line", queueable: true });
    h.fire("mark");
    h.fire("line");
    h.calls.length = 0;

    h.finish();

    expect(h.calls).toEqual([]);
    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).not.toBeNull();
    expect(logged("debug")).toContain('Pending drain held for 300 ms after "mark"');

    vi.advanceTimersByTime(299);
    expect(h.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.only("takeBus")).toEqual([["takeBus", "line"]]);
    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).toBeNull();
  });

  it("arms no hold when nothing waits", () => {
    const h = harness();
    h.define({ id: "mark", pendingHoldMs: 300 });
    h.fire("mark");

    h.finish();

    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).toBeNull();
    expect(logged("debug")).not.toContain('Pending drain held for 300 ms after "mark"');
  });

  it("a bus take during the hold clears it (`busTaken`), and it re-arms at that fire's finish", () => {
    const h = harness();
    h.define({ id: "mark", pendingHoldMs: 300 });
    h.define({ id: "line", queueable: true, weight: 10 });
    h.define({ id: "next-mark", pendingHoldMs: 300, weight: 60 });
    h.fire("mark");
    h.fire("line");
    h.finish();
    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).not.toBeNull();

    h.fire("next-mark");
    expect(h.active()?.id).toBe("next-mark");
    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).toBeNull();

    vi.advanceTimersByTime(300);
    // The first hold's timer was cancelled: `line` is still waiting.
    expect(h.waiting()).toEqual(["line"]);

    h.finish();
    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).not.toBeNull();
  });

  it("`clearHolds` cancels every armed hold without draining", () => {
    const h = harness();
    h.define({ id: "mark", pendingHoldMs: 300 });
    h.define({ id: "line", queueable: true });
    h.fire("mark");
    h.fire("line");
    h.finish();

    h.scheduler.clearHolds();
    vi.advanceTimersByTime(300);

    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).toBeNull();
    expect(h.waiting()).toEqual(["line"]);
    expect(h.only("takeBus")).toEqual([["takeBus", "mark"]]);
  });

  it("`stopAll` cuts the line, clears the queue, the hold and the floor on every bus, unlogged", () => {
    const h = harness();
    h.define({ id: "a" });
    h.define({ id: "b", queueable: true });
    h.define({ id: "bg", bus: AudioBus.Background });
    h.define({ id: "mark", pendingHoldMs: 300, bus: AudioBus.Background });
    h.define({ id: "line", queueable: true, bus: AudioBus.Background });
    h.scheduler.acquireFocus(AudioBus.Voice, "spotter", 50);
    h.fire("a");
    h.fire("b");
    h.fire("mark");
    h.fire("line");
    h.finish(AudioBus.Background);
    h.calls.length = 0;
    vi.mocked(logger.debug).mockClear();

    h.scheduler.stopAll();

    expect(h.calls).toEqual([["cancel", "a"]]);
    expect(h.waiting()).toEqual([]);
    expect(h.waiting(AudioBus.Background)).toEqual([]);
    expect(h.buses.get(AudioBus.Voice).schedule.focus).toBeNull();
    expect(h.buses.get(AudioBus.Background).schedule.holdTimer).toBeNull();
    expect(logged("debug")).toEqual([]);
  });
});

// ─── a session change and the stash ──────────────────────────────────────────

describe("a session change", () => {
  it("clears every bus's queue, logging each fire, and cancels an armed hold", () => {
    const h = harness();
    h.define({ id: "mark", pendingHoldMs: 300 });
    h.define({ id: "line", queueable: true });
    h.define({ id: "bg", bus: AudioBus.Background });
    h.define({ id: "bg-line", queueable: true, bus: AudioBus.Background });
    h.fire("mark");
    h.fire("line");
    h.fire("bg");
    h.fire("bg-line");
    h.finish();
    vi.mocked(logger.debug).mockClear();

    h.scheduler.clearQueuesForSessionChange();

    expect(h.waiting()).toEqual([]);
    expect(h.waiting(AudioBus.Background)).toEqual([]);
    expect(h.buses.get(AudioBus.Voice).schedule.holdTimer).toBeNull();
    expect(logged("debug")).toEqual([
      'Scenario "line" dropped — session changed',
      'Scenario "bg-line" dropped — session changed',
    ]);
    // The line still playing on the Background bus is untouched.
    expect(h.active(AudioBus.Background)?.id).toBe("bg");
  });

  it("a line still playing from the old session is dropped, not stashed, when an interrupt cuts it", () => {
    const h = harness();
    h.define({ id: "a", weight: 10, queueable: true, resumable: true });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.fire("a");
    expect(h.starts.at(-1)?.sessionGeneration).toBe(0);
    h.scheduler.clearQueuesForSessionChange();
    h.calls.length = 0;

    h.fire("b");

    expect(h.only("cancel", "takeBus")).toEqual([
      ["cancel", "a"],
      ["takeBus", "b"],
    ]);
    expect(h.waiting()).toEqual([]);
    expect(h.starts.at(-1)?.sessionGeneration).toBe(1);
    expect(logged("debug")).toContain('Scenario "a" dropped — session changed');
  });

  it("an ended fire's cut tail is never stashed", () => {
    const h = harness();
    h.define({ id: "a", weight: 10, queueable: true });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.fire("a");
    h.active()!.ended = true;

    h.fire("b");

    expect(h.waiting()).toEqual([]);
    expect(h.active()?.id).toBe("b");
  });
});

// ─── gate then commit ────────────────────────────────────────────────────────

describe("the speak-time gate", () => {
  it("is asked after the expansion and before the commit; an admitted fire commits and plays", () => {
    const h = harness();
    h.define({ id: "a", speakGate: gate(h, "a", true) });

    h.fire("a");

    expect(h.only("prepare", "gate", "commit", "takeBus")).toEqual([
      ["prepare", "a"],
      ["gate", "a"],
      ["commit", "a"],
      ["takeBus", "a"],
    ]);
  });

  it("a refusal commits nothing, takes no bus, stamps no cooldown and cuts nothing in flight", () => {
    const h = harness();
    h.define({ id: "line", weight: 10 });
    const a = h.define({ id: "a", weight: 20, interrupt: true, cooldown: 1000, speakGate: gate(h, "a", false) });
    h.fire("line");
    h.calls.length = 0;

    h.fire("a");

    expect(h.calls).toEqual([
      ["prepare", "a"],
      ["gate", "a"],
    ]);
    expect(h.active()?.id).toBe("line");
    expect(a.lastFireAt).toBe(0);
    expect(logged("debug")).toContain('Scenario "a" skipped — speak-time gate: gate of a');
  });

  it("a gate that throws is logged at error and read as a refusal", () => {
    const h = harness();
    h.define({ id: "a", speakGate: gate(h, "a", new Error("boom")) });

    h.fire("a");

    expect(h.only("commit", "takeBus")).toEqual([]);
    expect(logged("error")).toEqual(['Scenario "a" speak-time gate failed: boom']);
    expect(logged("debug")).toContain('Scenario "a" skipped — speak-time gate: gate of a');
  });

  it("is not asked again of a fire an interrupt cut: the stash replays admitted", () => {
    const h = harness();
    h.define({ id: "a", weight: 10, queueable: true, speakGate: gate(h, "a", true) });
    h.define({ id: "b", weight: 20, interrupt: true });
    h.fire("a");
    h.fire("b");
    h.finish();

    expect(h.only("gate")).toEqual([["gate", "a"]]);
    expect(h.only("takeBus")).toEqual([
      ["takeBus", "a"],
      ["takeBus", "b"],
      ["takeBus", "a"],
    ]);
  });

  it("is asked, for the first time, of a fire deferred before it expanded", () => {
    const h = harness();
    h.define({ id: "line" });
    h.define({ id: "a", queueable: true, speakGate: gate(h, "a", true) });
    h.fire("line");
    h.fire("a");
    expect(h.only("gate")).toEqual([]);

    h.finish();

    expect(h.only("prepare", "gate", "commit", "takeBus").slice(-4)).toEqual([
      ["prepare", "a"],
      ["gate", "a"],
      ["commit", "a"],
      ["takeBus", "a"],
    ]);
  });
});

// ─── the frame preview ───────────────────────────────────────────────────────

describe("the frame preview", () => {
  it("compiles first, then answers `no-frame` for no voice or a frame the voice does not define", () => {
    const h = harness();
    const onComplete = vi.fn();

    h.voice = null;
    expect(h.scheduler.playFramePreview("radio", 500, onComplete)).toBe("no-frame");
    h.voice = "v1";
    expect(h.scheduler.playFramePreview("other", 500, onComplete)).toBe("no-frame");

    expect(h.calls).toEqual([["ensureCompiled"], ["ensureCompiled"]]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(logged("debug")).toEqual([
      'Frame preview "radio" unavailable for voice "(none)"',
      'Frame preview "other" unavailable for voice "v1"',
    ]);
  });

  it("answers `bus-busy` when the Voice bus plays, holds a waiting fire or a focus floor, before anything expands", () => {
    const h = harness();
    h.define({ id: "a" });
    h.define({ id: "b", queueable: true });

    h.fire("a");
    expect(h.scheduler.playFramePreview("radio", 500)).toBe("bus-busy");
    h.fire("b");
    h.scheduler.clearQueuesForSessionChange();
    h.finish();
    expect(h.active()).toBeNull();
    h.scheduler.acquireFocus(AudioBus.Voice, "spotter", 50);
    expect(h.scheduler.playFramePreview("radio", 500)).toBe("bus-busy");
    h.scheduler.releaseFocus(AudioBus.Voice, "spotter");
    h.define({ id: "mark", pendingHoldMs: 300 });
    h.define({ id: "line", queueable: true });
    h.fire("mark");
    h.fire("line");
    h.finish();
    expect(h.scheduler.playFramePreview("radio", 500)).toBe("bus-busy");

    expect(h.only("prepareFrame")).toEqual([]);
    expect(logged("debug").filter((l) => l.startsWith("Frame preview"))).toEqual([
      'Frame preview "radio" skipped — the Voice bus is in use',
      'Frame preview "radio" skipped — the Voice bus is in use',
      'Frame preview "radio" skipped — the Voice bus is in use',
    ]);
  });

  it("answers `no-frame` when the frame aborts", () => {
    const h = harness();
    h.previewFrame = null;

    expect(h.scheduler.playFramePreview("radio", 500)).toBe("no-frame");
    expect(h.calls).toEqual([["ensureCompiled"], ["prepareFrame", "radio"]]);
  });

  it("commits at once, then completes on the spot when both halves are empty", () => {
    const h = harness();
    const onComplete = vi.fn();
    h.previewFrame = { open: [], close: [] };

    expect(h.scheduler.playFramePreview("radio", 500, onComplete)).toBe("playing");

    expect(h.calls).toEqual([["ensureCompiled"], ["prepareFrame", "radio"], ["commit", FRAME_PREVIEW_ID]]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(h.active()).toBeNull();
  });

  it("plays the open, the hold and the close under the preview id, with `onComplete` as the fire's `onSettled`", () => {
    const h = harness();
    const onComplete = vi.fn();

    expect(h.scheduler.playFramePreview("radio", 500, onComplete)).toBe("playing");

    expect(h.only("commit", "takeBus", "stepNext")).toEqual([
      ["commit", FRAME_PREVIEW_ID],
      ["takeBus", FRAME_PREVIEW_ID],
      ["stepNext", AudioBus.Voice],
    ]);
    const start = h.starts.at(-1)!;
    expect(start.ops).toEqual([sfx("tick-open.mp3", "open"), pause(500), sfx("tick-close.mp3", "close")]);
    expect(start.weight).toBe(0);
    expect(start.onSettled).toBe(onComplete);
    expect(onComplete).not.toHaveBeenCalled();
    expect(logged("info")).toEqual(['Playing frame preview "radio" for voice "v1"']);
    expect(logged("debug")).toEqual([
      `Ops (3): open:play[${AudioChannel.SFX}] tick-open.mp3 | pause:500 | close:play[${AudioChannel.SFX}] tick-close.mp3`,
    ]);
  });

  it("yields to a callout: the arriving fire treats the bus as idle and cuts the preview only once it has expanded", () => {
    const h = harness();
    h.define({ id: "a", queueable: true });
    h.define({ id: "aborts", queueable: true });
    h.silent.add("aborts");
    h.scheduler.playFramePreview("radio", 500);
    h.calls.length = 0;

    h.fire("aborts");
    expect(h.calls).toEqual([["prepare", "aborts"]]);
    expect(h.active()?.id).toBe(FRAME_PREVIEW_ID);

    h.fire("a");
    expect(h.calls.slice(1)).toEqual([
      ["prepare", "a"],
      ["commit", "a"],
      ["cancel", FRAME_PREVIEW_ID],
      ["takeBus", "a"],
      ["stepNext", AudioBus.Voice],
    ]);
    // Nothing of the preview was stashed.
    expect(h.waiting()).toEqual([]);
  });
});
