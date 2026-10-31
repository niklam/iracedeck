/**
 * Playback without the gates (issue #1514): `Playback` over a fake
 * `IAudioService`, a real `BusTable` and a listener that records what it
 * hears — no scheduler, no expansion, no pool store beyond the manifest
 * accessor the ambient loop reads.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusTable, type ExecOp, type WaitingFire } from "./engine-types.js";
import type { AudioAssetsManifest } from "./manifest.js";
import { PendingQueue } from "./pending-queue.js";
import { type FireStart, opLabel, Playback, type PlaybackListener } from "./playback.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const logger: ILogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
} as unknown as ILogger;

const TICK_OPEN = "sfx/tick-open.mp3";
const TICK_CLOSE = "sfx/tick-close.mp3";
const LOOP_A = "sfx/ambient-a.mp3";
const LOOP_B = "sfx/ambient-b.mp3";

const play = (path: string, extra: Partial<Extract<ExecOp, { kind: "play" }>> = {}): ExecOp => ({
  kind: "play",
  channel: AudioChannel.Voice,
  path,
  ...extra,
});
const sfx = (path: string, frame?: ExecOp["frame"]): ExecOp => play(path, { channel: AudioChannel.SFX, frame });
const ambient = (action: "start" | "stop" | "seek", frame?: ExecOp["frame"]): ExecOp => ({
  kind: "ambient",
  action,
  frame,
});
const pause = (ms: number, frame?: ExecOp["frame"]): ExecOp => ({ kind: "pause", ms, frame });

/** One line of what the fake audio, the listener and a fire's `onSettled` did, in order. */
type Event =
  | ["onChannelComplete", AudioChannel]
  | ["play", AudioChannel, string, boolean]
  | ["stop", AudioChannel, { cancelled: boolean | null }]
  | ["seek", AudioChannel]
  | ["busTaken", AudioBus, { activeId: string | null }]
  | ["fireFinished", AudioBus, string, { activeId: string | null }]
  | ["settled", string, { activeId: string | null }];

type Harness = {
  playback: Playback;
  buses: BusTable;
  events: Event[];
  /** The complete callback each channel's last play registered. */
  callbacks: Map<AudioChannel, () => void>;
  /** Fire the complete callback a channel's last play registered, as the mixer would at the clip's end. */
  complete(channel: AudioChannel): void;
  /** Make `playOnChannel` return `false` for these paths. */
  failing: Set<string>;
  /** Whether `stopChannel` runs the channel's complete callback at once, as the mixer may. */
  stopCompletesSynchronously: boolean;
  /** Throw from `playOnChannel` for these paths. */
  throwing: Set<string>;
  manifest: AudioAssetsManifest;
};

function harness(): Harness {
  const events: Event[] = [];
  const callbacks = new Map<AudioChannel, () => void>();
  const buses = new BusTable(() => new PendingQueue<WaitingFire>(() => false));
  const activeId = (bus: AudioBus): string | null => buses.peek(bus)?.transport.active?.id ?? null;
  const h: Harness = {
    playback: undefined as unknown as Playback,
    buses,
    events,
    callbacks,
    complete(channel) {
      const cb = callbacks.get(channel);
      callbacks.delete(channel);
      cb?.();
    },
    failing: new Set(),
    stopCompletesSynchronously: false,
    throwing: new Set(),
    manifest: { clips: [], ambientLoop: LOOP_A, ticks: { open: TICK_OPEN, close: TICK_CLOSE } },
  };
  const audio = {
    playOnChannel: (channel: AudioChannel, path: string, loop = false): boolean => {
      if (h.throwing.has(path)) throw new Error(`cannot play ${path}`);

      events.push(["play", channel, path, loop]);

      return !h.failing.has(path);
    },
    stopChannel: (channel: AudioChannel): void => {
      // What the fire being stopped says of itself at this moment — the
      // Voice bus's, which every fire here plays on.
      const active = buses.peek(AudioBus.Voice)?.transport.active ?? null;
      events.push(["stop", channel, { cancelled: active === null ? null : active.cancelled }]);

      if (h.stopCompletesSynchronously) h.complete(channel);
    },
    onChannelComplete: (channel: AudioChannel, cb: () => void): void => {
      events.push(["onChannelComplete", channel]);
      callbacks.set(channel, cb);
    },
    seekChannelRandom: (channel: AudioChannel): void => {
      events.push(["seek", channel]);
    },
  } as unknown as IAudioService;
  const listener: PlaybackListener = {
    busTaken: (bus) => events.push(["busTaken", bus, { activeId: activeId(bus) }]),
    fireFinished: (bus, id) => events.push(["fireFinished", bus, id, { activeId: activeId(bus) }]),
  };
  h.playback = new Playback(audio, logger, buses, listener, { pools: { currentManifest: () => h.manifest } });

  return h;
}

function start(ops: ExecOp[], overrides: Partial<FireStart> = {}): FireStart {
  return {
    id: "pit-crew.x",
    bus: AudioBus.Voice,
    weight: 50,
    ops,
    sourceOps: ops,
    sourceStart: 0,
    prerollCount: 0,
    event: null,
    sessionGeneration: 0,
    cutTail: [],
    ended: false,
    ...overrides,
  };
}

/** `takeBus` then `stepNext`, as the scheduler does around its log lines. */
function run(h: Harness, fire: FireStart): void {
  h.playback.takeBus(fire);
  h.playback.stepNext(fire.bus);
}

const onSettledOf = (h: Harness, id: string) => () => {
  h.events.push(["settled", id, { activeId: h.buses.peek(AudioBus.Voice)?.transport.active?.id ?? null }]);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── takeBus ─────────────────────────────────────────────────────────────────

describe("takeBus", () => {
  it("reports `busTaken` before the fire is on the bus, then fills in the transport fields", () => {
    const h = harness();
    const ops = [sfx(TICK_OPEN, "open"), play("a.mp3"), ambient("stop", "close")];
    const onSettled = (): void => {};

    h.playback.takeBus(start(ops, { onSettled, sessionGeneration: 3, cutTail: [play("nm.mp3")] }));

    expect(h.events).toEqual([["busTaken", AudioBus.Voice, { activeId: null }]]);
    expect(h.buses.get(AudioBus.Voice).transport.active).toEqual({
      id: "pit-crew.x",
      bus: AudioBus.Voice,
      weight: 50,
      ops,
      index: 0,
      sourceOps: ops,
      sourceStart: 0,
      prerollCount: 0,
      cancelled: false,
      pauseTimer: null,
      usedChannels: new Set([AudioChannel.SFX, AudioChannel.Voice, AudioChannel.Ambient]),
      event: null,
      sessionGeneration: 3,
      cutTail: [play("nm.mp3")],
      ended: false,
      onSettled,
    });
  });

  it("replaces the bus's fire, and `busTaken` still sees the one it replaces", () => {
    const h = harness();

    h.playback.takeBus(start([play("a.mp3")], { id: "first" }));
    h.playback.takeBus(start([play("b.mp3")], { id: "second" }));

    expect(h.events).toEqual([
      ["busTaken", AudioBus.Voice, { activeId: null }],
      ["busTaken", AudioBus.Voice, { activeId: "first" }],
    ]);
    expect(h.buses.get(AudioBus.Voice).transport.active?.id).toBe("second");
  });

  it("plays nothing by itself: the caller starts the fire with `stepNext`", () => {
    const h = harness();

    h.playback.takeBus(start([play("a.mp3")]));

    expect(h.events.filter(([kind]) => kind === "play")).toEqual([]);
  });
});

// ─── stepping ────────────────────────────────────────────────────────────────

describe("stepNext", () => {
  it("plays one op per channel completion, registering the completion before the play", () => {
    const h = harness();

    run(h, start([sfx(TICK_OPEN, "open"), play("a.mp3"), play("b.mp3")]));

    expect(h.events).toEqual([
      ["busTaken", AudioBus.Voice, { activeId: null }],
      ["onChannelComplete", AudioChannel.SFX],
      ["play", AudioChannel.SFX, TICK_OPEN, false],
    ]);
    expect(h.buses.get(AudioBus.Voice).transport.active?.index).toBe(1);

    h.complete(AudioChannel.SFX);

    expect(h.events.slice(3)).toEqual([
      ["onChannelComplete", AudioChannel.Voice],
      ["play", AudioChannel.Voice, "a.mp3", false],
    ]);

    h.complete(AudioChannel.Voice);

    expect(h.events.slice(5)).toEqual([
      ["onChannelComplete", AudioChannel.Voice],
      ["play", AudioChannel.Voice, "b.mp3", false],
    ]);
    expect(h.buses.get(AudioBus.Voice).transport.active?.index).toBe(3);
  });

  it("finishes after the last op: the bus idles, `onSettled` runs, then `fireFinished` — in that order", () => {
    const h = harness();

    run(h, start([play("a.mp3")], { onSettled: onSettledOf(h, "pit-crew.x") }));
    h.complete(AudioChannel.Voice);

    expect(h.events.slice(3)).toEqual([
      ["settled", "pit-crew.x", { activeId: null }],
      ["fireFinished", AudioBus.Voice, "pit-crew.x", { activeId: null }],
    ]);
    expect(h.buses.get(AudioBus.Voice).transport.active).toBeNull();
  });

  it("finishes a fire with no ops at once", () => {
    const h = harness();

    run(h, start([]));

    expect(h.events).toEqual([
      ["busTaken", AudioBus.Voice, { activeId: null }],
      ["fireFinished", AudioBus.Voice, "pit-crew.x", { activeId: null }],
    ]);
  });

  it("clears `onSettled` once run, so a fire settles once", () => {
    const h = harness();
    const onSettled = vi.fn();

    run(h, start([], { onSettled }));

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(h.events.some(([kind]) => kind === "fireFinished")).toBe(true);
  });

  it("logs and swallows an `onSettled` that throws, and still reports the finish", () => {
    const h = harness();

    run(
      h,
      start([], {
        onSettled: () => {
          throw new Error("boom");
        },
      }),
    );

    expect(logger.error).toHaveBeenCalledWith('"pit-crew.x" completion callback threw: boom');
    expect(h.events.at(-1)).toEqual(["fireFinished", AudioBus.Voice, "pit-crew.x", { activeId: null }]);
  });

  it("warns and advances when a clip fails to start", () => {
    const h = harness();
    h.failing.add("a.mp3");

    run(h, start([play("a.mp3"), play("b.mp3")]));

    expect(logger.warn).toHaveBeenCalledWith(`Failed to play a.mp3 on channel ${AudioChannel.Voice}; advancing`);
    expect(h.events.slice(1)).toEqual([
      ["onChannelComplete", AudioChannel.Voice],
      ["play", AudioChannel.Voice, "a.mp3", false],
      ["onChannelComplete", AudioChannel.Voice],
      ["play", AudioChannel.Voice, "b.mp3", false],
    ]);
  });

  it("logs and advances when a step throws", () => {
    const h = harness();
    h.throwing.add("a.mp3");

    run(h, start([play("a.mp3"), play("b.mp3")]));

    expect(logger.error).toHaveBeenCalledWith('Scenario "pit-crew.x" step threw: cannot play a.mp3');
    expect(h.events.filter(([kind]) => kind === "play")).toEqual([["play", AudioChannel.Voice, "b.mp3", false]]);
  });

  it("ignores a completion for a fire that is no longer the bus's", () => {
    const h = harness();

    run(h, start([play("a.mp3"), play("b.mp3")], { id: "first" }));
    const stale = h.callbacks.get(AudioChannel.Voice);
    // Replaced without a cut: the first fire is not cancelled, only off the bus.
    run(h, start([play("c.mp3"), play("d.mp3")], { id: "second" }));

    const before = h.events.length;
    // The mixer completes the first fire's clip late, after the second took the bus.
    stale?.();

    expect(h.events.slice(before)).toEqual([]);
    expect(h.buses.get(AudioBus.Voice).transport.active).toMatchObject({ id: "second", index: 1 });
  });

  it("does nothing on an idle bus, or for a cancelled fire", () => {
    const h = harness();

    h.playback.stepNext(AudioBus.Voice);
    expect(h.events).toEqual([]);

    run(h, start([play("a.mp3"), play("b.mp3")]));
    const fire = h.buses.get(AudioBus.Voice).transport.active;

    // Not through `cancelActiveFire`: the fire stays on the bus, marked.
    if (fire) fire.cancelled = true;

    h.playback.stepNext(AudioBus.Voice);

    expect(h.events.filter(([kind]) => kind === "play")).toHaveLength(1);
  });

  describe("ambient ops", () => {
    it("starts the loop from the manifest in force at the step, looping, and advances at once", () => {
      const h = harness();

      run(h, start([ambient("start", "open"), play("a.mp3"), ambient("seek"), ambient("start")]));

      expect(h.events.slice(1)).toEqual([
        ["play", AudioChannel.Ambient, LOOP_A, true],
        ["onChannelComplete", AudioChannel.Voice],
        ["play", AudioChannel.Voice, "a.mp3", false],
      ]);

      // `setManifest` swapped the loop while the clip played.
      h.manifest = { ...h.manifest, ambientLoop: LOOP_B };
      h.complete(AudioChannel.Voice);

      expect(h.events.slice(4)).toEqual([
        ["seek", AudioChannel.Ambient],
        ["play", AudioChannel.Ambient, LOOP_B, true],
        ["fireFinished", AudioBus.Voice, "pit-crew.x", { activeId: null }],
      ]);
    });

    it("stops the ambient channel on `stop` and advances at once", () => {
      const h = harness();

      run(h, start([ambient("stop", "close"), sfx(TICK_CLOSE, "close")]));

      expect(h.events.slice(1)).toEqual([
        ["stop", AudioChannel.Ambient, { cancelled: false }],
        ["onChannelComplete", AudioChannel.SFX],
        ["play", AudioChannel.SFX, TICK_CLOSE, false],
      ]);
    });
  });

  describe("pauses", () => {
    it("holds the fire for the pause and advances when it expires", () => {
      const h = harness();

      run(h, start([pause(250), play("a.mp3")]));

      expect(h.events).toHaveLength(1);
      expect(h.buses.get(AudioBus.Voice).transport.active?.pauseTimer).not.toBeNull();

      vi.advanceTimersByTime(249);
      expect(h.events).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(h.events.slice(1)).toEqual([
        ["onChannelComplete", AudioChannel.Voice],
        ["play", AudioChannel.Voice, "a.mp3", false],
      ]);
      expect(h.buses.get(AudioBus.Voice).transport.active?.pauseTimer).toBeNull();
    });

    it("advances at once through a pause of zero or less", () => {
      const h = harness();

      run(h, start([pause(0), pause(-5), play("a.mp3")]));

      expect(h.events.slice(1)).toEqual([
        ["onChannelComplete", AudioChannel.Voice],
        ["play", AudioChannel.Voice, "a.mp3", false],
      ]);
    });

    it("a pause whose fire was cancelled does not step it when the timer would have expired", () => {
      const h = harness();

      run(h, start([pause(250), play("a.mp3")]));
      const fire = h.buses.get(AudioBus.Voice).transport.active;

      if (fire) fire.cancelled = true;

      vi.advanceTimersByTime(250);

      expect(h.events.filter(([kind]) => kind === "play")).toEqual([]);
    });
  });
});

// ─── cancelActiveFire ────────────────────────────────────────────────────────

describe("cancelActiveFire", () => {
  it("marks the fire cancelled, clears its pause, stops only its channels, idles the bus and settles it — reporting nothing", () => {
    const h = harness();
    // Voice and SFX, never Ambient: another bus's bed must not be stopped.
    const ops = [sfx(TICK_OPEN, "open"), play("a.mp3"), pause(500), play("b.mp3")];

    run(h, start(ops, { onSettled: onSettledOf(h, "pit-crew.x") }));
    h.complete(AudioChannel.SFX);
    h.complete(AudioChannel.Voice);
    // The fire is in its pause.
    const fire = h.buses.get(AudioBus.Voice).transport.active;
    expect(fire?.pauseTimer).not.toBeNull();

    const before = h.events.length;
    h.playback.cancelActiveFire(AudioBus.Voice);

    expect(h.events.slice(before)).toEqual([
      ["stop", AudioChannel.SFX, { cancelled: true }],
      ["stop", AudioChannel.Voice, { cancelled: true }],
      ["settled", "pit-crew.x", { activeId: null }],
    ]);
    expect(fire?.cancelled).toBe(true);
    expect(fire?.pauseTimer).toBeNull();
    expect(h.buses.get(AudioBus.Voice).transport.active).toBeNull();

    // The cleared pause never steps it.
    vi.advanceTimersByTime(500);
    expect(h.events).toHaveLength(before + 3);
  });

  it("stops the ambient channel too when the fire drove the bed", () => {
    const h = harness();

    run(h, start([ambient("start", "open"), play("a.mp3")]));
    const before = h.events.length;
    h.playback.cancelActiveFire(AudioBus.Voice);

    expect(h.events.slice(before).map(([kind, channel]) => [kind, channel])).toEqual([
      ["stop", AudioChannel.Ambient],
      ["stop", AudioChannel.Voice],
    ]);
  });

  it("is a no-op on an idle bus", () => {
    const h = harness();

    h.playback.cancelActiveFire(AudioBus.Voice);
    h.playback.cancelActiveFire(AudioBus.Background);

    expect(h.events).toEqual([]);
    // A stray cancel adds no table entry: the table's order is every per-bus loop's.
    expect(h.buses.peek(AudioBus.Voice)).toBeUndefined();
    expect(h.buses.peek(AudioBus.Background)).toBeUndefined();
  });

  it("marks the fire cancelled BEFORE a channel stops, so a stop that completes at once cannot advance it", () => {
    const h = harness();
    h.stopCompletesSynchronously = true;

    run(h, start([play("a.mp3"), play("b.mp3")]));
    const before = h.events.length;
    h.playback.cancelActiveFire(AudioBus.Voice);

    expect(h.events.slice(before)).toEqual([["stop", AudioChannel.Voice, { cancelled: true }]]);
    expect(h.events.filter(([kind, , path]) => kind === "play" && path === "b.mp3")).toEqual([]);
  });

  it("does not run `onSettled` twice when the cut fire's completion arrives late", () => {
    const h = harness();
    const onSettled = vi.fn();

    run(h, start([play("a.mp3")], { onSettled }));
    h.playback.cancelActiveFire(AudioBus.Voice);
    h.complete(AudioChannel.Voice);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(h.events.some(([kind]) => kind === "fireFinished")).toBe(false);
  });
});

// ─── playCutTail ─────────────────────────────────────────────────────────────

describe("playCutTail", () => {
  const TAIL_WITH_STOP = [play("never-mind.mp3", { frame: "cut" }), ambient("stop", "cut"), sfx(TICK_CLOSE, "cut")];
  const TAIL_WITHOUT_STOP = [play("never-mind.mp3", { frame: "cut" }), sfx(TICK_CLOSE, "cut")];
  const BODY = [
    sfx(TICK_OPEN, "open"),
    ambient("start", "open"),
    play("a.mp3"),
    play("b.mp3"),
    ambient("stop", "close"),
  ];

  it("marks the old fire cancelled before any channel stops, puts the tail on the bus and starts it", () => {
    const h = harness();
    h.stopCompletesSynchronously = true;
    const onSettled = onSettledOf(h, "pit-crew.x");
    const event = {
      event: "pitLane.entered",
      timestamp: 1,
      telemetry: null,
      data: null,
    } as unknown as FireStart["event"];

    run(h, start(BODY, { cutTail: TAIL_WITHOUT_STOP, onSettled, event, sessionGeneration: 4 }));
    h.complete(AudioChannel.SFX);
    // The open tick and the bed have played; "a.mp3" is in flight.
    const old = h.buses.get(AudioBus.Voice).transport.active;
    expect(old?.index).toBe(3);
    const before = h.events.length;

    h.playback.playCutTail(AudioBus.Voice);

    expect(old?.cancelled).toBe(true);
    // The old fire's completion, run synchronously by the stop, played nothing more of it.
    expect(h.events.slice(before)).toEqual([
      ["stop", AudioChannel.SFX, { cancelled: true }],
      ["stop", AudioChannel.Ambient, { cancelled: true }],
      ["stop", AudioChannel.Voice, { cancelled: true }],
      ["busTaken", AudioBus.Voice, { activeId: "pit-crew.x" }],
      ["onChannelComplete", AudioChannel.Voice],
      ["play", AudioChannel.Voice, "never-mind.mp3", false],
    ]);

    const tail = h.buses.get(AudioBus.Voice).transport.active;
    expect(tail).not.toBe(old);
    expect(tail).toMatchObject({
      id: "pit-crew.x",
      bus: AudioBus.Voice,
      weight: 50,
      ops: TAIL_WITHOUT_STOP,
      index: 1,
      sourceOps: TAIL_WITHOUT_STOP,
      sourceStart: 0,
      prerollCount: 0,
      cancelled: false,
      usedChannels: new Set([AudioChannel.Voice, AudioChannel.SFX]),
      event,
      sessionGeneration: 4,
      cutTail: [],
      ended: true,
      onSettled,
    });
    // The old fire was not settled: the tail inherited `onSettled`, which runs when the tail leaves the bus.
    expect(h.events.some(([kind]) => kind === "settled")).toBe(false);

    h.complete(AudioChannel.Voice);
    h.complete(AudioChannel.SFX);

    expect(h.events.slice(-2)).toEqual([
      ["settled", "pit-crew.x", { activeId: null }],
      ["fireFinished", AudioBus.Voice, "pit-crew.x", { activeId: null }],
    ]);
  });

  it("leaves the ambience bed running when the tail stops it itself", () => {
    const h = harness();

    run(h, start(BODY, { cutTail: TAIL_WITH_STOP }));
    h.complete(AudioChannel.SFX);
    const before = h.events.length;

    h.playback.playCutTail(AudioBus.Voice);

    expect(h.events.slice(before, before + 2)).toEqual([
      ["stop", AudioChannel.SFX, { cancelled: true }],
      ["stop", AudioChannel.Voice, { cancelled: true }],
    ]);
  });

  it("clears a pause the old fire was in", () => {
    const h = harness();

    run(h, start([play("a.mp3"), pause(500), play("b.mp3")], { cutTail: TAIL_WITHOUT_STOP }));
    h.complete(AudioChannel.Voice);
    const old = h.buses.get(AudioBus.Voice).transport.active;
    expect(old?.pauseTimer).not.toBeNull();

    h.playback.playCutTail(AudioBus.Voice);
    vi.advanceTimersByTime(500);

    expect(old?.pauseTimer).toBeNull();
    expect(h.events.filter(([kind, , path]) => kind === "play" && path === "b.mp3")).toEqual([]);
  });

  it("is a no-op on an idle bus", () => {
    const h = harness();

    h.playback.playCutTail(AudioBus.Voice);

    expect(h.events).toEqual([]);
    // No fire to end, so no bus take — and no table entry for the asking.
    expect(h.buses.peek(AudioBus.Voice)).toBeUndefined();
  });
});

// ─── opLabel ─────────────────────────────────────────────────────────────────

describe("opLabel", () => {
  it.each<[string, ExecOp, string]>([
    ["a body clip", play("voice/v1/a.mp3"), `play[${AudioChannel.Voice}] voice/v1/a.mp3`],
    [
      "a pool take",
      play("voice/v1/a-02.mp3", { pool: "words" }),
      `play[${AudioChannel.Voice}] voice/v1/a-02.mp3 (words)`,
    ],
    ["a frame clip", sfx(TICK_OPEN, "open"), `open:play[${AudioChannel.SFX}] ${TICK_OPEN}`],
    ["an ambient op", ambient("start", "open"), "open:ambient:start"],
    ["an untagged ambient op", ambient("seek"), "ambient:seek"],
    ["a pause", pause(250, "cut"), "cut:pause:250"],
    ["an untagged pause", pause(1000), "pause:1000"],
  ])("%s", (_name, op, label) => {
    expect(opLabel(op)).toBe(label);
  });
});
