import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest, IScenarioEngine } from "./interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "./interpreter.js";

// ─── Test utilities ──────────────────────────────────────────────────────────

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

/** In-memory event bus for tests. */
function createMockBus(): IEventBus & { publishEvent: (name: SimEventName, data?: unknown) => void } {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => {
        handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      const set = handlers.get(event.event as SimEventName);

      if (!set) return;

      for (const handler of Array.from(set)) handler(event);
    },
    publishEvent(name, data) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: null as unknown,
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _completions: (() => void)[];
  _played: { channel: AudioChannel; path: string; loop: boolean }[];
  _stopped: AudioChannel[];
};

/**
 * Fake audio-service that records calls and lets tests drive channel-complete
 * callbacks manually. Fires for synchronous clip playback via `_triggerChannelEnd`.
 */
function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Spotter]: null,
  };
  const played: { channel: AudioChannel; path: string; loop: boolean }[] = [];
  const stopped: AudioChannel[] = [];

  const audio = {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string, loop = false) => {
      played.push({ channel, path, loop });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => {
      stopped.push(channel);
      callbacks[channel] = null;
    }),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks[channel] = cb;
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
    _triggerChannelEnd: (channel: AudioChannel) => {
      const cb = callbacks[channel];
      callbacks[channel] = null;
      cb?.();
    },
    _completions: [],
    _played: played,
    _stopped: stopped,
  } as unknown as FakeAudio;

  return audio;
}

const manifest: AudioAssetsManifest = {
  clips: [
    "pit-engineer/greeting/a.mp3",
    "pit-engineer/greeting/b.mp3",
    "pit-engineer/connector/and.mp3",
    "pit-engineer/connector/also.mp3",
    "pit-engineer/reminder/fuel.mp3",
    "pit-engineer/reminder/autofuel.mp3",
    "pit-engineer/reminder/tires.mp3",
    "pit-engineer/names/alice.mp3",
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** Helper: run all ops on Voice/SFX channels by repeatedly triggering channel-end. */
function flushVoiceAndSfx(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    // Drain whichever channel currently has a callback. Order doesn't matter
    // for tests because only one play is in-flight at a time.
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never);
  engine.definePool("connector", ["pit-engineer/connector/and.mp3", "pit-engineer/connector/also.mp3"]);
});

afterEach(() => {
  _resetAudioScenarios();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ─── String shorthand expansion ─────────────────────────────────────────────

describe("string shorthand expansion", () => {
  it("applies the scenario `base` to relative clip paths", () => {
    engine.defineScenario({
      id: "test.welcome",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-engineer",
      sequence: ["greeting/a.mp3"],
    });

    engine.fire("test.welcome");

    const played = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(played).toEqual(["pit-engineer/greeting/a.mp3"]);
  });

  it("leading-slash escapes the base and routes ticks to the SFX channel", () => {
    engine.defineScenario({
      id: "test.escape",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-engineer",
      sequence: ["/sfx/IRD-tick-open.mp3", "greeting/a.mp3"],
    });

    engine.fire("test.escape");

    expect(audio._played).toEqual([
      { channel: AudioChannel.SFX, path: "sfx/IRD-tick-open.mp3", loop: false },
    ]);

    audio._triggerChannelEnd(AudioChannel.SFX);

    expect(audio._played).toEqual([
      { channel: AudioChannel.SFX, path: "sfx/IRD-tick-open.mp3", loop: false },
      { channel: AudioChannel.Voice, path: "pit-engineer/greeting/a.mp3", loop: false },
    ]);
  });
});

// ─── Pools ──────────────────────────────────────────────────────────────────

describe("pools", () => {
  it("noRepeat avoids the same pick twice in a row across scenarios sharing the pool", () => {
    engine.definePool("shared", ["pit-engineer/greeting/a.mp3", "pit-engineer/greeting/b.mp3"]);

    // Force Math.random to return the same value to make the "same pick" case obvious.
    const stub = vi.spyOn(Math, "random").mockReturnValue(0);

    engine.defineScenario({
      id: "test.a",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:shared"],
    });
    engine.defineScenario({
      id: "test.b",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:shared"],
    });

    engine.fire("test.a");
    flushVoiceAndSfx(audio);
    engine.fire("test.b");
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-engineer/greeting/a.mp3", "pit-engineer/greeting/b.mp3"]);

    stub.mockRestore();
  });
});

// ─── Variables ──────────────────────────────────────────────────────────────

describe("variables", () => {
  it("calls the resolver each time the variable is referenced", () => {
    const resolver = vi.fn(() => "pit-engineer/names/alice.mp3");
    engine.defineVar("name", resolver);
    engine.defineScenario({
      id: "test.var",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["{{name}}"],
    });

    engine.fire("test.var");

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(audio._played.at(-1)).toEqual({
      channel: AudioChannel.Voice,
      path: "pit-engineer/names/alice.mp3",
      loop: false,
    });
  });

  it("skips the variable when the resolver returns null", () => {
    engine.defineVar("name", () => null);
    engine.defineScenario({
      id: "test.var-null",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["{{name}}", "pit-engineer/greeting/a.mp3"],
    });

    engine.fire("test.var-null");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/greeting/a.mp3"]);
  });
});

// ─── Conditionals ───────────────────────────────────────────────────────────

describe("conditionals", () => {
  it("selects the `then` branch when the predicate is true", () => {
    engine.defineScenario({
      id: "test.if-then",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        {
          if: () => true,
          then: ["pit-engineer/reminder/autofuel.mp3"],
          else: ["pit-engineer/reminder/fuel.mp3"],
        },
      ],
    });

    engine.fire("test.if-then");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/reminder/autofuel.mp3"]);
  });

  it("selects the `else` branch when the predicate is false", () => {
    engine.defineScenario({
      id: "test.if-else",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        {
          if: () => false,
          then: ["pit-engineer/reminder/autofuel.mp3"],
          else: ["pit-engineer/reminder/fuel.mp3"],
        },
      ],
    });

    engine.fire("test.if-else");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/reminder/fuel.mp3"]);
  });

  it("skips the branch entirely when false and no else is provided", () => {
    engine.defineScenario({
      id: "test.if-no-else",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        "pit-engineer/reminder/fuel.mp3",
        { if: () => false, then: ["pit-engineer/reminder/autofuel.mp3"] },
      ],
    });

    engine.fire("test.if-no-else");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/reminder/fuel.mp3"]);
  });
});

// ─── Includes ───────────────────────────────────────────────────────────────

describe("includes", () => {
  it("splices in the included scenario's resolved sequence", () => {
    engine.defineScenario({
      id: "test.radio-open",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["/sfx/IRD-tick-open.mp3", { ambient: "start" }],
    });
    engine.defineScenario({
      id: "test.welcome",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-engineer",
      sequence: ["@test.radio-open", "greeting/a.mp3"],
    });

    engine.fire("test.welcome");
    flushVoiceAndSfx(audio);

    expect(audio._played).toEqual([
      { channel: AudioChannel.SFX, path: "sfx/IRD-tick-open.mp3", loop: false },
      { channel: AudioChannel.Ambient, path: "sfx/IRD-ambient-pit.mp3", loop: true },
      { channel: AudioChannel.Voice, path: "pit-engineer/greeting/a.mp3", loop: false },
    ]);
  });

  it("rejects an include cycle at load time and disables the scenario", () => {
    engine.defineScenario({
      id: "test.a",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["@test.b"],
    });

    engine.defineScenario({
      id: "test.b",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["@test.a"],
    });

    engine.fire("test.a");

    // No voice plays should happen — both scenarios are disabled by validation.
    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice)).toEqual([]);
  });
});

// ─── Cooldown ───────────────────────────────────────────────────────────────

describe("cooldown", () => {
  it("drops a re-fire before the cooldown elapses", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);

    engine.defineScenario({
      id: "test.cool",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      cooldown: 5000,
      sequence: ["pit-engineer/greeting/a.mp3"],
    });

    engine.fire("test.cool");
    flushVoiceAndSfx(audio);
    expect(audio._played.length).toBe(1);

    now.mockReturnValue(3000);
    engine.fire("test.cool");
    flushVoiceAndSfx(audio);
    expect(audio._played.length).toBe(1);

    now.mockReturnValue(6500);
    engine.fire("test.cool");
    flushVoiceAndSfx(audio);
    expect(audio._played.length).toBe(2);

    now.mockRestore();
  });
});

// ─── Priority / preempt / deferred replay ───────────────────────────────────

describe("priority", () => {
  it("drops a same-priority fire while the bus is busy", () => {
    engine.defineScenario({
      id: "test.a",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.b",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/greeting/b.mp3"],
    });

    engine.fire("test.a"); // starts playing
    engine.fire("test.b"); // dropped

    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/greeting/a.mp3"]);
  });

  it("urgent+preempt cancels a running non-urgent scenario", () => {
    engine.defineScenario({
      id: "test.normal",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/greeting/a.mp3", "pit-engineer/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.urgent",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      priority: "urgent",
      preempt: true,
      sequence: ["pit-engineer/reminder/fuel.mp3"],
    });

    engine.fire("test.normal"); // first clip starts
    // Now urgent preempts before the first clip ends.
    engine.fire("test.urgent");
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-engineer/greeting/a.mp3", "pit-engineer/reminder/fuel.mp3"]);
    expect(audio._stopped).toContain(AudioChannel.Voice);
  });

  it("defers a low-priority fire while busy and replays it when the bus goes idle", () => {
    engine.defineScenario({
      id: "test.high",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      priority: "high",
      sequence: ["pit-engineer/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.low",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      priority: "low",
      sequence: ["pit-engineer/reminder/fuel.mp3"],
    });

    engine.fire("test.high"); // starts
    engine.fire("test.low"); // deferred

    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-engineer/greeting/a.mp3", "pit-engineer/reminder/fuel.mp3"]);
  });

  it("tracks active fires per bus — one bus's cancellation doesn't touch another", () => {
    // Two scenarios on different buses. Starting the second one must not
    // cancel the first; both must be able to advance independently.
    engine.defineScenario({
      id: "test.voice-bus",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/greeting/a.mp3", "pit-engineer/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.alerts-bus",
      channel: AudioChannel.Spotter,
      bus: AudioBus.Alerts,
      sequence: ["pit-engineer/greeting/a.mp3"],
    });

    engine.fire("test.voice-bus"); // starts on Voice bus
    engine.fire("test.alerts-bus"); // starts on Alerts bus — must NOT overwrite voice

    // Alerts-bus clip plays on the Spotter channel (resolved by the
    // scenario's declared channel); finish it.
    audio._triggerChannelEnd(AudioChannel.Spotter);
    // Voice bus's first clip finishes — its second clip should still follow.
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.Voice);

    const voicePaths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voicePaths).toEqual(["pit-engineer/greeting/a.mp3", "pit-engineer/greeting/b.mp3"]);
  });

  it("preserves the event context when a deferred low fire is replayed", () => {
    const seenOnReplay: unknown[] = [];

    engine.defineScenario({
      id: "test.high2",
      when: { event: "pitLane.approaching" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      priority: "high",
      sequence: ["pit-engineer/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.low-with-data",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      priority: "low",
      sequence: [
        {
          if: (ctx) => {
            seenOnReplay.push(ctx.data);

            return (ctx.data as { should: boolean })?.should === true;
          },
          then: ["pit-engineer/reminder/fuel.mp3"],
          else: ["pit-engineer/reminder/tires.mp3"],
        },
      ],
    });

    bus.publishEvent("pitLane.approaching", {}); // starts the high scenario
    bus.publish({
      event: "pitLane.entered",
      timestamp: Date.now(),
      telemetry: null,
      data: { should: true } as never,
    } as never);

    flushVoiceAndSfx(audio);

    // The deferred low fire must replay with the original event data (should=true),
    // taking the `then` branch — not collapse to the `else` branch that `null` data
    // would produce.
    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-engineer/greeting/a.mp3", "pit-engineer/reminder/fuel.mp3"]);
    expect(seenOnReplay.at(-1)).toEqual({ should: true });
  });
});

// ─── Event subscription ─────────────────────────────────────────────────────

describe("event subscription", () => {
  it("fires the scenario when the matching event is published", () => {
    engine.defineScenario({
      id: "test.on-approach",
      when: { event: "pitLane.approaching" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/greeting/a.mp3"],
    });

    bus.publishEvent("pitLane.approaching", {});
    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/greeting/a.mp3"]);
  });

  it("applies the `where` filter", () => {
    engine.defineScenario({
      id: "test.fuel-3",
      when: {
        event: "fuel.lapsRemaining.crossed",
        where: (e) => (e as SimEventOf<"fuel.lapsRemaining.crossed">).data.threshold === 3,
      },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/reminder/fuel.mp3"],
    });

    bus.publish({
      event: "fuel.lapsRemaining.crossed",
      timestamp: Date.now(),
      telemetry: null,
      data: { threshold: 5, laps: 5 },
    } as SimEventMap["fuel.lapsRemaining.crossed"]);
    bus.publish({
      event: "fuel.lapsRemaining.crossed",
      timestamp: Date.now(),
      telemetry: null,
      data: { threshold: 3, laps: 3 },
    } as SimEventMap["fuel.lapsRemaining.crossed"]);

    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual(["pit-engineer/reminder/fuel.mp3"]);
  });

  it("setEnabled(false) cancels in-flight and ignores new fires", () => {
    engine.defineScenario({
      id: "test.toggle",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-engineer/greeting/a.mp3", "pit-engineer/greeting/b.mp3"],
    });

    bus.publishEvent("pitLane.entered", {});
    // First clip in flight. Disable while playing.
    engine.setEnabled("test.toggle", false);
    // Running was cancelled. Publishing again should be a no-op.
    bus.publishEvent("pitLane.entered", {});
    flushVoiceAndSfx(audio);

    // Only the first clip started; no further plays on Voice.
    const voicePaths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voicePaths).toEqual(["pit-engineer/greeting/a.mp3"]);
  });
});

// ─── Ambient side-effects ──────────────────────────────────────────────────

describe("ambient side-effects", () => {
  it("starts / seeks / stops the ambient channel in order", () => {
    engine.defineScenario({
      id: "test.ambient",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        { ambient: "start" },
        { ambient: "seek" },
        "pit-engineer/greeting/a.mp3",
        { ambient: "stop" },
      ],
    });

    engine.fire("test.ambient");
    flushVoiceAndSfx(audio);

    expect(audio.playOnChannel).toHaveBeenCalledWith(AudioChannel.Ambient, "sfx/IRD-ambient-pit.mp3", true);
    expect(audio.seekChannelRandom).toHaveBeenCalledWith(AudioChannel.Ambient);
    expect(audio.stopChannel).toHaveBeenCalledWith(AudioChannel.Ambient);
  });
});
