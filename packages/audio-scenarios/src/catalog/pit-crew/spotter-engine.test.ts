import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, RadarState, SimEventName, SimEventOf } from "@iracedeck/event-bus";
// Re-import the (mocked) enum so the test uses identical values.
import { TrackDirection } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import {
  _resetSpotterEngine,
  registerSpotterEngine,
  SPOTTER_CALL_SCENARIO_ID,
  SPOTTER_CLEAR_BUFFER_METERS,
  SPOTTER_CLEAR_FALLBACK_MS,
  SPOTTER_CLEAR_POLL_MS,
  SPOTTER_FOCUS_OWNER,
  SPOTTER_STILL_THERE_DEFAULT_MS,
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

// The spotter's clip catalog is code-enumerated, but fire-time expansion
// checks every clip against the manifest for the active voice (issue #835) —
// so the fixture carries the full production spotter clip set per test voice.
const SPOTTER_CLIP_NAMES = [
  "car-inside",
  "car-left",
  "car-outside",
  "car-right",
  "clear-inside-car-outside",
  "clear-inside-two-cars-outside",
  "clear-left-car-right",
  "clear-left-two-cars-right",
  "clear-outside-car-inside",
  "clear-outside-two-cars-inside",
  "clear-right-car-left",
  "clear-right-two-cars-left",
  "clear",
  "hold-your-line",
  "one-car-inside",
  "one-car-left",
  "one-car-outside",
  "one-car-right",
  "still-there",
  "three-wide",
  "two-cars-inside",
  "two-cars-left",
  "two-cars-outside",
  "two-cars-right",
] as const;

const manifest = {
  clips: ["luca", "elena"].flatMap((v) => SPOTTER_CLIP_NAMES.map((name) => `voice/${v}/spotter/${name}.mp3`)),
  ambientLoop: "",
  ticks: { open: "", close: "" },
} as never;

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
/** Nearest-car gap (m) the makeDeps closure returns; null disables the clear buffer. */
let nearestGap: number | null = null;

/** Build deps with permissive defaults; individual tests override fields. */
function makeDeps(overrides: Partial<SpotterDeps> = {}): SpotterDeps {
  return {
    getMasterEnabled: () => true,
    getCarsEnabled: () => true,
    getStillThereEnabled: () => true,
    getStillThereIntervalMs: () => SPOTTER_STILL_THERE_DEFAULT_MS,
    getTrackDirection: () => trackDirection,
    getNearestCarGapMeters: () => nearestGap,
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
  nearestGap = null;
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
  });

  it("non-clear → clear plays the clear clip and releases focus", () => {
    const releaseSpy = vi.spyOn(getScenarioEngine(), "releaseFocus");
    bus.publishRadar("left");

    bus.publishRadar("clear", "left");

    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
  });
});

// ─── Oval mapping ────────────────────────────────────────────────────────────

describe("oval mapping (inside / outside)", () => {
  it("left-going oval: clear → left is car-inside, clear → right is car-outside", () => {
    trackDirection = TrackDirection.Left;
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-inside.mp3`);

    bus.publishRadar("clear", "left");
    bus.publishRadar("right");
    expect(lastVoicePath()).toBe(`${BASE}car-outside.mp3`);
  });

  it("left-going oval: both → left plays clear-outside-car-inside", () => {
    trackDirection = TrackDirection.Left;
    registerSpotterEngine(bus, deps);

    bus.publishRadar("both");
    bus.publishRadar("left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-outside-car-inside.mp3`);
  });

  it("right-going oval: clear → left is car-outside", () => {
    trackDirection = TrackDirection.Right;
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-outside.mp3`);
  });

  it("right-going oval: both → left plays clear-inside-car-outside", () => {
    trackDirection = TrackDirection.Right;
    registerSpotterEngine(bus, deps);

    bus.publishRadar("both");
    bus.publishRadar("left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-inside-car-outside.mp3`);
  });
});

// ─── Focus gate ──────────────────────────────────────────────────────────────

describe("focus gate", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
  });

  it("re-asserts the focus floor on every non-clear transition", () => {
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");

    bus.publishRadar("left");
    expect(acquireSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER, expect.any(Number));

    // Re-assert (not cache-and-skip): the interpreter's stopAll() can clear the
    // bus focus without notifying the engine, so acquireFocus must fire on each
    // non-clear transition to keep the floor alive while a car is alongside.
    bus.publishRadar("two-left", "left");
    bus.publishRadar("both", "two-left");
    expect(acquireSpy).toHaveBeenCalledTimes(3);
  });

  it("restores the focus floor after an external stopAll cleared it", () => {
    bus.publishRadar("left");
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");

    // Race Engineer master toggled off mid-alongside wipes every bus's focus
    // via stopAll(); the spotter is an independent toggle and stays on.
    getScenarioEngine().stopAll();

    bus.publishRadar("two-left", "left");
    expect(acquireSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER, expect.any(Number));
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
  });

  it("fires a still-there clip on each interval while a car is alongside", () => {
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
    expect(voicePaths().length).toBe(afterArrival + 1);
    expect(lastVoicePath()).toMatch(/spotter\/(still-there|hold-your-line)\.mp3$/);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
    expect(voicePaths().length).toBe(afterArrival + 2);
  });

  it("does not repeat the same still-there variant back-to-back", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    bus.publishRadar("left");

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
    const first = lastVoicePath();
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
    const second = lastVoicePath();

    expect(first).not.toBe(second);
    randomSpy.mockRestore();
  });

  it("resets the loop timer on a new transition", () => {
    bus.publishRadar("left");
    // Advance almost to the interval, then transition — the pending tick must
    // be cancelled and rescheduled, so no still-there fires at the old time.
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS - 100);
    bus.publishRadar("two-left", "left");
    const afterTransition = voicePaths().length;

    vi.advanceTimersByTime(100);
    expect(voicePaths().length).toBe(afterTransition);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS - 100);
    expect(voicePaths().length).toBe(afterTransition + 1);
  });

  it("stops the loop on clear", () => {
    bus.publishRadar("left");
    bus.publishRadar("clear", "left");
    const afterClear = voicePaths().length;

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterClear);
  });

  it("stops the loop when the master gate flips off", () => {
    let master = true;
    deps = makeDeps({ getMasterEnabled: () => master });
    _resetSpotterEngine();
    _resetAudioScenarios();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");
    registerSpotterEngine(bus, deps);
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    master = false;
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("stops the loop when the driver enters pit road mid-loop", () => {
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    // No fresh radar.changed (relative position unchanged) but the driver
    // peeled into the pits — the tick must re-check telemetry and suppress.
    sim.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("stops the loop when the session becomes Lone Qualify mid-loop", () => {
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    sim.getSessionType.mockReturnValue("Lone Qualify");
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("fires at the configured interval and applies a live cadence change (#651)", () => {
    let intervalMs = 6000;
    deps = makeDeps({ getStillThereIntervalMs: () => intervalMs });
    _resetSpotterEngine();
    _resetAudioScenarios();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    const base = voicePaths().length;

    // The default cadence would have fired by now; the configured 6 s has not.
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
    expect(voicePaths().length).toBe(base);

    // Fires at the configured 6 s.
    vi.advanceTimersByTime(6000 - SPOTTER_STILL_THERE_DEFAULT_MS);
    expect(voicePaths().length).toBe(base + 1);

    // Shorten to 2 s live; the new cadence applies from the next reschedule (the
    // tick already pending fires at the old 6 s, then reschedules at 2 s).
    intervalMs = 2000;
    vi.advanceTimersByTime(6000);
    expect(voicePaths().length).toBe(base + 2);
    vi.advanceTimersByTime(2000);
    expect(voicePaths().length).toBe(base + 3);
  });
});

// ─── Live opt-in gating ──────────────────────────────────────────────────────

describe("opt-in gating (live)", () => {
  it("cars off suppresses the transition clip but keeps the focus gate and loop", () => {
    let cars = false;
    deps = makeDeps({ getCarsEnabled: () => cars });
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    // No transition clip…
    expect(voicePaths()).toEqual([]);
    // …but the focus gate is still acquired.
    expect(acquireSpy).toHaveBeenCalledTimes(1);

    // …and the still-there loop still runs (still-there opt-in is on).
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
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

    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    stillThere = false;
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);

    // Re-enabling mid-session resumes the loop (it stayed scheduled, silent).
    stillThere = true;
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
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
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    master = false;
    bus.publishRadar("two-left", "left");

    expect(voicePaths().length).toBe(afterArrival);
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("pit road forces clear and fires nothing", () => {
    registerSpotterEngine(bus, deps);
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    sim.getLatestTelemetry.mockReturnValue({ OnPitRoad: true });
    bus.publishRadar("both", "left");

    expect(voicePaths().length).toBe(afterArrival);
  });

  it("Lone Qualify forces clear and fires nothing", () => {
    registerSpotterEngine(bus, deps);

    sim.getSessionType.mockReturnValue("Lone Qualify");
    bus.publishRadar("left");

    expect(voicePaths()).toEqual([]);
  });

  it("is inactive when both opt-ins are off: no clip, no focus floor, no loop", () => {
    // With neither "cars" nor "still-there" enabled the spotter would never
    // speak, so it must not hold the focus floor (which would silently suppress
    // other Race Engineer chatter while a car is alongside).
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");
    deps = makeDeps({ getCarsEnabled: () => false, getStillThereEnabled: () => false });
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(voicePaths()).toEqual([]);
    expect(acquireSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths()).toEqual([]);
  });
});

// ─── Scenario identity ───────────────────────────────────────────────────────

describe("scenario identity", () => {
  it("fires the spotter-call scenario as the focus owner so it bypasses its own floor", () => {
    registerSpotterEngine(bus, deps);

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

    freshBus.publishRadar("left");

    const played = freshAudio._played.filter((p) => p.channel === VOICE).map((p) => p.path);
    expect(played).toEqual(["voice/elena/spotter/car-left.mp3"]);
    bus = freshBus;
    audio = freshAudio;
  });
});

// ─── Clear confirmation buffer (#651) ────────────────────────────────────────

describe("clear confirmation buffer", () => {
  beforeEach(() => {
    registerSpotterEngine(bus, deps);
  });

  it("holds 'clear' until the nearest-car gap grows by the buffer distance", () => {
    nearestGap = 2;
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    // CarLeftRight flickers clear, but the car hasn't pulled away — no clear yet.
    bus.publishRadar("clear", "left");
    vi.advanceTimersByTime(SPOTTER_CLEAR_POLL_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);

    // The car pulls past the buffer distance → the next poll confirms clear.
    nearestGap = 2 + SPOTTER_CLEAR_BUFFER_METERS;
    vi.advanceTimersByTime(SPOTTER_CLEAR_POLL_MS);
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
  });

  it("a car flickering back during the buffer cancels the pending clear (no stutter)", () => {
    nearestGap = 2;
    bus.publishRadar("left");
    const afterArrival = voicePaths().length;

    bus.publishRadar("clear", "left"); // enter the pending clear
    bus.publishRadar("left", "clear"); // flicker back to the same side
    vi.advanceTimersByTime(SPOTTER_CLEAR_POLL_MS * 5);

    expect(voicePaths().length).toBe(afterArrival);
    expect(voicePaths()).not.toContain(`${BASE}clear.mp3`);
  });

  it("falls back to clear after the fallback window if the gap never grows", () => {
    nearestGap = 5;
    bus.publishRadar("right");

    bus.publishRadar("clear", "right");
    // Gap stays flat (e.g. a sideways move at a matched longitudinal position).
    vi.advanceTimersByTime(SPOTTER_CLEAR_FALLBACK_MS + SPOTTER_CLEAR_POLL_MS);
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
  });

  it("skips the buffer (immediate clear) when no distance data is available", () => {
    nearestGap = null;
    bus.publishRadar("left");

    bus.publishRadar("clear", "left");
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
  });

  it("does not speak 'still there' while a clear is pending (short cadence)", () => {
    nearestGap = 2;
    deps = makeDeps({ getStillThereIntervalMs: () => 400 });
    _resetSpotterEngine();
    _resetAudioScenarios();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    bus.publishRadar("clear", "left"); // enter pending clear; loop interval is 400 ms
    const afterArrival = voicePaths().length;

    // The 400 ms still-there tick lands during the pending window but must stay
    // silent (no "still there" immediately before the buffered "clear").
    vi.advanceTimersByTime(400);
    expect(voicePaths().length).toBe(afterArrival);

    // Gap grows → the next poll confirms a clear clip (not a still-there).
    nearestGap = 2 + SPOTTER_CLEAR_BUFFER_METERS;
    vi.advanceTimersByTime(SPOTTER_CLEAR_POLL_MS);
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
  });
});
