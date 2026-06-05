import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, RadarState, SimEventName, SimEventOf } from "@iracedeck/event-bus";
// Re-import the (mocked) enum so the test uses identical values.
import { TrackDirection } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import {
  _resetSpotterEngine,
  isSpotterEnabled,
  registerSpotterEngine,
  setSpotterEnabled,
  SPOTTER_CALL_SCENARIO_ID,
  SPOTTER_FOCUS_OWNER,
  SPOTTER_STILL_THERE_INTERVAL_MS,
  type SpotterDeps,
} from "./spotter-engine.js";

// ─── sim-events-iracing mock ───────────────────────────────────────────────
//
// The engine reads telemetry (pit-road), session type (Lone Qualify) and the
// track rotation direction from `@iracedeck/sim-events-iracing`. Mock those
// getters but keep a `TrackDirection` enum whose values match the real one so
// the engine's `termFor` mapping is exercised against the genuine string keys.

const sim = vi.hoisted(() => ({
  getLatestTelemetry: vi.fn<() => { OnPitRoad?: boolean } | null>(),
  getSessionType: vi.fn<() => string>(),
}));

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getLatestTelemetry: sim.getLatestTelemetry,
  getSessionType: sim.getSessionType,
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
}));

// ─── Fake audio service (records plays, drives channel-complete manually) ───

type FakeAudio = IAudioService & {
  _played: { channel: AudioChannel; path: string; loop: boolean }[];
  _stopped: AudioChannel[];
  _triggerChannelEnd: (channel: AudioChannel) => void;
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
  };
  const played: { channel: AudioChannel; path: string; loop: boolean }[] = [];
  const stopped: AudioChannel[] = [];

  return {
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
    _played: played,
    _stopped: stopped,
    _triggerChannelEnd: (channel: AudioChannel) => {
      const cb = callbacks[channel];
      callbacks[channel] = null;
      cb?.();
    },
  } as unknown as FakeAudio;
}

const manifest = { clips: [], ambientLoop: "", ticks: { open: "", close: "" } } as never;

// ─── Fake event bus ─────────────────────────────────────────────────────────

function createMockBus(): IEventBus & { publishRadar: (to: RadarState, from?: RadarState) => void } {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: (<T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => {
        handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    }) as IEventBus["subscribe"],
    unsubscribe: vi.fn(),
    publish: vi.fn(),
    publishRadar(to, from = "clear") {
      const set = handlers.get("radar.changed");

      if (!set) return;

      for (const h of Array.from(set)) {
        h({ event: "radar.changed", data: { from, to } } as SimEventOf<SimEventName>);
      }
    },
  } as IEventBus & { publishRadar: (to: RadarState, from?: RadarState) => void };
}

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

const VOICE = AudioChannel.Voice;
const BASE = "voice/luca/spotter/";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let deps: SpotterDeps;
let trackDirection: TrackDirection;

/** Build deps with permissive defaults; individual tests override fields. */
function makeDeps(overrides: Partial<SpotterDeps> = {}): SpotterDeps {
  return {
    getMasterEnabled: () => true,
    getCarsEnabled: () => true,
    getStillThereEnabled: () => true,
    getTrackDirection: () => trackDirection,
    logger: mockLogger as never,
    ...overrides,
  };
}

/** Paths played on the Voice channel since the test started (in order). */
function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === VOICE).map((p) => p.path);
}

/** The most recent Voice path played, or undefined. */
function lastVoicePath(): string | undefined {
  return voicePaths().at(-1);
}

beforeEach(() => {
  vi.useFakeTimers();
  bus = createMockBus();
  audio = createFakeAudio();
  trackDirection = TrackDirection.Neutral;
  // Real engine + fake audio so the var → resolved-clip path is asserted
  // end-to-end. `getActiveVoice` returns "luca" so `{voice}` substitution is
  // exercised on the played path.
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");
  deps = makeDeps();
  sim.getLatestTelemetry.mockReset();
  sim.getLatestTelemetry.mockReturnValue({ OnPitRoad: false });
  sim.getSessionType.mockReset();
  sim.getSessionType.mockReturnValue("Race");
});

afterEach(() => {
  _resetSpotterEngine();
  _resetAudioScenarios();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registerSpotterEngine", () => {
  it("defines the spotter-call scenario and subscribes to radar.changed once", () => {
    const subscribeSpy = vi.spyOn(bus, "subscribe");
    registerSpotterEngine(bus, deps);
    registerSpotterEngine(bus, deps);

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith("radar.changed", expect.any(Function));
  });

  it("throws when re-registered with a different bus instance", () => {
    registerSpotterEngine(bus, deps);
    const otherBus = createMockBus();

    expect(() => registerSpotterEngine(otherBus, deps)).toThrow(/different event bus/);
  });
});

// ─── Road arrivals (dir Neutral) ─────────────────────────────────────────────

describe("road arrivals (TrackDirection.Neutral)", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
  });

  it("clear → left plays car-left", () => {
    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);
  });

  it("clear → right plays car-right", () => {
    bus.publishRadar("right");
    expect(lastVoicePath()).toBe(`${BASE}car-right.mp3`);
  });

  it("clear → two-left plays two-cars-left", () => {
    bus.publishRadar("two-left");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-left.mp3`);
  });

  it("clear → two-right plays two-cars-right", () => {
    bus.publishRadar("two-right");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-right.mp3`);
  });

  it("clear → both plays three-wide", () => {
    bus.publishRadar("both");
    expect(lastVoicePath()).toBe(`${BASE}three-wide.mp3`);
  });
});

// ─── Escalation / de-escalation ──────────────────────────────────────────────

describe("escalation and de-escalation", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
  });

  it("left → two-left escalates to two-cars-left", () => {
    bus.publishRadar("left");
    bus.publishRadar("two-left", "left");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-left.mp3`);
  });

  it("two-left → left de-escalates to one-car-left", () => {
    bus.publishRadar("two-left");
    bus.publishRadar("left", "two-left");
    expect(lastVoicePath()).toBe(`${BASE}one-car-left.mp3`);
  });

  it("right → two-right escalates to two-cars-right", () => {
    bus.publishRadar("right");
    bus.publishRadar("two-right", "right");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-right.mp3`);
  });

  it("two-right → right de-escalates to one-car-right", () => {
    bus.publishRadar("two-right");
    bus.publishRadar("right", "two-right");
    expect(lastVoicePath()).toBe(`${BASE}one-car-right.mp3`);
  });
});

// ─── Combined (de-escalation / swap) ─────────────────────────────────────────

describe("combined clips (de-escalation / swap)", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
  });

  it("both → left plays clear-right-car-left", () => {
    bus.publishRadar("both");
    bus.publishRadar("left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-right-car-left.mp3`);
  });

  it("both → right plays clear-left-car-right", () => {
    bus.publishRadar("both");
    bus.publishRadar("right", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-left-car-right.mp3`);
  });

  it("right → left (swap) plays clear-right-car-left", () => {
    bus.publishRadar("right");
    bus.publishRadar("left", "right");
    expect(lastVoicePath()).toBe(`${BASE}clear-right-car-left.mp3`);
  });

  it("left → right (swap) plays clear-left-car-right", () => {
    bus.publishRadar("left");
    bus.publishRadar("right", "left");
    expect(lastVoicePath()).toBe(`${BASE}clear-left-car-right.mp3`);
  });

  it("both → two-left plays clear-right-two-cars-left", () => {
    bus.publishRadar("both");
    bus.publishRadar("two-left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-right-two-cars-left.mp3`);
  });

  it("two-right → two-left plays clear-right-two-cars-left", () => {
    bus.publishRadar("two-right");
    bus.publishRadar("two-left", "two-right");
    expect(lastVoicePath()).toBe(`${BASE}clear-right-two-cars-left.mp3`);
  });
});

// ─── Final clear ─────────────────────────────────────────────────────────────

describe("final clear", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
  });

  it("non-clear → clear plays a clip from the clear pool and releases focus", () => {
    const releaseSpy = vi.spyOn(getScenarioEngine(), "releaseFocus");
    bus.publishRadar("left");

    bus.publishRadar("clear", "left");

    expect(lastVoicePath()).toMatch(/spotter\/clear(-clear)?\.mp3$/);
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
  });

  it("the clear pool does not repeat the same clip twice in a row", () => {
    // Force Math.random to a constant so a naive picker would repeat; the
    // engine's no-repeat must advance the index on the second pick.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    bus.publishRadar("left");
    bus.publishRadar("clear", "left");
    const first = lastVoicePath();

    bus.publishRadar("right");
    bus.publishRadar("clear", "right");
    const second = lastVoicePath();

    expect(first).not.toBe(second);
    randomSpy.mockRestore();
  });
});

// ─── Oval mapping ────────────────────────────────────────────────────────────

describe("oval mapping (inside / outside)", () => {
  it("left-going oval: clear → left is car-inside, clear → right is car-outside", () => {
    trackDirection = TrackDirection.Left;
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-inside.mp3`);

    bus.publishRadar("clear", "left");
    bus.publishRadar("right");
    expect(lastVoicePath()).toBe(`${BASE}car-outside.mp3`);
  });

  it("left-going oval: both → left plays clear-outside-car-inside", () => {
    trackDirection = TrackDirection.Left;
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    bus.publishRadar("both");
    bus.publishRadar("left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-outside-car-inside.mp3`);
  });

  it("right-going oval: clear → left is car-outside", () => {
    trackDirection = TrackDirection.Right;
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-outside.mp3`);
  });

  it("right-going oval: both → left plays clear-inside-car-outside", () => {
    trackDirection = TrackDirection.Right;
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    bus.publishRadar("both");
    bus.publishRadar("left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-inside-car-outside.mp3`);
  });
});

// ─── Focus gate ──────────────────────────────────────────────────────────────

describe("focus gate", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
  });

  it("acquires focus once on the first non-clear transition and not again while held", () => {
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");

    bus.publishRadar("left");
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(acquireSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER, expect.any(Number));

    bus.publishRadar("two-left", "left");
    bus.publishRadar("both", "two-left");
    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it("releases focus on the transition to clear", () => {
    const releaseSpy = vi.spyOn(getScenarioEngine(), "releaseFocus");
    bus.publishRadar("left");

    bus.publishRadar("clear", "left");
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
  });

  it("re-acquires focus after a clear when a car returns", () => {
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");
    bus.publishRadar("left");
    bus.publishRadar("clear", "left");

    bus.publishRadar("right");
    expect(acquireSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Sustained loop (still-there) ────────────────────────────────────────────

describe("sustained still-there loop", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
  });

  it("fires a still-there clip on each interval while a car is alongside", () => {
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS);
    expect(voicePaths().length).toBe(afterArrival + 1);
    expect(lastVoicePath()).toMatch(/spotter\/(still-there|hold-your-line)\.mp3$/);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS);
    expect(voicePaths().length).toBe(afterArrival + 2);
  });

  it("does not repeat the same still-there variant back-to-back", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    bus.publishRadar("left");

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS);
    const first = lastVoicePath();
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS);
    const second = lastVoicePath();

    expect(first).not.toBe(second);
    randomSpy.mockRestore();
  });

  it("resets the loop timer on a new transition", () => {
    bus.publishRadar("left");
    // Advance almost to the interval, then transition — the pending tick must
    // be cancelled and rescheduled, so no still-there fires at the old time.
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS - 100);
    bus.publishRadar("two-left", "left");
    const afterTransition = voicePaths().length;

    vi.advanceTimersByTime(100);
    expect(voicePaths().length).toBe(afterTransition);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS - 100);
    expect(voicePaths().length).toBe(afterTransition + 1);
  });

  it("stops the loop on clear", () => {
    bus.publishRadar("left");
    bus.publishRadar("clear", "left");
    const afterClear = voicePaths().length;

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS * 3);
    expect(voicePaths().length).toBe(afterClear);
  });

  it("stops the loop when the master gate flips off", () => {
    let master = true;
    deps = makeDeps({ getMasterEnabled: () => master });
    _resetSpotterEngine();
    _resetAudioScenarios();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    master = false;
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });
});

// ─── Live opt-in gating ──────────────────────────────────────────────────────

describe("opt-in gating (live)", () => {
  it("cars off suppresses the transition clip but keeps the focus gate and loop", () => {
    let cars = false;
    deps = makeDeps({ getCarsEnabled: () => cars });
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    bus.publishRadar("left");
    // No transition clip…
    expect(voicePaths()).toEqual([]);
    // …but the focus gate is still acquired.
    expect(acquireSpy).toHaveBeenCalledTimes(1);

    // …and the still-there loop still runs (still-there opt-in is on).
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS);
    expect(voicePaths().length).toBe(1);

    // Flipping cars on mid-session takes effect on the next transition.
    cars = true;
    bus.publishRadar("two-left", "left");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-left.mp3`);
  });

  it("still-there off silences the loop while transitions still announce", () => {
    let stillThere = true;
    deps = makeDeps({ getStillThereEnabled: () => stillThere });
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    stillThere = false;
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);

    // Re-enabling mid-session resumes the loop (it stayed scheduled, silent).
    stillThere = true;
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS);
    expect(voicePaths().length).toBe(afterArrival + 1);
  });
});

// ─── Master / suppression (forceClear) ───────────────────────────────────────

describe("master + suppression (forceClear)", () => {
  it("master off forces clear: releases focus, stops loop, fires nothing", () => {
    let master = true;
    deps = makeDeps({ getMasterEnabled: () => master });
    const releaseSpy = vi.spyOn(getScenarioEngine(), "releaseFocus");
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    master = false;
    bus.publishRadar("two-left", "left");

    expect(voicePaths().length).toBe(afterArrival);
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("pit road forces clear and fires nothing", () => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    sim.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
    bus.publishRadar("both", "left");

    expect(voicePaths().length).toBe(afterArrival);
  });

  it("Lone Qualify forces clear and fires nothing", () => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    sim.getSessionType.mockReturnValue("Lone Qualify");
    bus.publishRadar("left");

    expect(voicePaths()).toEqual([]);
  });

  it("setSpotterEnabled(false) releases focus, stops the loop, and reports disabled", () => {
    const releaseSpy = vi.spyOn(getScenarioEngine(), "releaseFocus");
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    setSpotterEnabled(false);
    expect(isSpotterEnabled()).toBe(false);
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_INTERVAL_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("does nothing when the engine is not enabled", () => {
    registerSpotterEngine(bus, deps);
    bus.publishRadar("left");

    expect(voicePaths()).toEqual([]);
    expect(isSpotterEnabled()).toBe(false);
  });
});

// ─── Scenario identity ───────────────────────────────────────────────────────

describe("scenario identity", () => {
  it("fires the spotter-call scenario as the focus owner so it bypasses its own floor", () => {
    registerSpotterEngine(bus, deps);
    setSpotterEnabled(true);

    // The engine holds the SAFETY floor while a car is alongside, yet its own
    // spotter-call fires (the owner bypasses its own floor) — proving the
    // scenario carries focusOwner "spotter".
    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);

    bus.publishRadar("two-left", "left");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-left.mp3`);
  });

  it("registers the scenario under the documented id with SAFETY weight on the Voice bus", () => {
    // Spy before the first registration so the initial defineScenario is captured.
    const spy = vi.spyOn(getScenarioEngine(), "defineScenario");
    registerSpotterEngine(bus, deps);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SPOTTER_CALL_SCENARIO_ID,
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        focusOwner: SPOTTER_FOCUS_OWNER,
        family: "spotter",
        interrupt: true,
        queueable: false,
      }),
    );
  });
});

// ─── Voice substitution ──────────────────────────────────────────────────────

describe("voice substitution", () => {
  it("substitutes {voice} in the played clip path", () => {
    _resetSpotterEngine();
    _resetAudioScenarios();
    const freshBus = createMockBus();
    const freshAudio = createFakeAudio();
    initializeAudioScenarios(freshBus, freshAudio, manifest, mockLogger as never, () => "elena");
    registerSpotterEngine(freshBus, deps);
    setSpotterEnabled(true);

    freshBus.publishRadar("left");

    const played = freshAudio._played.filter((p) => p.channel === VOICE).map((p) => p.path);
    expect(played).toEqual(["voice/elena/spotter/car-left.mp3"]);
    bus = freshBus;
    audio = freshAudio;
  });
});
