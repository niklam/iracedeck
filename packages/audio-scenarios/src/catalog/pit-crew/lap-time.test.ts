/**
 * Lap-time best-lap contract tests (issue #555; scripted since #1065).
 *
 * Drives the contract through the real scenario engine — same harness shape
 * as `session-start.test.ts` — with the bundled voice's REAL `callouts.json`
 * narrowed to this family's entry, so var resolution and the conditional
 * minute clause all run the production compile + expansion path; what the
 * engineer says is the script's.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import {
  buildLapTimeContract,
  LAP_TIME_CLIP_SOURCES,
  LAP_TIME_SCENARIO_IDS,
  type LapCompletedSnapshot,
  splitLapTime,
} from "./lap-time.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
}));

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & { publishEvent: (name: SimEventName, data: Record<string, unknown>) => void } {
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
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
    },
    publishEvent(name: SimEventName, data: Record<string, unknown>) {
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
  _played: { channel: AudioChannel; path: string }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
  };
  const played: { channel: AudioChannel; path: string }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string) => {
      played.push({ channel, path });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => {
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
    _played: played,
  } as unknown as FakeAudio;
}

function flush(audio: FakeAudio, iterations = 60): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    vi.advanceTimersByTime(1000);
  }
}

const VOICE = "default";

const INTRO_NAMES = ["best-lap-yet", "first-good-lap"];
const MINUTE_NAMES = Array.from({ length: 10 }, (_, i) => String(i + 1));
const SECOND_NAMES = Array.from({ length: 60 }, (_, i) => String(i));
const DECIMAL_NAMES = Array.from({ length: 10 }, (_, i) => String(i));

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...INTRO_NAMES.map((n) => `voice/${VOICE}/lap-time-intro/${n}.mp3`),
    ...MINUTE_NAMES.map((n) => `voice/${VOICE}/lap-time-minute/${n}.mp3`),
    ...SECOND_NAMES.map((n) => `voice/${VOICE}/lap-time-second/${n}.mp3`),
    ...DECIMAL_NAMES.map((n) => `voice/${VOICE}/lap-time-decimal/${n}.mp3`),
    // Beyond the historical 10-minute bound — speakability derives from the
    // clips that exist, not a code constant (issue #836).
    `voice/${VOICE}/lap-time-minute/12.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entry (and to no
 * fragments — it includes none): an entry for a contract this engine does
 * not hold is a `no contract` warn, and a foreign fragment would widen
 * `collectScriptReferences` under the assertions below.
 */
const LAP_TIME_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(LAP_TIME_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

function snap(overrides: Partial<LapCompletedSnapshot> = {}): LapCompletedSnapshot {
  return {
    lap: 5,
    lapTime: 94.8,
    isBest: true,
    isFirstValid: false,
    bestLapTime: 94.8,
    previousBestLapTime: 96.2,
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let lastSnapshot: LapCompletedSnapshot | null;
let lapTimeEnabled: boolean;
let raceFinished: boolean;

function fire(data: LapCompletedSnapshot | null): void {
  lastSnapshot = data;

  if (data) {
    bus.publishEvent("lap.completed", data as unknown as Record<string, unknown>);
  }

  flush(audio);
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function hasClip(suffix: string): boolean {
  return voicePaths().some((p) => p.endsWith(suffix));
}

beforeEach(() => {
  vi.useFakeTimers();
  lastSnapshot = null;
  lapTimeEnabled = true;
  raceFinished = false;
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getLapTimeCalloutEnabled: () => lapTimeEnabled,
    getLapCompletedSnapshot: () => lastSnapshot,
    getRaceFinishedFired: () => raceFinished,
  });
  // After the registration, as the plugins do: the readout's body is looked
  // up in the active voice's compiled script at fire time (issue #1065).
  getScenarioEngine().setScripts(new Map([[VOICE, LAP_TIME_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("splitLapTime", () => {
  it("splits a 1:34.8 lap into minutes=1, seconds=34, tenths=8", () => {
    expect(splitLapTime(94.8)).toEqual({ minutes: 1, seconds: 34, tenths: 8 });
  });

  it("splits a sub-1-min lap (34.8s) into minutes=0", () => {
    expect(splitLapTime(34.8)).toEqual({ minutes: 0, seconds: 34, tenths: 8 });
  });

  it("rounds to the nearest tenth so 34.85 becomes 34.9", () => {
    expect(splitLapTime(34.85)).toEqual({ minutes: 0, seconds: 34, tenths: 9 });
  });

  it("carries over to the next second on round-up (34.95 → 35.0)", () => {
    expect(splitLapTime(34.95)).toEqual({ minutes: 0, seconds: 35, tenths: 0 });
  });

  it("carries minutes on round-up at the boundary (59.95s in a sub-1-min lap → 1:00.0)", () => {
    expect(splitLapTime(59.95)).toEqual({ minutes: 1, seconds: 0, tenths: 0 });
  });

  it("returns zero for negative input", () => {
    expect(splitLapTime(-5)).toEqual({ minutes: 0, seconds: 0, tenths: 0 });
  });

  it("returns zero for NaN", () => {
    expect(splitLapTime(NaN)).toEqual({ minutes: 0, seconds: 0, tenths: 0 });
  });
});

describe("lap-time scenario", () => {
  it("plays the full readout for a 1:03.4 new personal best", () => {
    fire(snap({ lapTime: 63.4 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(hasClip("/lap-time-minute/1.mp3")).toBe(true);
    expect(hasClip("/lap-time-second/3.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/4.mp3")).toBe(true);
  });

  it("skips the minute clip for a sub-1-minute lap", () => {
    fire(snap({ lapTime: 8.7 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.includes("/lap-time-minute/"))).toBe(false);
    expect(hasClip("/lap-time-second/8.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/7.mp3")).toBe(true);
  });

  it("uses the first-good-lap intro when there is no prior best", () => {
    fire(snap({ lapTime: 63.4, isFirstValid: true, previousBestLapTime: undefined }));

    expect(hasClip("/lap-time-intro/first-good-lap.mp3")).toBe(true);
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(false);
  });

  it("uses the best-lap-yet intro when there is a prior best to beat", () => {
    fire(snap({ lapTime: 63.4, previousBestLapTime: 64.1 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(hasClip("/lap-time-intro/first-good-lap.mp3")).toBe(false);
  });

  it("does not fire when isBest is false", () => {
    fire(snap({ lapTime: 63.4, isBest: false }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when the minute component has no clip (11:05.5, no 11.mp3 staged)", () => {
    fire(snap({ lapTime: 665.5 }));

    expect(voicePaths()).toEqual([]);
  });

  it("speaks any minute value that has a clip — no hardcoded minute bound (issue #836)", () => {
    // 12:30.5 — beyond the historical 10-minute constant, but 12.mp3 exists.
    fire(snap({ lapTime: 750.5 }));

    expect(hasClip("/lap-time-minute/12.mp3")).toBe(true);
    expect(hasClip("/lap-time-second/30.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/5.mp3")).toBe(true);
  });

  it("plays a full 1:23.4 readout — verifies expanded seconds coverage (0–59)", () => {
    fire(snap({ lapTime: 83.4 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(hasClip("/lap-time-minute/1.mp3")).toBe(true);
    expect(hasClip("/lap-time-second/23.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/4.mp3")).toBe(true);
  });

  it("plays a sub-1-min lap with seconds-component=34 (was out of scope in v1)", () => {
    fire(snap({ lapTime: 34.8 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.includes("/lap-time-minute/"))).toBe(false);
    expect(hasClip("/lap-time-second/34.mp3")).toBe(true);
    expect(hasClip("/lap-time-decimal/8.mp3")).toBe(true);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    lapTimeEnabled = false;
    fire(snap({ lapTime: 63.4 }));

    expect(voicePaths()).toEqual([]);
  });

  it("is suppressed on the final lap of a race when race-end fires (issue #569)", () => {
    raceFinished = true;
    fire(snap({ lapTime: 63.4, sessionType: "race" }));

    expect(voicePaths()).toEqual([]);
  });

  it("still fires on a race PB lap when race is not over", () => {
    raceFinished = false;
    fire(snap({ lapTime: 63.4, sessionType: "race" }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
  });

  it("still fires on a qualifying PB lap even if a stray latch reads true", () => {
    // The race-finished gate only suppresses race sessions — qualifying PBs
    // remain unaffected because the race-end callout doesn't exist there.
    raceFinished = true;
    fire(snap({ lapTime: 63.4, sessionType: "qualifying" }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
  });

  it("plays the readout immediately on lap.completed (no leading pause)", () => {
    // The 2-second leading pause was dropped when the diff moved from
    // counter-driven to LapLastLapTime-driven emission (issue #555 — the
    // refresh lag in the lap-time field already provides the post-S/F
    // breathing room the pause used to add artificially). This test pins
    // that the scenario doesn't wait before opening the radio.
    lastSnapshot = snap({ lapTime: 63.4 });
    bus.publishEvent("lap.completed", lastSnapshot as unknown as Record<string, unknown>);
    flush(audio);
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
  });

  it("reads the components in the script's order: intro, minute, seconds, tenths", () => {
    fire(snap({ lapTime: 63.4 }));

    expect(voicePaths().map((p) => p.split(`voice/${VOICE}/`)[1])).toEqual([
      "lap-time-intro/best-lap-yet.mp3",
      "lap-time-minute/1.mp3",
      "lap-time-second/3.mp3",
      "lap-time-decimal/4.mp3",
    ]);
  });

  it("a voice with no script plays no readout at all — no line, no frame (issue #1065)", () => {
    getScenarioEngine().setScripts(new Map([["titan", LAP_TIME_SCRIPT]]));

    fire(snap({ lapTime: 63.4 }));

    expect(audio._played).toEqual([]);
  });
});

describe("buildLapTimeContract (issue #1065)", () => {
  it("carries no sequence and keeps every scheduling field verbatim, taking the engine's default frame", () => {
    const c = buildLapTimeContract();

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.lap-time-best");
    expect(LAP_TIME_SCENARIO_IDS).toEqual([c.id]);
    expect(c.when?.event).toBe("lap.completed");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.family).toBe("lap-time");
    expect(c.weight).toBeUndefined();
    expect(c.interrupt).toBeUndefined();
    expect(c.queueable).toBeUndefined();
    expect(c.cooldown).toBeUndefined();
    expect(c.triggerDelay).toBeUndefined();
    expect(c.frame).toBeUndefined();
  });
});

describe("registerLapTimeVocabulary (issue #1065)", () => {
  it("publishes the four component vars and the minute gate, each with a description for a pack author", () => {
    const { vars, conds } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("lapTime.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "lapTime.decimal",
      "lapTime.intro",
      "lapTime.minute",
      "lapTime.second",
    ]);
    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["lapTime.hasMinuteComponent"]);

    for (const entry of [...vars, ...conds].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("lapTime.hasMinuteComponent is true from one minute up and false below it, or with no lap yet", () => {
    const cond = (lapTime: number | null) => {
      lastSnapshot = lapTime === null ? null : snap({ lapTime });

      // The registered predicate is what the script's `if` runs; reach it
      // through a fire rather than the registry so the test proves the wiring.
      audio._played.length = 0;

      if (lapTime !== null) fire(lastSnapshot);

      return voicePaths().some((p) => p.includes("/lap-time-minute/"));
    };

    expect(cond(59.9)).toBe(false);
    expect(cond(60.0)).toBe(true);
    expect(cond(94.8)).toBe(true);
  });
});

describe("the bundled script's lap-time entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Lap Time harness route and a sequence", () => {
    for (const id of LAP_TIME_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Lap Time → Best Lap 1:03\.4/);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("keeps the minute as a hard if — the spec's boundary case — and the other three components required", () => {
    expect(SCRIPT.scenarios["pit-crew.lap-time-best"].sequence).toEqual([
      "{{lapTime.intro}}",
      { if: "lapTime.hasMinuteComponent", then: ["{{lapTime.minute}}"] },
      "{{lapTime.second}}",
      "{{lapTime.decimal}}",
    ]);
  });

  it("references only vocabulary the lap-time family registers, and no pool, frame, fragment or alias", () => {
    const refs = collectScriptReferences(LAP_TIME_SCRIPT);
    const vocabulary = getScenarioEngine().vocabulary();

    expect(refs.vars).toEqual(["lapTime.decimal", "lapTime.intro", "lapTime.minute", "lapTime.second"]);
    expect(refs.conds).toEqual(["lapTime.hasMinuteComponent"]);
    expect(refs.cases).toEqual([]);
    expect(refs.pools).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(LAP_TIME_SCRIPT.pools ?? {})).toEqual([]);

    for (const v of refs.vars) expect(vocabulary.vars.map((x) => x.name)).toContain(v);

    for (const c of refs.conds) expect(vocabulary.conds.map((x) => x.name)).toContain(c);
  });

  it("publishes no direct clip source — every clip is a var's, and the bundled voice ships the four groups the vars draw from", () => {
    expect(LAP_TIME_CLIP_SOURCES).toEqual([]);

    for (const group of ["lap-time-intro", "lap-time-minute", "lap-time-second", "lap-time-decimal"]) {
      expect(
        MANIFEST.clips.some((clip) => clip.startsWith(`voice/${VOICE}/${group}/`)),
        `no voice/${VOICE}/${group}/ clip in manifest.json`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown var, condition or fragment", () => {
    const lapTimeWarnings = mockLogger.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("lap-time"));

    expect(lapTimeWarnings).toEqual([]);
  });
});
