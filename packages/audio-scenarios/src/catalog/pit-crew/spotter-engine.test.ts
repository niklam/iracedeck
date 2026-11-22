import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, RadarState, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { classifySession } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_FRAME, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { familyReferences } from "./family-references.test-util.js";
import {
  _resetSpotterEngine,
  readSpotterDebugState,
  registerSpotterEngine,
  SPOTTER_CALL_BASES,
  SPOTTER_CALL_SCENARIO_ID,
  SPOTTER_CLEAR_BUFFER_METERS,
  SPOTTER_CLEAR_FALLBACK_MS,
  SPOTTER_CLEAR_POLL_MS,
  SPOTTER_CLIP_BASES,
  SPOTTER_CLIP_DRAWS,
  SPOTTER_CONTRACTS,
  SPOTTER_FOCUS_OWNER,
  SPOTTER_INFO_BASES,
  SPOTTER_INFO_SCENARIO_ID,
  SPOTTER_SCENARIO_IDS,
  SPOTTER_STILL_THERE_DEFAULT_MS,
  type SpotterDeps,
  type SpotterTrackDirection,
} from "./spotter-engine.js";

// ─── The engine's sim reads ───────────────────────────────────────────────
//
// The engine reads telemetry (pit-road) and session type (Lone Qualify)
// through its deps (#1378), as it reads the track rotation direction — the
// catalog's own `SpotterTrackDirection` union. These stubs back them.

const sim = {
  getLatestTelemetry: vi.fn<() => { OnPitRoad?: boolean } | null>(),
  rawSessionType: vi.fn<() => string>(),
};

// ─── Fake audio service (records plays, drives channel-complete manually) ───

// The spotter names a line per transition and the pool store picks its clip
// from the manifest for the active voice at fire time (issue #1718); a line
// with no clip aborts the fire (issue #835) — so the fixture carries the full
// production spotter clip set per test voice, as bare files.
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
  clips: [
    ...["luca", "elena"].flatMap((v) => SPOTTER_CLIP_NAMES.map((name) => `voice/${v}/spotter/${name}.mp3`)),
    // Non-spotter clip for the #867 scheduling tests' in-flight blocker line.
    "test/blocker.mp3",
  ],
  ambientLoop: "",
  ticks: { open: "", close: "" },
} as never;

/**
 * The bundled voice's script narrowed to the two spotter entries (F7-trap i),
 * handed to BOTH test voices: since #1065 a spotter fire plays nothing unless
 * the active voice's script says what to say, and what it says is the one
 * `{{spotterClip}}` step. The JSON import types `schema` as `number`, hence
 * the cast.
 */
const SCRIPT = defaultScript as CalloutScript;
const SPOTTER_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(SPOTTER_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};
const SCRIPT_VOICES = ["luca", "elena"] as const;

const MANIFEST = manifestJson as AudioAssetsManifest;

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
let trackDirection: SpotterTrackDirection;
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
    getLatestTelemetry: () => sim.getLatestTelemetry() as TelemetryData | null,
    getSessionClass: () => classifySession(sim.rawSessionType()),
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

/**
 * Real engine + fake audio so the var → resolved-clip path is asserted
 * end-to-end. `getActiveVoice` returns "luca" so `{voice}` substitution is
 * exercised on the played path. The scripts go in BEFORE the per-test
 * `registerSpotterEngine` (which registers the contracts): a contract
 * registered after `setScripts` marks the compiled scripts dirty and is
 * compiled before its first fire, exactly as a plugin's startup order does.
 */
function initEngine(): void {
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => "luca");
  getScenarioEngine().setScripts(new Map(SCRIPT_VOICES.map((v) => [v, SPOTTER_SCRIPT])));
}

beforeEach(() => {
  vi.useFakeTimers();
  bus = createMockBus();
  audio = createFakeAudio();
  trackDirection = "neutral";
  nearestGap = null;
  initEngine();
  deps = makeDeps();
  sim.getLatestTelemetry.mockReset();
  sim.getLatestTelemetry.mockReturnValue({ OnPitRoad: false });
  sim.rawSessionType.mockReset();
  sim.rawSessionType.mockReturnValue("Race");
});

afterEach(() => {
  _resetSpotterEngine();
  _resetAudioScenarios();
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registerSpotterEngine", () => {
  it("defines both spotter scenarios and subscribes to radar.changed once", () => {
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

describe("road arrivals (neutral direction)", () => {
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
    // Finish the arrival clip — a lower-weight info fire never cuts a
    // still-playing transition call (#867 family split).
    audio._triggerChannelEnd(VOICE);

    bus.publishRadar("clear", "left");

    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
  });
});

// ─── Oval mapping ────────────────────────────────────────────────────────────

describe("oval mapping (inside / outside)", () => {
  it("left-going oval: clear → left is car-inside, clear → right is car-outside", () => {
    trackDirection = "left";
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-inside.mp3`);

    bus.publishRadar("clear", "left");
    bus.publishRadar("right");
    expect(lastVoicePath()).toBe(`${BASE}car-outside.mp3`);
  });

  it("left-going oval: both → left plays clear-outside-car-inside", () => {
    trackDirection = "left";
    registerSpotterEngine(bus, deps);

    bus.publishRadar("both");
    bus.publishRadar("left", "both");
    expect(lastVoicePath()).toBe(`${BASE}clear-outside-car-inside.mp3`);
  });

  it("right-going oval: clear → left is car-outside", () => {
    trackDirection = "right";
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-outside.mp3`);
  });

  it("right-going oval: both → left plays clear-inside-car-outside", () => {
    trackDirection = "right";
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
    // Finish the arrival clip — an info fire never cuts a playing call (#867).
    audio._triggerChannelEnd(VOICE);
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
    audio._triggerChannelEnd(VOICE);

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
    audio._triggerChannelEnd(VOICE);
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
    initEngine();
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

    sim.rawSessionType.mockReturnValue("Lone Qualify");
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 3);
    expect(voicePaths().length).toBe(afterArrival);
  });

  it("fires at the configured interval and applies a live cadence change (#651)", () => {
    let intervalMs = 6000;
    deps = makeDeps({ getStillThereIntervalMs: () => intervalMs });
    _resetSpotterEngine();
    _resetAudioScenarios();
    initEngine();
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);
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
    audio._triggerChannelEnd(VOICE);
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

    sim.rawSessionType.mockReturnValue("Lone Qualify");
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

  it("registers the transition-call contract at PROXIMITY and the info contract at SAFETY (#867), as contracts (#1065)", () => {
    // Spy before the first registration so the initial defineContract is captured.
    const spy = vi.spyOn(getScenarioEngine(), "defineContract");
    const legacy = vi.spyOn(getScenarioEngine(), "defineScenario");
    registerSpotterEngine(bus, deps);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SPOTTER_CALL_SCENARIO_ID,
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        weight: WEIGHT.PROXIMITY,
        focusOwner: SPOTTER_FOCUS_OWNER,
        family: "spotter",
        interrupt: true,
        queueable: false,
        frame: NO_FRAME,
      }),
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SPOTTER_INFO_SCENARIO_ID,
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        weight: WEIGHT.SAFETY,
        focusOwner: SPOTTER_FOCUS_OWNER,
        // Deliberately NOT the call contract's family: same-family preemption
        // ignores weight, so a shared family would let a reminder tick chop a
        // still-playing transition call.
        family: "spotter-info",
        interrupt: true,
        queueable: false,
        frame: NO_FRAME,
      }),
    );
    expect(legacy).not.toHaveBeenCalled();
  });

  it("the contracts carry no `when` and no sequence — this engine fires them, the voice script says what they say", () => {
    expect(SPOTTER_SCENARIO_IDS).toEqual([SPOTTER_CALL_SCENARIO_ID, SPOTTER_INFO_SCENARIO_ID]);

    for (const c of SPOTTER_CONTRACTS) {
      expect(c.when).toBeUndefined();
      expect("sequence" in c).toBe(false);
      expect(c.base).toBeUndefined();
    }
  });
});

// ─── Scripted fires (issue #1065) ────────────────────────────────────────────
//
// `engine.fire(id)` resolves a contract through the same registration path a
// bus-triggered one takes: the body is the active voice's compiled script
// entry, so a voice without one is silent and a voice with one plays.

describe("scripted fires (issue #1065)", () => {
  it("a fire on a voice whose script has no spotter entry is a silent no-op — no clip, no error", () => {
    getScenarioEngine().setScripts(new Map(SCRIPT_VOICES.map((v) => [v, { ...SPOTTER_SCRIPT, scenarios: {} }])));
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");

    expect(voicePaths()).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("a fire on a voice with no script at all is a silent no-op too", () => {
    getScenarioEngine().setScripts(new Map());
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");

    expect(voicePaths()).toEqual([]);
  });

  it("a scripted voice plays the engine-chosen clip, unframed, for the call and the info contract alike", () => {
    nearestGap = null;
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(audio._played.map((p) => p.path)).toEqual([`${BASE}car-left.mp3`]);

    audio._triggerChannelEnd(VOICE);
    bus.publishRadar("clear", "left");
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
    // No tick before or after either line: both contracts are `frame: NO_FRAME`.
    expect(audio._played.every((p) => p.path.startsWith("voice/"))).toBe(true);
  });

  it("publishes the spotterClip var with a description naming the spotter group", () => {
    registerSpotterEngine(bus, deps);

    const { vars } = getScenarioEngine().vocabulary();
    const clip = vars.find((v) => v.name === "spotterClip");

    expect(clip).toBeDefined();
    expect(clip?.description).toContain("spotter");
  });

  it("scripts both contracts with a comment, a Radar harness route and the one var step", () => {
    for (const id of SPOTTER_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Radar → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence).toEqual(["{{spotterClip}}"]);
    }
  });

  it("references only the spotterClip var and no pool — every clip reaches the script through the engine's choice", () => {
    const refs = familyReferences(SPOTTER_SCRIPT);

    expect(refs.vars).toEqual(["spotterClip"]);
    expect(refs.pools).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
  });

  it("the bundled voice ships every clip the engine can choose", () => {
    for (const name of SPOTTER_CLIP_NAMES) {
      expect(MANIFEST.clips, name).toContain(`voice/default/spotter/${name}.mp3`);
    }
  });
});

// ─── Proximity scheduling (issue #867) ───────────────────────────────────────
//
// A proximity transition call must ALWAYS be heard, immediately — no in-flight
// line, not even a CRITICAL one, may keep it off the bus. The informational
// fires ("Clear.", the still-there reminder) stay at SAFETY so they can never
// chop up a CRITICAL line (meatball, fuel-critical, start gantry).

describe("proximity scheduling (#867)", () => {
  const BLOCKER_CLIP = "test/blocker.mp3";

  /**
   * Define + fire a blocker line at the given weight; it stays in flight.
   * Unframed: the fixture manifest carries no tick clips, and with a script
   * loaded (#1065) the engine would otherwise try to wrap this legacy line
   * in the voice's `radio` frame and abort it — the blocker exists only to
   * hold the bus at a weight, never to test framing.
   */
  function startBlocker(weight: number, opts: { queueable?: boolean; interrupt?: boolean } = {}): void {
    getScenarioEngine().defineScenario({
      id: "test.blocker",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight,
      frame: NO_FRAME,
      ...opts,
      sequence: [BLOCKER_CLIP],
    });
    getScenarioEngine().fire("test.blocker");
    expect(voicePaths()).toContain(BLOCKER_CLIP);
  }

  beforeEach(() => {
    registerSpotterEngine(bus, deps);
  });

  it("a transition call cuts an in-flight CRITICAL line and plays immediately", () => {
    startBlocker(WEIGHT.CRITICAL, { interrupt: true });
    bus.publishRadar("left");

    expect(audio._stopped).toContain(VOICE);
    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);
  });

  it("a transition call cuts an in-flight equal-SAFETY line and plays immediately", () => {
    startBlocker(WEIGHT.SAFETY);
    bus.publishRadar("left");

    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);
  });

  it("'Clear.' does not cut an in-flight CRITICAL line (stays SAFETY)", () => {
    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);
    // CRITICAL passes the spotter's SAFETY focus floor and takes the bus.
    startBlocker(WEIGHT.CRITICAL, { interrupt: true });
    bus.publishRadar("clear", "left");

    expect(voicePaths()).not.toContain(`${BASE}clear.mp3`);
  });

  it("the still-there reminder does not cut an in-flight CRITICAL line", () => {
    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);
    startBlocker(WEIGHT.CRITICAL, { interrupt: true });
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);

    expect(voicePaths()).not.toContain(`${BASE}still-there.mp3`);
    expect(voicePaths()).not.toContain(`${BASE}hold-your-line.mp3`);
  });

  it("the still-there reminder still cuts routine NORMAL chatter (SAFETY + interrupt)", () => {
    // Cars-off keeps the arrival call from cutting the blocker first, while the
    // focus gate + reminder loop still engage on the transition.
    registerSpotterEngine(bus, makeDeps({ getCarsEnabled: () => false }));
    startBlocker(WEIGHT.NORMAL);
    bus.publishRadar("left");
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);

    const reminders = voicePaths().filter((p) => p === `${BASE}still-there.mp3` || p === `${BASE}hold-your-line.mp3`);
    expect(reminders).toHaveLength(1);
  });

  it("a transition call cuts an in-flight reminder (PROXIMITY > SAFETY + interrupt)", () => {
    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);

    bus.publishRadar("two-left", "left");

    expect(lastVoicePath()).toBe(`${BASE}two-cars-left.mp3`);
  });

  it("the reminder never replaces an in-flight transition call, and retries next tick", () => {
    // The transition clip is still playing when the reminder tick fires: the
    // info scenario is a different family and lower weight, so it drops
    // instead of wholesale-replacing the danger call mid-word.
    bus.publishRadar("left");
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);

    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);

    // The loop self-heals: once the call clip ends, the next tick speaks.
    audio._triggerChannelEnd(VOICE);
    vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);

    const reminders = voicePaths().filter((p) => p === `${BASE}still-there.mp3` || p === `${BASE}hold-your-line.mp3`);
    expect(reminders).toHaveLength(1);
  });

  it("'Clear.' never cuts an in-flight transition call", () => {
    // Arrival clip still playing when the (immediate, no gap data) clear
    // lands — the info fire drops rather than truncating the danger call.
    bus.publishRadar("left");
    bus.publishRadar("clear", "left");

    expect(voicePaths()).not.toContain(`${BASE}clear.mp3`);
    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);
  });

  it("a queueable CRITICAL line cut by a transition call replays once the call finishes", () => {
    // Fuel-critical shape: CRITICAL + interrupt + queueable. The cut stashes
    // it; CRITICAL clears the spotter's SAFETY focus floor, so it replays at
    // idle even while the car is still alongside.
    startBlocker(WEIGHT.CRITICAL, { interrupt: true, queueable: true });
    bus.publishRadar("left");
    expect(lastVoicePath()).toBe(`${BASE}car-left.mp3`);

    audio._triggerChannelEnd(VOICE);

    expect(voicePaths().filter((p) => p === BLOCKER_CLIP)).toHaveLength(2);
  });
});

// ─── Focus without a script (issue #1065) ────────────────────────────────────
//
// The spotter lines are contracts, so a pack whose script omits them is
// silent for them — and that silence must be the whole cost. The focus floor
// exists to keep chatter from talking over a call the engineer is about to
// make; with no call to make it would only mute every lower-weight callout
// for as long as a car is alongside.

describe("focus without a script (issue #1065)", () => {
  const CHATTER_CLIP = "test/blocker.mp3";

  /** A routine NORMAL-weight line — what a SAFETY floor would hold back. */
  function fireNormalChatter(): void {
    getScenarioEngine().defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      frame: NO_FRAME,
      sequence: [CHATTER_CLIP],
    });
    getScenarioEngine().fire("test.chatter");
  }

  it("a car alongside acquires no focus floor when the active voice does not script the spotter, so NORMAL chatter still plays", () => {
    getScenarioEngine().setScripts(new Map(SCRIPT_VOICES.map((v) => [v, { ...SPOTTER_SCRIPT, scenarios: {} }])));
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(voicePaths()).toEqual([]);

    fireNormalChatter();
    expect(voicePaths()).toEqual([CHATTER_CLIP]);
  });

  it("with the bundled script the floor is raised as before, and the same NORMAL chatter is held back", () => {
    const acquireSpy = vi.spyOn(getScenarioEngine(), "acquireFocus");
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    expect(acquireSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER, WEIGHT.SAFETY);
    audio._triggerChannelEnd(VOICE);

    fireNormalChatter();
    expect(voicePaths()).toEqual([`${BASE}car-left.mp3`]);
  });

  it("releases a floor it holds when the voice stops scripting the spotter mid-episode", () => {
    registerSpotterEngine(bus, deps);
    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);

    // A rescan handed the engine a script map without the spotter entries
    // while the car is still alongside; the next transition lets go.
    getScenarioEngine().setScripts(new Map(SCRIPT_VOICES.map((v) => [v, { ...SPOTTER_SCRIPT, scenarios: {} }])));
    const releaseSpy = vi.spyOn(getScenarioEngine(), "releaseFocus");
    bus.publishRadar("two-left", "left");

    expect(releaseSpy).toHaveBeenCalledWith(AudioBus.Voice, SPOTTER_FOCUS_OWNER);
    fireNormalChatter();
    expect(voicePaths()).toEqual([`${BASE}car-left.mp3`, CHATTER_CLIP]);
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
    getScenarioEngine().setScripts(new Map(SCRIPT_VOICES.map((v) => [v, SPOTTER_SCRIPT])));
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
    // Finish the arrival clip — an info fire never cuts a playing call (#867).
    audio._triggerChannelEnd(VOICE);
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
    audio._triggerChannelEnd(VOICE);

    bus.publishRadar("clear", "right");
    // Gap stays flat (e.g. a sideways move at a matched longitudinal position).
    vi.advanceTimersByTime(SPOTTER_CLEAR_FALLBACK_MS + SPOTTER_CLEAR_POLL_MS);
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
  });

  it("skips the buffer (immediate clear) when no distance data is available", () => {
    nearestGap = null;
    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);

    bus.publishRadar("clear", "left");
    expect(lastVoicePath()).toBe(`${BASE}clear.mp3`);
  });

  it("does not speak 'still there' while a clear is pending (short cadence)", () => {
    nearestGap = 2;
    deps = makeDeps({ getStillThereIntervalMs: () => 400 });
    _resetSpotterEngine();
    _resetAudioScenarios();
    initEngine();
    registerSpotterEngine(bus, deps);

    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);
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

// ─── Pool references (issue #1718) ───────────────────────────────────────────
//
// The engine names a LINE — `pool:spotter/<base>` — and the pool store picks
// the clip: the bare `<base>.mp3` and every `<base>-NN.mp3` take of the active
// voice, with no immediate repeat, committed only when the fire is accepted.

/** Every radar state the translator reports. */
const RADAR_STATES: readonly RadarState[] = ["clear", "left", "right", "both", "two-left", "two-right"];
const DIRECTIONS: readonly SpotterTrackDirection[] = ["neutral", "left", "right"];

/** Re-initialise the engine against a manifest of `clips` (voice "luca"), with the spotter registered. */
function useManifestClips(clips: readonly string[]): void {
  _resetSpotterEngine();
  _resetAudioScenarios();
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(
    bus,
    audio,
    { clips: [...clips], ambientLoop: "", ticks: { open: "", close: "" } } as never,
    mockLogger as never,
    () => "luca",
  );
  getScenarioEngine().setScripts(new Map(SCRIPT_VOICES.map((v) => [v, SPOTTER_SCRIPT])));
  registerSpotterEngine(bus, deps);
  // The scripts compiled before the contracts existed warned "no contract";
  // that is setup, not what the test fires.
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
}

/** `pool:spotter/<base>` → `<base>`; fails the test on any other shape. */
function spotterBase(ref: string): string {
  const match = /^pool:spotter\/([^/]+)$/.exec(ref);

  expect(match, `"${ref}" is not a pool:spotter/<base> reference`).not.toBeNull();

  return (match as RegExpExecArray)[1];
}

describe("pool references (issue #1718)", () => {
  it("every fire hands the script a pool:spotter/<base> reference, and every transition's base is in SPOTTER_CLIP_BASES", () => {
    registerSpotterEngine(bus, deps);
    // Read the reference each fire is made with, not what the scheduler does
    // with it: an info fire arriving during a call clip drops (#867), which
    // would hide its reference from the played list.
    const fired: { id: string; ref: string }[] = [];
    vi.spyOn(getScenarioEngine(), "fire").mockImplementation((id: string) => {
      fired.push({ id, ref: readSpotterDebugState().pendingSpotterClip });
    });

    for (const dir of DIRECTIONS) {
      trackDirection = dir;

      for (const from of RADAR_STATES) {
        for (const to of RADAR_STATES) {
          if (to === from) continue;

          // Back to clear first (no gap data, so the clear is immediate), then
          // `from`, then the transition under test.
          bus.publishRadar("clear");
          bus.publishRadar(from);
          bus.publishRadar(to, from);
        }
      }

      // The still-there reminder: two ticks cover both lines (no repeat).
      bus.publishRadar("left");
      vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS * 2);
    }

    const bases = fired.map(({ ref }) => spotterBase(ref));
    const firedThrough = (id: string) =>
      [...new Set(fired.filter((fire) => fire.id === id).map(({ ref }) => spotterBase(ref)))].sort();

    // Both directions: every reference is a declared base, and every declared
    // base is reachable from some transition — the declaration is exact.
    expect(bases.filter((base) => !SPOTTER_CLIP_BASES.includes(base))).toEqual([]);
    expect([...new Set(bases)].sort()).toEqual([...SPOTTER_CLIP_BASES]);
    // And per contract: what the call contract fires is exactly the call set,
    // what the info contract fires exactly the info set — the scopes the
    // `draws` declare (#1718). No fire uses any other contract.
    expect(firedThrough(SPOTTER_CALL_SCENARIO_ID)).toEqual([...SPOTTER_CALL_BASES]);
    expect(firedThrough(SPOTTER_INFO_SCENARIO_ID)).toEqual([...SPOTTER_INFO_BASES]);
    expect(fired.filter(({ id }) => id !== SPOTTER_CALL_SCENARIO_ID && id !== SPOTTER_INFO_SCENARIO_ID)).toEqual([]);
  });

  it("the call and info bases are disjoint and together are SPOTTER_CLIP_BASES", () => {
    expect(SPOTTER_CALL_BASES.filter((base) => SPOTTER_INFO_BASES.includes(base))).toEqual([]);
    expect([...SPOTTER_CALL_BASES, ...SPOTTER_INFO_BASES].sort()).toEqual([...SPOTTER_CLIP_BASES]);
    expect([...SPOTTER_INFO_BASES]).toEqual(["clear", "hold-your-line", "still-there"]);
    expect(SPOTTER_CALL_BASES).toHaveLength(21);
  });

  it("SPOTTER_CLIP_BASES is exactly the 24 spotter lines the bundled default voice ships", () => {
    const prefix = "voice/default/spotter/";
    // Lines, not files: a numbered take (`car-left-02.mp3`) is a take of its
    // base's line, so the default voice may gain takes without failing this.
    const shipped = [
      ...new Set(
        MANIFEST.clips
          .filter((clip) => clip.startsWith(prefix))
          .map((clip) =>
            clip
              .slice(prefix.length)
              .replace(/\.mp3$/, "")
              .replace(/-\d{2}$/, ""),
          ),
      ),
    ].sort();

    expect(SPOTTER_CLIP_BASES).toHaveLength(24);
    expect(new Set(SPOTTER_CLIP_BASES).size).toBe(SPOTTER_CLIP_BASES.length);
    expect([...SPOTTER_CLIP_BASES]).toEqual(shipped);
    // The test fixture's bare clip set names the same lines.
    expect([...SPOTTER_CLIP_BASES]).toEqual([...SPOTTER_CLIP_NAMES].sort());
  });

  it("registers spotterClip with `draws` declaring every spotter base, each scoped to the contract that fires it", () => {
    registerSpotterEngine(bus, deps);

    const clip = getScenarioEngine()
      .vocabulary()
      .vars.find((v) => v.name === "spotterClip");

    expect(clip?.draws).toEqual([...SPOTTER_CLIP_DRAWS]);
    expect(clip?.draws).toEqual(
      SPOTTER_CLIP_BASES.map((base) => ({
        group: "spotter",
        base,
        contracts: [SPOTTER_INFO_BASES.includes(base) ? SPOTTER_INFO_SCENARIO_ID : SPOTTER_CALL_SCENARIO_ID],
      })),
    );
    expect(clip?.draws?.find((draw) => draw.base === "clear")?.contracts).toEqual([SPOTTER_INFO_SCENARIO_ID]);
    expect(clip?.draws?.find((draw) => draw.base === "car-left")?.contracts).toEqual([SPOTTER_CALL_SCENARIO_ID]);
  });

  it("a voice that recorded the spotter as takes only plays them — car-left-01 and car-left-02 for the left arrival", () => {
    useManifestClips(["voice/luca/spotter/car-left-01.mp3", "voice/luca/spotter/car-left-02.mp3"]);

    bus.publishRadar("left");
    audio._triggerChannelEnd(VOICE);
    // No clear clip in this pack: "Clear." aborts silently (#835), the episode still ends.
    bus.publishRadar("clear", "left");
    bus.publishRadar("left");

    // Two arrivals, two different takes: the pool store's no-repeat.
    expect([...voicePaths()].sort()).toEqual([
      "voice/luca/spotter/car-left-01.mp3",
      "voice/luca/spotter/car-left-02.mp3",
    ]);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("a voice with both the bare file and takes draws from all of them", () => {
    useManifestClips([
      "voice/luca/spotter/car-left.mp3",
      "voice/luca/spotter/car-left-01.mp3",
      "voice/luca/spotter/car-left-02.mp3",
    ]);
    // The pool's members sort as -01, -02, bare; one draw lands on each.
    const randomSpy = vi.spyOn(Math, "random");
    randomSpy.mockReturnValueOnce(0).mockReturnValueOnce(0.4).mockReturnValueOnce(0.9);

    for (let i = 0; i < 3; i++) {
      bus.publishRadar("left");
      audio._triggerChannelEnd(VOICE);
      bus.publishRadar("clear", "left");
    }

    expect(voicePaths()).toEqual([
      "voice/luca/spotter/car-left-01.mp3",
      "voice/luca/spotter/car-left-02.mp3",
      "voice/luca/spotter/car-left.mp3",
    ]);
    randomSpy.mockRestore();
  });

  it("still-there alternates between its two lines, and each line's takes are drawn from", () => {
    useManifestClips([
      "voice/luca/spotter/car-left.mp3",
      "voice/luca/spotter/still-there-01.mp3",
      "voice/luca/spotter/still-there-02.mp3",
      "voice/luca/spotter/hold-your-line-01.mp3",
      "voice/luca/spotter/hold-your-line-02.mp3",
    ]);
    const refs: string[] = [];

    bus.publishRadar("left");

    for (let i = 0; i < 4; i++) {
      // Finish whatever is playing — an info fire never cuts a playing call (#867).
      audio._triggerChannelEnd(VOICE);
      vi.advanceTimersByTime(SPOTTER_STILL_THERE_DEFAULT_MS);
      refs.push(readSpotterDebugState().pendingSpotterClip);
    }

    const reminders = voicePaths().slice(1);
    const bases = refs.map(spotterBase);

    // The engine's line pick never repeats, so four ticks alternate.
    expect(bases[0]).not.toBe(bases[1]);
    expect(bases[2]).toBe(bases[0]);
    expect(bases[3]).toBe(bases[1]);
    expect([...new Set(bases)].sort()).toEqual(["hold-your-line", "still-there"]);
    // Each line was picked twice, and the pool store's no-repeat gave each a
    // different take: all four clips played.
    expect([...reminders].sort()).toEqual([
      "voice/luca/spotter/hold-your-line-01.mp3",
      "voice/luca/spotter/hold-your-line-02.mp3",
      "voice/luca/spotter/still-there-01.mp3",
      "voice/luca/spotter/still-there-02.mp3",
    ]);
  });

  it("the var hands the script the engine's reference unchanged — the played clip is that pool's pick", () => {
    registerSpotterEngine(bus, deps);

    bus.publishRadar("two-right");

    expect(readSpotterDebugState().pendingSpotterClip).toBe("pool:spotter/two-cars-right");
    expect(lastVoicePath()).toBe(`${BASE}two-cars-right.mp3`);
  });
});
