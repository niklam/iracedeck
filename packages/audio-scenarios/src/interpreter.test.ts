import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "./dsl.js";
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
    [AudioChannel.Radar]: null,
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
    "pit-crew/greeting/a.mp3",
    "pit-crew/greeting/b.mp3",
    "pit-crew/connector/and.mp3",
    "pit-crew/connector/also.mp3",
    "pit-crew/reminder/fuel.mp3",
    "pit-crew/reminder/autofuel.mp3",
    "pit-crew/reminder/tires.mp3",
    "pit-crew/names/alice.mp3",
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
  engine.definePool("connector", ["pit-crew/connector/and.mp3", "pit-crew/connector/also.mp3"]);
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
      base: "pit-crew",
      sequence: ["greeting/a.mp3"],
    });

    engine.fire("test.welcome");

    const played = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(played).toEqual(["pit-crew/greeting/a.mp3"]);
  });

  it("leading-slash escapes the base and routes ticks to the SFX channel", () => {
    engine.defineScenario({
      id: "test.escape",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-crew",
      sequence: ["/sfx/IRD-tick-open.mp3", "greeting/a.mp3"],
    });

    engine.fire("test.escape");

    expect(audio._played).toEqual([
      { channel: AudioChannel.SFX, path: "sfx/IRD-tick-open.mp3", loop: false },
    ]);

    audio._triggerChannelEnd(AudioChannel.SFX);

    expect(audio._played).toEqual([
      { channel: AudioChannel.SFX, path: "sfx/IRD-tick-open.mp3", loop: false },
      { channel: AudioChannel.Voice, path: "pit-crew/greeting/a.mp3", loop: false },
    ]);
  });
});

// ─── Pools ──────────────────────────────────────────────────────────────────

describe("pools", () => {
  it("noRepeat avoids the same pick twice in a row across scenarios sharing the pool", () => {
    engine.definePool("shared", ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"]);

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
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"]);

    stub.mockRestore();
  });
});

// ─── Manifest-derived pools (issue #664) ────────────────────────────────────

describe("manifest-derived pools (definePoolFromManifest)", () => {
  /**
   * Voiced manifest: `default` is the reference voice with two `blue`
   * variants (plus a near-miss `blue-cleared` base that must not leak into
   * the `blue` pool); `luca` carries an extra third variant; `titan` omits
   * the blue callout entirely.
   */
  const voicedManifest: AudioAssetsManifest = {
    clips: [
      "sfx/IRD-tick-open.mp3",
      "sfx/IRD-tick-close.mp3",
      "sfx/IRD-ambient-pit.mp3",
      "voice/default/flags/blue-01.mp3",
      "voice/default/flags/blue-02.mp3",
      "voice/default/flags/blue-cleared-01.mp3",
      "voice/luca/flags/blue-01.mp3",
      "voice/luca/flags/blue-02.mp3",
      "voice/luca/flags/blue-03.mp3",
      "voice/titan/flags/red-01.mp3",
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  let activeVoice: string | null;

  beforeEach(() => {
    _resetAudioScenarios();
    activeVoice = "default";
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, voicedManifest, mockLogger as never, () => activeVoice);
  });

  function defineBluePoolScenario(): void {
    engine.definePoolFromManifest("flag-blue", "flags", "blue");
    engine.defineScenario({
      id: "test.blue",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:flag-blue"],
    });
  }

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  it("resolves pool members from the manifest for the active voice at fire time", () => {
    const stub = vi.spyOn(Math, "random").mockReturnValue(0);
    defineBluePoolScenario();

    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    activeVoice = "luca";
    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    expect(voicePaths()[0]).toBe("voice/default/flags/blue-01.mp3");
    expect(voicePaths()[1]).toMatch(/^voice\/luca\/flags\/blue-0\d\.mp3$/);

    stub.mockRestore();
  });

  it("draws only from the active voice's own variants (counts may differ per voice)", () => {
    const stub = vi.spyOn(Math, "random").mockReturnValue(0.99);
    defineBluePoolScenario();

    activeVoice = "luca";
    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    activeVoice = "default";
    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    // luca has three variants (0.99 → index 2); default has two (0.99 → index 1).
    expect(voicePaths()).toEqual(["voice/luca/flags/blue-03.mp3", "voice/default/flags/blue-02.mp3"]);

    stub.mockRestore();
  });

  it("matches only exact <base>-NN members, not longer bases sharing the prefix", () => {
    // If the scan treated `base` as a prefix, sorted members would be
    // [blue-01, blue-02, blue-cleared-01] and 0.9 would pick blue-cleared-01.
    const stub = vi.spyOn(Math, "random").mockReturnValue(0.9);
    defineBluePoolScenario();

    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-02.mp3"]);

    stub.mockRestore();
  });

  it("resets the no-repeat tracker when the active voice changes", () => {
    const stub = vi.spyOn(Math, "random").mockReturnValue(0);
    defineBluePoolScenario();

    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    // Without the reset, the stale lastIndex (0) would bump the luca pick to
    // blue-02; with it, index 0 is a fresh pick.
    activeVoice = "luca";
    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3", "voice/luca/flags/blue-01.mp3"]);

    stub.mockRestore();
  });

  it("aborts the whole callout when the active voice has no clips for a required pool (issue #835)", () => {
    engine.definePoolFromManifest("flag-blue", "flags", "blue");
    engine.defineScenario({
      id: "test.blue-then-tick",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:flag-blue", "sfx/IRD-tick-close.mp3"],
    });

    activeVoice = "titan";
    engine.fire("test.blue-then-tick");
    flushVoiceAndSfx(audio);

    // The whole callout is skipped — never a fragment, so no trailing tick.
    expect(audio._played).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("aborts the whole callout when no voice is selected", () => {
    defineBluePoolScenario();

    activeVoice = null;
    engine.fire("test.blue");
    flushVoiceAndSfx(audio);

    expect(audio._played).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("warns at define time when the reference voice has no clips for the base (typo guard), without disabling", () => {
    engine.definePoolFromManifest("flag-purple", "flags", "purple");

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("flag-purple"));

    // The pool is still registered — a scenario referencing it validates clean.
    engine.defineScenario({
      id: "test.purple",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:flag-purple"],
    });

    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("registers a {voice}-templated static pool when the reference voice has the clip, even if another voice lacks it", () => {
    engine.definePool("static-blue", ["voice/{voice}/flags/blue-01.mp3"]);

    expect(mockLogger.error).not.toHaveBeenCalled();

    engine.defineScenario({
      id: "test.static-blue",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:static-blue"],
    });
    engine.fire("test.static-blue");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
  });

  it("warns (not rejects) when a {voice}-templated static-pool clip is missing for the reference voice", () => {
    engine.definePool("static-purple", ["voice/{voice}/flags/purple-01.mp3"]);

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("static-purple"));
  });
});

// ─── Value pools: bare files + dynamic pool refs (issue #836) ────────────────

describe("value pools (issue #836)", () => {
  const valueManifest: AudioAssetsManifest = {
    clips: [
      "sfx/IRD-tick-open.mp3",
      "sfx/IRD-tick-close.mp3",
      "sfx/IRD-ambient-pit.mp3",
      // Bare value clip — a size-1 pool.
      "voice/default/position-number/7.mp3",
      // Bare + -NN variants form one pool.
      "voice/default/flags/blue.mp3",
      "voice/default/flags/blue-01.mp3",
      "voice/default/flags/blue-02.mp3",
      // luca carries the value with two variants; titan lacks it entirely.
      "voice/luca/position-number/7.mp3",
      "voice/luca/position-number/7-01.mp3",
      "voice/titan/flags/red-01.mp3",
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  let activeVoice: string | null;

  beforeEach(() => {
    _resetAudioScenarios();
    activeVoice = "default";
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, valueManifest, mockLogger as never, () => activeVoice);
  });

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  it("treats a bare <base>.mp3 as a size-1 registered pool", () => {
    engine.definePoolFromManifest("position-7", "position-number", "7");
    engine.defineScenario({
      id: "test.bare",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:position-7"],
    });

    engine.fire("test.bare");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/position-number/7.mp3"]);
  });

  it("unions bare and -NN files into one pool", () => {
    const stub = vi.spyOn(Math, "random").mockReturnValue(0.99);
    engine.definePoolFromManifest("flag-blue", "flags", "blue");
    engine.defineScenario({
      id: "test.mixed",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:flag-blue"],
    });

    engine.fire("test.mixed");
    flushVoiceAndSfx(audio);

    // Three members sorted [blue-01, blue-02, blue] — 0.99 picks index 2, the bare file.
    expect(voicePaths()).toEqual(["voice/default/flags/blue.mp3"]);

    stub.mockRestore();
  });

  it("resolves a var-returned pool reference for the active voice", () => {
    engine.defineVar("position", () => "pool:position-number/7");
    engine.defineScenario({
      id: "test.poolref",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["{{position}}"],
    });

    engine.fire("test.poolref");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/position-number/7.mp3"]);

    // luca draws from its own two variants.
    const stub = vi.spyOn(Math, "random").mockReturnValue(0);
    activeVoice = "luca";
    engine.fire("test.poolref");
    flushVoiceAndSfx(audio);

    expect(voicePaths().at(-1)).toMatch(/^voice\/luca\/position-number\/7(-01)?\.mp3$/);
    stub.mockRestore();
  });

  it("aborts the whole callout when a pool reference is empty for the active voice", () => {
    engine.defineVar("position", () => "pool:position-number/7");
    engine.defineScenario({
      id: "test.poolref-missing",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["/sfx/IRD-tick-open.mp3", "{{position}}"],
    });

    activeVoice = "titan";
    engine.fire("test.poolref-missing");
    flushVoiceAndSfx(audio);

    expect(audio._played).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("skips an optional group locally when its pool reference is empty for the active voice", () => {
    engine.defineVar("position", () => "pool:position-number/7");
    engine.defineScenario({
      id: "test.poolref-optional",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["/sfx/IRD-tick-open.mp3", { optional: ["{{position}}"] }, "/sfx/IRD-tick-close.mp3"],
    });

    activeVoice = "titan";
    engine.fire("test.poolref-optional");
    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });
});

// ─── Required-step abort + optional groups (issue #835) ─────────────────────

describe("required-step abort (issue #835)", () => {
  const voicedManifest: AudioAssetsManifest = {
    clips: [
      "sfx/IRD-tick-open.mp3",
      "sfx/IRD-tick-close.mp3",
      "sfx/IRD-ambient-pit.mp3",
      "voice/default/flags/blue-01.mp3",
      "voice/default/flags/blue-02.mp3",
      "voice/luca/flags/blue-01.mp3",
      "voice/titan/flags/red-01.mp3",
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  let activeVoice: string | null;

  beforeEach(() => {
    _resetAudioScenarios();
    activeVoice = "default";
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, voicedManifest, mockLogger as never, () => activeVoice);
  });

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  it("aborts the whole callout when a var resolves to a clip the active voice lacks", () => {
    engine.defineVar("clip", () => "voice/{voice}/flags/blue-01.mp3");
    engine.defineScenario({
      id: "test.var-clip",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["/sfx/IRD-tick-open.mp3", "{{clip}}", "/sfx/IRD-tick-close.mp3"],
    });

    activeVoice = "titan";
    engine.fire("test.var-clip");
    flushVoiceAndSfx(audio);

    expect(audio._played).toEqual([]);

    // The same fire works for a voice that has the clip.
    activeVoice = "default";
    engine.fire("test.var-clip");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
  });

  it("aborts the whole callout when a voice-templated clip step is missing for the active voice", () => {
    engine.defineScenario({
      id: "test.clip-step",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      sequence: ["/sfx/IRD-tick-open.mp3", "flags/blue-01.mp3", "/sfx/IRD-tick-close.mp3"],
    });

    activeVoice = "titan";
    engine.fire("test.clip-step");
    flushVoiceAndSfx(audio);

    expect(audio._played).toEqual([]);

    activeVoice = "luca";
    engine.fire("test.clip-step");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/luca/flags/blue-01.mp3"]);
  });

  it("skips an optional group locally when a member resolves to nothing, playing the rest", () => {
    engine.defineVar("missing", () => null);
    engine.defineScenario({
      id: "test.optional-skip",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        "/sfx/IRD-tick-open.mp3",
        { optional: ["voice/{voice}/flags/blue-01.mp3", "{{missing}}"] },
        "/sfx/IRD-tick-close.mp3",
      ],
    });

    engine.fire("test.optional-skip");
    flushVoiceAndSfx(audio);

    // The whole GROUP contributes nothing (no half-clause), the frame plays.
    expect(audio._played.map((p) => p.path)).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("plays an optional group in full when every member resolves", () => {
    engine.defineVar("present", () => "voice/{voice}/flags/blue-02.mp3");
    engine.defineScenario({
      id: "test.optional-plays",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        "/sfx/IRD-tick-open.mp3",
        { optional: ["voice/{voice}/flags/blue-01.mp3", "{{present}}"] },
        "/sfx/IRD-tick-close.mp3",
      ],
    });

    engine.fire("test.optional-plays");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3", "voice/default/flags/blue-02.mp3"]);
  });

  it("an aborting same-family fire does not cancel the in-flight family-mate", () => {
    engine.defineVar("missing", () => null);
    engine.defineScenario({
      id: "test.family-a",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      family: "f",
      sequence: ["voice/{voice}/flags/blue-01.mp3"],
    });
    engine.defineScenario({
      id: "test.family-b",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      family: "f",
      sequence: ["{{missing}}", "voice/{voice}/flags/blue-02.mp3"],
    });

    engine.fire("test.family-a");
    // A's clip is in flight — do not complete it yet.
    engine.fire("test.family-b");

    // B aborted BEFORE preemption: A was not stopped and finishes normally.
    expect(audio._stopped).toEqual([]);
    flushVoiceAndSfx(audio);
    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
  });

  it("an aborting higher-weight interrupt fire does not cut the in-flight fire", () => {
    engine.defineVar("missing", () => null);
    engine.defineScenario({
      id: "test.normal",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["voice/{voice}/flags/blue-01.mp3"],
    });
    engine.defineScenario({
      id: "test.critical",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CRITICAL,
      interrupt: true,
      sequence: ["{{missing}}"],
    });

    engine.fire("test.normal");
    engine.fire("test.critical");

    expect(audio._stopped).toEqual([]);
    flushVoiceAndSfx(audio);
    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
  });

  it("substitutes {voice} in connector picks and aborts when the clip is missing for the active voice", () => {
    engine.definePool("connector", ["voice/{voice}/flags/blue-01.mp3"]);
    engine.defineScenario({
      id: "test.connector",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [{ connector: true }, "/sfx/IRD-tick-close.mp3"],
    });

    engine.fire("test.connector");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
    expect(audio._played).toHaveLength(2);

    activeVoice = "titan";
    engine.fire("test.connector");
    flushVoiceAndSfx(audio);

    // The whole second fire aborted — no new plays.
    expect(audio._played).toHaveLength(2);
  });

  it("an aborted fire does not stamp the cooldown", () => {
    let value: string | null = null;
    engine.defineVar("mutable", () => value);
    engine.defineScenario({
      id: "test.cooldown",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      cooldown: 60_000,
      sequence: ["{{mutable}}"],
    });

    engine.fire("test.cooldown");
    flushVoiceAndSfx(audio);
    expect(audio._played).toEqual([]);

    value = "voice/{voice}/flags/blue-01.mp3";
    engine.fire("test.cooldown");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
  });

  it("a deferred queueable fire re-checks the abort at idle-replay", () => {
    let value: string | null = "voice/{voice}/flags/blue-02.mp3";
    engine.defineVar("mutable", () => value);
    engine.defineScenario({
      id: "test.busy",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["voice/{voice}/flags/blue-01.mp3"],
    });
    engine.defineScenario({
      id: "test.deferred",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      queueable: true,
      sequence: ["{{mutable}}"],
    });

    engine.fire("test.busy");
    engine.fire("test.deferred"); // equal weight, bus busy → deferred

    value = null; // the deferred fire's clip vanishes while it waits
    flushVoiceAndSfx(audio);

    // The replay aborted — only the first fire's clip ever played.
    expect(voicePaths()).toEqual(["voice/default/flags/blue-01.mp3"]);
  });
});

// ─── Variables ──────────────────────────────────────────────────────────────

describe("variables", () => {
  it("calls the resolver each time the variable is referenced", () => {
    const resolver = vi.fn(() => "pit-crew/names/alice.mp3");
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
      path: "pit-crew/names/alice.mp3",
      loop: false,
    });
  });

  it("aborts the whole callout when a required variable resolves to null (issue #835)", () => {
    engine.defineVar("name", () => null);
    engine.defineScenario({
      id: "test.var-null",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["{{name}}", "pit-crew/greeting/a.mp3"],
    });

    engine.fire("test.var-null");

    expect(audio._played).toEqual([]);
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
          then: ["pit-crew/reminder/autofuel.mp3"],
          else: ["pit-crew/reminder/fuel.mp3"],
        },
      ],
    });

    engine.fire("test.if-then");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-crew/reminder/autofuel.mp3"]);
  });

  it("selects the `else` branch when the predicate is false", () => {
    engine.defineScenario({
      id: "test.if-else",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        {
          if: () => false,
          then: ["pit-crew/reminder/autofuel.mp3"],
          else: ["pit-crew/reminder/fuel.mp3"],
        },
      ],
    });

    engine.fire("test.if-else");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-crew/reminder/fuel.mp3"]);
  });

  it("skips the branch entirely when false and no else is provided", () => {
    engine.defineScenario({
      id: "test.if-no-else",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [
        "pit-crew/reminder/fuel.mp3",
        { if: () => false, then: ["pit-crew/reminder/autofuel.mp3"] },
      ],
    });

    engine.fire("test.if-no-else");

    expect(audio._played.map((p) => p.path)).toEqual(["pit-crew/reminder/fuel.mp3"]);
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
      base: "pit-crew",
      sequence: ["@test.radio-open", "greeting/a.mp3"],
    });

    engine.fire("test.welcome");
    flushVoiceAndSfx(audio);

    expect(audio._played).toEqual([
      { channel: AudioChannel.SFX, path: "sfx/IRD-tick-open.mp3", loop: false },
      { channel: AudioChannel.Ambient, path: "sfx/IRD-ambient-pit.mp3", loop: true },
      { channel: AudioChannel.Voice, path: "pit-crew/greeting/a.mp3", loop: false },
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
      sequence: ["pit-crew/greeting/a.mp3"],
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

// ─── Scheduling: weights / interrupt / queueable / focus (issue #652) ────────

describe("scheduling (weights)", () => {
  it("drops an equal-weight non-queueable fire while the bus is busy", () => {
    engine.defineScenario({
      id: "test.a",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.b",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/greeting/b.mp3"],
    });

    engine.fire("test.a"); // starts playing
    engine.fire("test.b"); // dropped — equal weight, not queueable

    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual(["pit-crew/greeting/a.mp3"]);
  });

  it("a higher-weight fire with interrupt cuts the running lower-weight scenario", () => {
    engine.defineScenario({
      id: "test.normal",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.critical",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CRITICAL,
      interrupt: true,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.normal"); // first clip starts
    engine.fire("test.critical"); // interrupt cuts before the first clip ends
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/reminder/fuel.mp3"]);
    expect(audio._stopped).toContain(AudioChannel.Voice);
  });

  it("a higher-weight fire WITHOUT interrupt waits for the current line, then plays", () => {
    engine.defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.normal",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.chatter"); // first clip starts
    engine.fire("test.normal"); // higher weight, no interrupt — waits for the bus
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    // The chatter line finishes in full (a, b), THEN the normal fire plays.
    // Nothing is cut, and the chatter is not replayed.
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3", "pit-crew/reminder/fuel.mp3"]);
    expect(audio._stopped).not.toContain(AudioChannel.Voice);
  });

  it("preempts a same-family playing scenario regardless of weight", () => {
    engine.defineScenario({
      id: "test.tire.fronts",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      family: "tire-service",
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.tire.rears",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      family: "tire-service",
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.tire.fronts"); // first clip starts
    engine.fire("test.tire.rears"); // same family — replaces even at equal weight
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/reminder/fuel.mp3"]);
    expect(audio._stopped).toContain(AudioChannel.Voice);
  });

  it("does NOT preempt a different-family equal-weight playing scenario", () => {
    engine.defineScenario({
      id: "test.tire.fronts",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      family: "tire-service",
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.fuel.on",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      family: "pit-service.fuel", // different family
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.tire.fronts");
    engine.fire("test.fuel.on"); // dropped — different family, equal weight, not queueable
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"]);
  });

  it("defers a lower-weight queueable fire while busy and replays it when the bus goes idle", () => {
    engine.defineScenario({
      id: "test.safety",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.SAFETY,
      sequence: ["pit-crew/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.safety"); // starts
    engine.fire("test.chatter"); // deferred (lower weight, queueable)

    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/reminder/fuel.mp3"]);
  });

  // ── Engine semantics from #646: a TRANSIENT non-queueable fire drops when
  //    busy, and a higher-weight interrupt fire cancels a running lower-weight
  //    one. (#758 reversed the CATALOG pairing — the count-in now outranks the
  //    readback — but these weight-model rules are unchanged; the synthetic
  //    ids below just keep the original names.) ──

  it("drops a transient fire when the bus is busy (never defers) — issue #646", () => {
    engine.defineScenario({
      id: "test.readback",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.countin",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.TRANSIENT,
      queueable: false,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.readback"); // entry readback playing
    engine.fire("test.countin"); // count-in mark — must DROP, not cut, not defer
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"]);
    expect(audio._stopped).not.toContain(AudioChannel.Voice);
  });

  it("a higher-weight interrupt readback cancels a running transient count-in — issue #646", () => {
    engine.defineScenario({
      id: "test.countin",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.TRANSIENT,
      queueable: false,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.readback",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      interrupt: true,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.countin"); // count-in playing
    engine.fire("test.readback"); // outranks + interrupt — cuts the count-in
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    // count-in's first clip, then the readback cuts in; the count-in is NOT
    // replayed (not queueable).
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/reminder/fuel.mp3"]);
    expect(audio._stopped).toContain(AudioChannel.Voice);
  });

  // ── Exclusive-focus weight floor ──

  it("blocks a non-owner fire below the focus floor", () => {
    engine.acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY);
    engine.defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL, // below the SAFETY floor
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    engine.fire("test.chatter");
    flushVoiceAndSfx(audio);

    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice)).toEqual([]);
  });

  it("lets a fire AT the focus floor break through (a SAFETY floor admits SAFETY flags)", () => {
    // The floor is the minimum admitted weight: a floor set to the SAFETY band
    // must let SAFETY-band flag callouts through, not block them (issue #651).
    engine.acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY);
    engine.defineScenario({
      id: "test.flag",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.SAFETY, // exactly at the floor
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    engine.fire("test.flag");
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/reminder/fuel.mp3"]);
  });

  it("lets the focus owner's own fires bypass the floor", () => {
    engine.acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY);
    engine.defineScenario({
      id: "test.spotter-call",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER, // well below the floor, but owner bypasses
      focusOwner: "spotter",
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    engine.fire("test.spotter-call");
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3"]);
  });

  it("replays a queueable fire that was deferred below the floor once focus is released", () => {
    engine.acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY);
    engine.defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL, // below floor
      queueable: true,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    engine.fire("test.chatter"); // blocked by the floor, but queued
    flushVoiceAndSfx(audio);
    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice)).toEqual([]);

    engine.releaseFocus(AudioBus.Voice, "spotter"); // drains the pending fire
    flushVoiceAndSfx(audio);

    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3"]);
  });

  it("tracks active fires per bus — one bus's cancellation doesn't touch another", () => {
    // Two scenarios on different buses. Starting the second one must not
    // cancel the first; both must be able to advance independently.
    engine.defineScenario({
      id: "test.voice-bus",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });
    engine.defineScenario({
      id: "test.alerts-bus",
      channel: AudioChannel.Radar,
      bus: AudioBus.Alerts,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    engine.fire("test.voice-bus"); // starts on Voice bus
    engine.fire("test.alerts-bus"); // starts on Alerts bus — must NOT overwrite voice

    // Alerts-bus clip plays on the Radar channel (resolved by the
    // scenario's declared channel); finish it.
    audio._triggerChannelEnd(AudioChannel.Radar);
    // Voice bus's first clip finishes — its second clip should still follow.
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.Voice);

    const voicePaths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voicePaths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"]);
  });

  it("preserves the event context when a deferred queueable fire is replayed", () => {
    const seenOnReplay: unknown[] = [];

    engine.defineScenario({
      id: "test.high2",
      when: { event: "pitLane.approaching" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.SAFETY,
      sequence: ["pit-crew/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.low-with-data",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: [
        {
          if: (ctx) => {
            seenOnReplay.push(ctx.data);

            return (ctx.data as { should: boolean })?.should === true;
          },
          then: ["pit-crew/reminder/fuel.mp3"],
          else: ["pit-crew/reminder/tires.mp3"],
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

    // The deferred fire must replay with the original event data (should=true),
    // taking the `then` branch — not collapse to the `else` branch that `null` data
    // would produce.
    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/reminder/fuel.mp3"]);
    expect(seenOnReplay.at(-1)).toEqual({ should: true });
  });

  it("replays a deferred queueable fire WITHOUT re-running its where: (no double side effect)", () => {
    // Guards the #574/#555 regression: the position/race-status readouts claim
    // a shared cooldown as the LAST gate in their where:, which only succeeds
    // once. Re-running where: on the deferred replay would fail that claim and
    // silently drop the callout. The engine must replay without re-checking.
    let whereCalls = 0;

    engine.defineScenario({
      id: "test.blocker",
      when: { event: "pitLane.approaching" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.SAFETY,
      sequence: ["pit-crew/greeting/a.mp3"],
    });
    engine.defineScenario({
      id: "test.claim",
      when: {
        event: "pitLane.entered",
        where: () => {
          whereCalls++;

          return whereCalls === 1; // claim-style: only the first call commits
        },
      },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });

    bus.publishEvent("pitLane.approaching", {}); // blocker plays
    bus.publishEvent("pitLane.entered", {}); // where: #1 → true → deferred (queued)

    flushVoiceAndSfx(audio);

    // The deferred fire replays on idle and speaks; where: ran exactly once.
    const paths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(paths).toEqual(["pit-crew/greeting/a.mp3", "pit-crew/reminder/fuel.mp3"]);
    expect(whereCalls).toBe(1);
  });
});

// ─── Resume + pending hold (issue #758) ─────────────────────────────────────

describe("resume from interruption (issue #758)", () => {
  /** Line under test: queueable so an interrupt stashes it for idle-replay. */
  function defineLine(extra: Partial<{ resumable: boolean; cooldown: number }> = {}): void {
    engine.defineScenario({
      id: "test.line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3", "pit-crew/reminder/tires.mp3"],
      ...extra,
    });
  }

  /** Higher-weight interrupter that cuts the line mid-clip. */
  function defineCutter(): void {
    engine.defineScenario({
      id: "test.cutter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      interrupt: true,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });
  }

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  it("resumes a resumable fire from the interrupted clip, not from the top", () => {
    defineLine({ resumable: true });
    defineCutter();

    engine.fire("test.line"); // a in flight
    audio._triggerChannelEnd(AudioChannel.Voice); // a done → b in flight
    engine.fire("test.cutter"); // cuts b
    flushVoiceAndSfx(audio);

    // The resume replays the cut clip (b) then continues — a is NOT replayed.
    expect(voicePaths()).toEqual([
      "pit-crew/greeting/a.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/fuel.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/tires.mp3",
    ]);
  });

  it("replays a non-resumable queueable fire from the top after an interrupt cut", () => {
    defineLine(); // no resumable
    defineCutter();

    engine.fire("test.line");
    audio._triggerChannelEnd(AudioChannel.Voice);
    engine.fire("test.cutter");
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual([
      "pit-crew/greeting/a.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/fuel.mp3",
      "pit-crew/greeting/a.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/tires.mp3",
    ]);
  });

  it("re-opens the radio frame with the open tick when the cut portion had opened one", () => {
    engine.defineScenario({
      id: "test.line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      resumable: true,
      sequence: [
        "/sfx/IRD-tick-open.mp3",
        "pit-crew/greeting/a.mp3",
        "pit-crew/greeting/b.mp3",
        "/sfx/IRD-tick-close.mp3",
      ],
    });
    defineCutter();

    engine.fire("test.line"); // tick-open (SFX) in flight
    audio._triggerChannelEnd(AudioChannel.SFX); // a (Voice) in flight
    engine.fire("test.cutter"); // cuts a
    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual([
      "sfx/IRD-tick-open.mp3",
      "pit-crew/greeting/a.mp3",
      "pit-crew/reminder/fuel.mp3",
      // Resume: the frame was opened before the cut, so it re-keys with the
      // open tick, then continues from the interrupted clip.
      "sfx/IRD-tick-open.mp3",
      "pit-crew/greeting/a.mp3",
      "pit-crew/greeting/b.mp3",
      "sfx/IRD-tick-close.mp3",
    ]);
  });

  it("falls back to a full fresh replay when the expansion changed while stashed", () => {
    // Freshness guard (issue #481): the readback re-reads its snapshot at
    // replay. When the re-expansion differs from the stashed ops, resuming
    // mid-sentence would speak a stale tail — replay in full instead.
    let variant = "a";
    engine.defineScenario({
      id: "test.line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      resumable: true,
      sequence: [
        {
          if: () => variant === "a",
          then: ["pit-crew/greeting/a.mp3"],
          else: ["pit-crew/greeting/b.mp3"],
        },
        "pit-crew/reminder/tires.mp3",
      ],
    });
    defineCutter();

    engine.fire("test.line"); // a in flight
    audio._triggerChannelEnd(AudioChannel.Voice); // tires in flight
    engine.fire("test.cutter"); // cuts tires
    variant = "b"; // state moves on while stashed
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual([
      "pit-crew/greeting/a.mp3",
      "pit-crew/reminder/tires.mp3",
      "pit-crew/reminder/fuel.mp3",
      // Full fresh replay — new branch, from the top.
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/tires.mp3",
    ]);
  });

  it("does not re-check the cooldown when resuming (a resume is a continuation)", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    defineLine({ resumable: true, cooldown: 60000 });
    defineCutter();

    engine.fire("test.line");
    audio._triggerChannelEnd(AudioChannel.Voice); // b in flight
    engine.fire("test.cutter"); // cuts b
    flushVoiceAndSfx(audio);

    // Still within the cooldown window, but the resume must play anyway.
    expect(voicePaths()).toEqual([
      "pit-crew/greeting/a.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/fuel.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/tires.mp3",
    ]);

    now.mockRestore();
  });

  it("a resumed fire cut again stashes its position in the original expansion", () => {
    defineLine({ resumable: true });
    defineCutter();

    engine.fire("test.line"); // a in flight
    audio._triggerChannelEnd(AudioChannel.Voice); // b in flight
    engine.fire("test.cutter"); // first cut at b
    audio._triggerChannelEnd(AudioChannel.Voice); // cutter done → resume: b in flight
    engine.fire("test.cutter"); // second cut, again at b
    flushVoiceAndSfx(audio);

    expect(voicePaths()).toEqual([
      "pit-crew/greeting/a.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/fuel.mp3",
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/fuel.mp3",
      // Second resume still continues from b — not from the top.
      "pit-crew/greeting/b.mp3",
      "pit-crew/reminder/tires.mp3",
    ]);
  });
});

describe("pending hold (issue #758)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function defineHolder(): void {
    engine.defineScenario({
      id: "test.holder",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      pendingHoldMs: 2000,
      sequence: ["pit-crew/reminder/fuel.mp3"],
    });
  }

  function defineLine(): void {
    engine.defineScenario({
      id: "test.line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      queueable: true,
      sequence: ["pit-crew/greeting/a.mp3"],
    });
  }

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  it("holds the pending drain for pendingHoldMs after the holding fire finishes", () => {
    defineHolder();
    defineLine();

    engine.fire("test.holder"); // fuel in flight
    engine.fire("test.line"); // deferred behind it
    audio._triggerChannelEnd(AudioChannel.Voice); // holder finishes → hold armed

    expect(voicePaths()).toEqual(["pit-crew/reminder/fuel.mp3"]);

    vi.advanceTimersByTime(1999);
    expect(voicePaths()).toEqual(["pit-crew/reminder/fuel.mp3"]);

    vi.advanceTimersByTime(1);
    expect(voicePaths()).toEqual(["pit-crew/reminder/fuel.mp3", "pit-crew/greeting/a.mp3"]);
  });

  it("a new fire within the hold cancels it and re-arms at that fire's finish", () => {
    defineHolder();
    defineLine();

    engine.fire("test.holder");
    engine.fire("test.line"); // pending
    audio._triggerChannelEnd(AudioChannel.Voice); // hold armed

    vi.advanceTimersByTime(1000);
    engine.fire("test.holder"); // bus idle → plays immediately, hold cancelled
    audio._triggerChannelEnd(AudioChannel.Voice); // hold re-armed from now

    vi.advanceTimersByTime(1999);
    expect(voicePaths()).toEqual(["pit-crew/reminder/fuel.mp3", "pit-crew/reminder/fuel.mp3"]);

    vi.advanceTimersByTime(1);
    expect(voicePaths()).toEqual([
      "pit-crew/reminder/fuel.mp3",
      "pit-crew/reminder/fuel.mp3",
      "pit-crew/greeting/a.mp3",
    ]);
  });

  it("finishes immediately (no hold) when nothing is pending", () => {
    defineHolder();

    engine.fire("test.holder");
    audio._triggerChannelEnd(AudioChannel.Voice);

    // Bus idles right away — a fresh fire plays without waiting for the hold.
    engine.fire("test.holder");
    expect(voicePaths()).toEqual(["pit-crew/reminder/fuel.mp3", "pit-crew/reminder/fuel.mp3"]);
  });

  it("stopAll clears an armed hold along with the pending fire", () => {
    defineHolder();
    defineLine();

    engine.fire("test.holder");
    engine.fire("test.line"); // pending
    audio._triggerChannelEnd(AudioChannel.Voice); // hold armed

    engine.stopAll();
    vi.advanceTimersByTime(5000);

    expect(voicePaths()).toEqual(["pit-crew/reminder/fuel.mp3"]);
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
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    bus.publishEvent("pitLane.approaching", {});
    flushVoiceAndSfx(audio);

    expect(audio._played.map((p) => p.path)).toEqual(["pit-crew/greeting/a.mp3"]);
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
      sequence: ["pit-crew/reminder/fuel.mp3"],
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

    expect(audio._played.map((p) => p.path)).toEqual(["pit-crew/reminder/fuel.mp3"]);
  });

  it("setEnabled(false) cancels in-flight and ignores new fires", () => {
    engine.defineScenario({
      id: "test.toggle",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/greeting/a.mp3", "pit-crew/greeting/b.mp3"],
    });

    bus.publishEvent("pitLane.entered", {});
    // First clip in flight. Disable while playing.
    engine.setEnabled("test.toggle", false);
    // Running was cancelled. Publishing again should be a no-op.
    bus.publishEvent("pitLane.entered", {});
    flushVoiceAndSfx(audio);

    // Only the first clip started; no further plays on Voice.
    const voicePaths = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voicePaths).toEqual(["pit-crew/greeting/a.mp3"]);
  });
});

// ─── triggerDelay (issue #568) ──────────────────────────────────────────────

describe("triggerDelay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defers the fire by triggerDelay ms, then plays", () => {
    engine.defineScenario({
      id: "test.delayed",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      triggerDelay: 1000,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    bus.publishEvent("pitLane.entered", {});

    // Nothing yet — still inside the delay window.
    vi.advanceTimersByTime(900);
    flushVoiceAndSfx(audio);
    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice)).toEqual([]);

    // Past the delay — the scenario fires.
    vi.advanceTimersByTime(200);
    flushVoiceAndSfx(audio);
    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path)).toEqual([
      "pit-crew/greeting/a.mp3",
    ]);
  });

  it("re-evaluates where: at the deferred fire time", () => {
    let allow = false;
    engine.defineScenario({
      id: "test.delayed-where",
      when: { event: "pitLane.entered", where: () => allow },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      triggerDelay: 1000,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    // where: is false at event arrival but flips true during the delay window.
    bus.publishEvent("pitLane.entered", {});
    allow = true;
    vi.advanceTimersByTime(1000);
    flushVoiceAndSfx(audio);

    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path)).toEqual([
      "pit-crew/greeting/a.mp3",
    ]);
  });

  it("clears a pending delayed trigger on disable so a re-enable can't replay the stale event", () => {
    engine.defineScenario({
      id: "test.delayed-toggle",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      triggerDelay: 1000,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    // Event arrives → timer scheduled. Disable, then re-enable, before expiry.
    bus.publishEvent("pitLane.entered", {});
    engine.setEnabled("test.delayed-toggle", false);
    engine.setEnabled("test.delayed-toggle", true);

    // Timer would have expired here — but it was cleared on disable, so the
    // stale pre-disable event must NOT fire.
    vi.advanceTimersByTime(1000);
    flushVoiceAndSfx(audio);

    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice)).toEqual([]);
  });

  it("a fresh event after re-enable still fires normally", () => {
    engine.defineScenario({
      id: "test.delayed-rearm",
      when: { event: "pitLane.entered" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      triggerDelay: 1000,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    bus.publishEvent("pitLane.entered", {});
    engine.setEnabled("test.delayed-rearm", false);
    engine.setEnabled("test.delayed-rearm", true);

    // New event after re-enable schedules a fresh timer.
    bus.publishEvent("pitLane.entered", {});
    vi.advanceTimersByTime(1000);
    flushVoiceAndSfx(audio);

    expect(audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path)).toEqual([
      "pit-crew/greeting/a.mp3",
    ]);
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
        "pit-crew/greeting/a.mp3",
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

// ─── stopAll (Race Engineer toggle-off cleanup, issue #587) ─────────────────

describe("stopAll", () => {
  it("stops a mid-flight callout's ambient bed and frees the bus", () => {
    engine.defineScenario({
      id: "test.callout",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-crew",
      sequence: [{ ambient: "start" }, "greeting/a.mp3", "greeting/b.mp3", { ambient: "stop" }],
    });
    engine.defineScenario({
      id: "test.next",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-crew",
      sequence: ["names/alice.mp3"],
    });

    // Fire but DON'T flush — the callout is mid-flight: the ambient bed is
    // looping and the engine is waiting on the first voice clip's completion,
    // so the trailing `ambient: "stop"` has not run yet.
    engine.fire("test.callout");

    expect(audio._played).toContainEqual({
      channel: AudioChannel.Ambient,
      path: "sfx/IRD-ambient-pit.mp3",
      loop: true,
    });
    expect(audio._stopped).not.toContain(AudioChannel.Ambient);

    engine.stopAll();

    // The ambient channel is explicitly stopped (it's in the fire's
    // `usedChannels`), so the orphaned loop can't linger.
    expect(audio._stopped).toContain(AudioChannel.Ambient);

    // The bus is no longer wedged: a fresh callout plays instead of being
    // dropped as "bus busy" (the pre-fix failure mode).
    engine.fire("test.next");
    flushVoiceAndSfx(audio);

    const voicePlays = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    expect(voicePlays).toContain("pit-crew/names/alice.mp3");
  });

  it("is a no-op when nothing is playing", () => {
    expect(() => engine.stopAll()).not.toThrow();
    expect(audio._stopped).toEqual([]);
  });
});
