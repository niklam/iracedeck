/**
 * Lap-time contract tests: the best lap (issue #555; scripted since #1065;
 * read to the thousandth since #1688) and every lap (issue #1163).
 *
 * Drives the contracts through the real scenario engine — same harness shape
 * as `session-start.test.ts` — with the bundled voices' REAL `callouts.json`
 * entries for the best lap, so var resolution runs the production compile +
 * expansion path; what the engineer says is the script's. The every-lap entry
 * is hand-built here, in the shape `lap-time.ts`'s header states, and so is
 * #555's full form, which no first-party script reads any more but the
 * vocabulary still publishes for pack scripts (#1688, decision 5).
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import shawnScript from "@iracedeck/audio-assets/voice/shawn/callouts.json" with { type: "json" };
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript } from "@iracedeck/callout-script";
import { LAP_TIME_CALLOUTS } from "@iracedeck/callout-settings";
import type {
  CountedLapCompleted,
  IEventBus,
  RefusedLapCompleted,
  SimEventName,
  SimEventOf,
} from "@iracedeck/event-bus";
import { classifySession } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ScenarioContext, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import { familyGate } from "./callout-gate.test-util.js";
import { familyReferences } from "./family-references.test-util.js";
import { registerPitCrew } from "./index.js";
import { splitLapTime } from "./lap-time-readout.js";
import {
  buildLapTimeContract,
  buildLapTimeLastContract,
  LAP_TIME_CLIP_SOURCES,
  LAP_TIME_SCENARIO_IDS,
  type LapCompletedSnapshot,
  registerLapTimeVocabulary,
  SCENARIO_ID_TO_LAP_TIME_ID,
} from "./lap-time.js";
import { _resetLimiterCueEngine } from "./limiter-cue-engine.js";
import { _resetPitExitCueEngine } from "./pit-exit-cue-engine.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

// The session the registration sees (#1378): a race.
const SIM_READS = { getSessionClass: () => classifySession("Race") };

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
/** The clock phrases, 1m00 to 10m59 only: an eleventh minute has no clip and aborts. */
const CLOCK_NAMES = MINUTE_NAMES.flatMap((m) => SECOND_NAMES.map((ss) => `${m}m${ss.padStart(2, "0")}`));
const THOUSANDTHS_NAMES = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, "0"));

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
    // clips that exist, not a code constant (issue #836): a twelfth minute
    // for the full form, one twelve-thirty clock phrase for the compact one.
    `voice/${VOICE}/lap-time-minute/12.mp3`,
    `voice/${VOICE}/lap-time-clock/12m30.mp3`,
    // The every-lap readout's clips (#1163).
    `voice/${VOICE}/lap-time-last/intro-01.mp3`,
    ...CLOCK_NAMES.map((n) => `voice/${VOICE}/lap-time-clock/${n}.mp3`),
    ...THOUSANDTHS_NAMES.map((n) => `voice/${VOICE}/lap-time-thousandths/${n}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The every-lap entry in the shape `lap-time.ts`'s header states (#1163,
 * revision 6 of the clip contract): the intro, one take that ends its
 * sentence, addressed as a pool, then the clock and the thousandths.
 */
const LAST_ENTRY = {
  comment: "Every lap, to the thousandth.",
  test: "Harness → Scenario Shortcuts → Lap Time → Every lap.",
  sequence: ["pool:lap-time-last/intro", "{{lapTime.clock}}", "{{lapTime.thousandths}}"],
};

/**
 * The bundled script narrowed to the best lap's own entry (and to no
 * fragments — it includes none): an entry for a contract this engine does
 * not hold is a `no contract` warn, and a foreign fragment would widen
 * `collectScriptReferences` under the assertions below.
 */
const BEST_LAP_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: { "pit-crew.lap-time-best": SCRIPT.scenarios["pit-crew.lap-time-best"] },
  fragments: {},
};

/** The script the fires run against: the bundled best-lap entry and the hand-built every-lap one. */
const LAP_TIME_SCRIPT: CalloutScript = {
  ...BEST_LAP_SCRIPT,
  scenarios: { ...BEST_LAP_SCRIPT.scenarios, "pit-crew.lap-time-last": LAST_ENTRY },
};

/** Both first-party voices' scripts; each one's best-lap entry runs over the test voice's clips. */
const BUNDLED_SCRIPTS: ReadonlyArray<{ voice: string; script: CalloutScript }> = [
  { voice: "default", script: SCRIPT },
  { voice: "shawn", script: shawnScript as CalloutScript },
];

/** The test script with `script`'s own best-lap entry and frames in place of the default voice's. */
function withBestLapOf(script: CalloutScript): CalloutScript {
  return {
    ...script,
    scenarios: {
      "pit-crew.lap-time-best": script.scenarios["pit-crew.lap-time-best"],
      "pit-crew.lap-time-last": LAST_ENTRY,
    },
    fragments: {},
  };
}

/**
 * #555's full form, the best-lap entry the first-party scripts carried before
 * #1688: what a pack script may still write, since its vars and condition
 * stay published (decision 5).
 */
const FULL_FORM_ENTRY = {
  comment: "A new best lap, in the full form.",
  test: "Harness → Scenario Shortcuts → Lap Time → Best Lap 1:23.456.",
  sequence: [
    "{{lapTime.intro}}",
    { if: "lapTime.hasMinuteComponent", then: ["{{lapTime.minute}}"] },
    "{{lapTime.second}}",
    "{{lapTime.decimal}}",
  ],
};

/** The test script with the full form as its best-lap entry, as a pack would write it. */
const FULL_FORM_SCRIPT: CalloutScript = {
  ...LAP_TIME_SCRIPT,
  scenarios: { ...LAP_TIME_SCRIPT.scenarios, "pit-crew.lap-time-best": FULL_FORM_ENTRY },
};

function snap(overrides: Partial<CountedLapCompleted> = {}): LapCompletedSnapshot {
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

/** A lap the sim did not count (#1582): no time, never a best, the standing best carried. */
function refused(overrides: Partial<RefusedLapCompleted> = {}): LapCompletedSnapshot {
  return {
    lap: 5,
    isBest: false,
    isFirstValid: false,
    lapIsValid: false,
    bestLapTime: 94.8,
    previousBestLapTime: 94.8,
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let lastSnapshot: LapCompletedSnapshot | null;
let lapTimeEnabled: boolean;
let everyLapEnabled: boolean;
let raceFinished: boolean;
let underCaution: boolean;

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
  everyLapEnabled = true;
  raceFinished = false;
  underCaution = false;
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    ...SIM_READS,
    logger: mockLogger as never,
    isCalloutEnabled: familyGate(LAP_TIME_CALLOUTS, (id) => (id === "every-lap" ? everyLapEnabled : lapTimeEnabled)),
    getLapCompletedSnapshot: () => lastSnapshot,
    getRaceFinishedFired: () => raceFinished,
    getUnderFullCourseCaution: () => underCaution,
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
  _resetPitExitCueEngine();
  _resetLimiterCueEngine();
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

/** The voice clips played, as `<group>/<base>`. */
function clips(): string[] {
  return voicePaths().map((p) => p.split(`voice/${VOICE}/`)[1].replace(/\.mp3$/, ""));
}

describe("lap-time scenario", () => {
  it("reads a 1:03.4 new personal best to the thousandth: the intro, the clock 1m03 and 400", () => {
    fire(snap({ lapTime: 63.4 }));

    expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-clock/1m03", "lap-time-thousandths/400"]);
  });

  it("reads a sub-minute lap from lap-time-second with no clock phrase (8.7)", () => {
    fire(snap({ lapTime: 8.7 }));

    expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-second/8", "lap-time-thousandths/700"]);
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
    everyLapEnabled = false;
    fire(snap({ lapTime: 63.4, isBest: false }));

    expect(voicePaths()).toEqual([]);
  });

  it("does not fire on a lap the sim did not count (#1582), with or without a time reported for it", () => {
    everyLapEnabled = false;
    fire(refused({ sessionType: "qualifying" }));
    fire(refused({ lap: 6, sessionType: "qualifying", lapTime: 63.4 }));

    expect(voicePaths()).toEqual([]);

    // The positive control: the same lap counted as a best is read out.
    fire(snap({ lap: 7, lapTime: 63.4, sessionType: "qualifying" }));
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
  });

  it("stays silent when the clock has no clip (11:05.5, no 11m05 staged)", () => {
    fire(snap({ lapTime: 665.5 }));

    expect(voicePaths()).toEqual([]);
  });

  it("speaks any clock that has a clip — no hardcoded minute bound (issue #836)", () => {
    // 12:30.5 — beyond the historical 10-minute constant, but 12m30 exists.
    fire(snap({ lapTime: 750.5 }));

    expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-clock/12m30", "lap-time-thousandths/500"]);
  });

  it("reads 1:23.456 as 1m23 and 456 — the third digit a best lap carries (#1688)", () => {
    fire(snap({ lapTime: 83.456 }));

    expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-clock/1m23", "lap-time-thousandths/456"]);
  });

  it("reads a sub-minute lap of 34.812 as thirty four and 812", () => {
    fire(snap({ lapTime: 34.812 }));

    expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-second/34", "lap-time-thousandths/812"]);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    lapTimeEnabled = false;
    everyLapEnabled = false;
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

  it("stays silent while a full-course caution is out (issue #1127) — a pace lap is not a lap time", () => {
    underCaution = true;
    fire(snap({ lapTime: 44.0 }));

    expect(voicePaths()).toEqual([]);
  });

  it("fires normally once the caution has cleared", () => {
    underCaution = false;
    fire(snap({ lapTime: 63.4 }));

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
  });

  it("stays silent for the lap that ENDS a caution — completed after the green, with the gate above open (R16)", () => {
    // The translator's fixture replay (`translator.test.ts`, "the lap that
    // ends a caution") is what produces this shape: the player's first
    // `lap.completed` after the 492.82 s restart carries `wasCaution: true`,
    // 3.3 s into the green with the caution gone.
    underCaution = false;
    fire(snap({ lapTime: 44.0, wasCaution: true }));

    expect(voicePaths()).toEqual([]);
  });

  it("fires on the next lap, run wholly under green, which carries no flag", () => {
    underCaution = false;
    fire(snap({ lapTime: 63.4 }));

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

  it("reads the components in the script's order: intro, clock, thousandths", () => {
    fire(snap({ lapTime: 63.4 }));

    expect(voicePaths().map((p) => p.split(`voice/${VOICE}/`)[1])).toEqual([
      "lap-time-intro/best-lap-yet.mp3",
      "lap-time-clock/1m03.mp3",
      "lap-time-thousandths/400.mp3",
    ]);
  });

  it("a voice with no script plays no readout at all — no line, no frame (issue #1065)", () => {
    getScenarioEngine().setScripts(new Map([["titan", LAP_TIME_SCRIPT]]));

    fire(snap({ lapTime: 63.4 }));

    expect(audio._played).toEqual([]);
  });
});

describe("both first-party voices read the best lap to the thousandth (#1688)", () => {
  for (const { voice, script } of BUNDLED_SCRIPTS) {
    describe(`voice "${voice}"`, () => {
      beforeEach(() => {
        getScenarioEngine().setScripts(new Map([[VOICE, withBestLapOf(script)]]));
      });

      it("reads a first valid lap as first-good-lap, the clock and the thousandths", () => {
        fire(snap({ lapTime: 127.007, isFirstValid: true, previousBestLapTime: undefined }));

        expect(clips()).toEqual(["lap-time-intro/first-good-lap", "lap-time-clock/2m07", "lap-time-thousandths/007"]);
      });

      it("reads a personal best as best-lap-yet, the clock and the thousandths", () => {
        fire(snap({ lapTime: 83.456 }));

        expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-clock/1m23", "lap-time-thousandths/456"]);
      });

      it("reads a personal best under a minute with the seconds word", () => {
        fire(snap({ lapTime: 34.812 }));

        expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-second/34", "lap-time-thousandths/812"]);
      });

      it("drops the whole line at the ceiling — 11:00.000 and 10:59.9996 — and 10:59.9994 still speaks", () => {
        fire(snap({ lapTime: 660.0 }));
        fire(snap({ lap: 6, lapTime: 659.9996, isFirstValid: true, previousBestLapTime: undefined }));

        // Nothing at all, not the intro alone: the whole line aborts.
        expect(voicePaths()).toEqual([]);

        fire(snap({ lap: 7, lapTime: 659.9994 }));
        expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-clock/10m59", "lap-time-thousandths/999"]);
      });
    });
  }
});

describe("#555's full form, kept for pack scripts (#1688, decision 5)", () => {
  beforeEach(() => {
    getScenarioEngine().setScripts(new Map([[VOICE, FULL_FORM_SCRIPT]]));
  });

  it("still reads a 1:03.4 best as minute, seconds and tenths, rounded to the tenth", () => {
    fire(snap({ lapTime: 63.44 }));

    expect(clips()).toEqual([
      "lap-time-intro/best-lap-yet",
      "lap-time-minute/1",
      "lap-time-second/3",
      "lap-time-decimal/4",
    ]);
  });

  it("still skips the minute for a lap under a minute (34.8)", () => {
    fire(snap({ lapTime: 34.8 }));

    expect(clips()).toEqual(["lap-time-intro/best-lap-yet", "lap-time-second/34", "lap-time-decimal/8"]);
  });

  it("still speaks any minute that has a clip, and drops the line at one that has none", () => {
    fire(snap({ lapTime: 750.5 }));
    expect(clips()).toEqual([
      "lap-time-intro/best-lap-yet",
      "lap-time-minute/12",
      "lap-time-second/30",
      "lap-time-decimal/5",
    ]);

    audio._played.length = 0;
    fire(snap({ lap: 6, lapTime: 665.5 }));
    expect(voicePaths()).toEqual([]);
  });
});

describe("buildLapTimeContract (issue #1065)", () => {
  it("carries no sequence and keeps every scheduling field verbatim, taking the engine's default frame", () => {
    const c = buildLapTimeContract();

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.lap-time-best");
    expect(LAP_TIME_SCENARIO_IDS).toContain(c.id);
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
  it("publishes the four component vars and the minute gate, and the every-lap readout's (#1163), each with a description for a pack author", () => {
    const { vars, conds } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("lapTime.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "lapTime.clock",
      "lapTime.decimal",
      "lapTime.intro",
      "lapTime.minute",
      "lapTime.second",
      "lapTime.thousandths",
    ]);
    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual([
      "lapTime.compactHasMinute",
      "lapTime.hasMinuteComponent",
      "lapTime.wasInvalid",
    ]);

    for (const entry of [...vars, ...conds].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("names in each every-lap var's description the clip groups it draws from, which the coverage tooling attributes clips by", () => {
    const { vars } = getScenarioEngine().vocabulary();
    const description = (name: string) => vars.find((v) => v.name === name)?.description ?? "";
    const groups: Readonly<Record<string, readonly string[]>> = {
      "lapTime.clock": ["lap-time-clock", "lap-time-second"],
      "lapTime.thousandths": ["lap-time-thousandths"],
    };

    for (const [name, named] of Object.entries(groups)) {
      for (const group of named) {
        expect(descriptionNamesGroup(description(name), group), `${name} names ${group}`).toBe(true);
      }
    }

    // The positive control: a group the var does not draw from is not named.
    expect(descriptionNamesGroup(description("lapTime.thousandths"), "lap-time-clock")).toBe(false);
  });

  it("lapTime.hasMinuteComponent is true from one minute up and false below it, or with no lap yet", () => {
    // Read through the full form, the one script shape that gates on it.
    getScenarioEngine().setScripts(new Map([[VOICE, FULL_FORM_SCRIPT]]));

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

describe("the bundled scripts' lap-time entry (issues #1065, #1688)", () => {
  it("scripts the best-lap contract with a comment, a Lap Time harness route and a sequence, in both voices", () => {
    for (const { voice, script } of BUNDLED_SCRIPTS) {
      const entry = script.scenarios["pit-crew.lap-time-best"];

      expect(entry, `${voice}: no script entry`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${voice}: comment`).toBeGreaterThan(0);
      // The harness labels the best-lap shortcuts read to the thousandth.
      expect(entry.test, `${voice}: test`).toMatch(
        /^Harness → Scenario Shortcuts → Lap Time → Best Lap 1:23\.456 \(Best Lap 0:34\.812 .*First Valid Lap 2:07\.007/,
      );
      expect(entry.skip).toBeUndefined();
    }
  });

  it("reads the best lap in the compact form, both halves required, in both voices", () => {
    for (const { voice, script } of BUNDLED_SCRIPTS) {
      expect(script.scenarios["pit-crew.lap-time-best"].sequence, voice).toEqual([
        "{{lapTime.intro}}",
        "{{lapTime.clock}}",
        "{{lapTime.thousandths}}",
      ]);
    }
  });

  it("references only vocabulary the lap-time family registers, and no pool, condition, frame, fragment or alias", () => {
    const vocabulary = getScenarioEngine().vocabulary();

    for (const { voice, script } of BUNDLED_SCRIPTS) {
      const refs = familyReferences(withBestLapOf(script));

      // The every-lap entry's vars and pool are the hand-built one's; the
      // best lap adds only its intro.
      expect(refs.vars, voice).toEqual(["lapTime.clock", "lapTime.intro", "lapTime.thousandths"]);
      expect(refs.conds, voice).toEqual([]);
      expect(refs.cases, voice).toEqual([]);
      expect(refs.pools, voice).toEqual(["lap-time-last/intro"]);
      expect(refs.frames, voice).toEqual([]);
      expect(refs.includes, voice).toEqual([]);

      for (const v of refs.vars) expect(vocabulary.vars.map((x) => x.name)).toContain(v);
    }

    expect(Object.keys(LAP_TIME_SCRIPT.pools ?? {})).toEqual([]);
  });

  it("publishes as its one direct clip source the every-lap intro, the only pool either entry addresses — and both bundled voices ship the four groups the best lap's vars draw from", () => {
    expect(LAP_TIME_CLIP_SOURCES).toEqual([{ group: "lap-time-last", base: "intro" }]);
    expect(familyReferences({ ...LAP_TIME_SCRIPT, scenarios: { "pit-crew.lap-time-last": LAST_ENTRY } }).pools).toEqual(
      LAP_TIME_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`),
    );

    let checked = 0;

    for (const { voice } of BUNDLED_SCRIPTS) {
      for (const group of ["lap-time-intro", "lap-time-clock", "lap-time-second", "lap-time-thousandths"]) {
        expect(
          MANIFEST.clips.some((clip) => clip.startsWith(`voice/${voice}/${group}/`)),
          `no voice/${voice}/${group}/ clip in manifest.json`,
        ).toBe(true);
        checked++;
      }
    }

    expect(checked).toBe(8);
  });

  it("compiles for the test voice with nothing skipped — no unknown var, condition or fragment", () => {
    const lapTimeWarnings = mockLogger.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("lap-time"));

    expect(lapTimeWarnings).toEqual([]);
  });
});

describe("the every-lap callout (issue #1163)", () => {
  /**
   * The clips the every-lap line played, as `<group>/<base>` with the intro's
   * take suffix dropped: from its intro on, the groups the readout draws from
   * (a best-lap line before it is left out, its `lap-time-second` included).
   */
  function lastLine(): string[] {
    const clips = voicePaths().map((p) =>
      p
        .split(`voice/${VOICE}/`)[1]
        .replace(/\.mp3$/, "")
        .replace(/^(lap-time-last\/intro)-\d\d$/, "$1"),
    );
    const start = clips.findIndex((c) => c.startsWith("lap-time-last/"));

    return start === -1 ? [] : clips.slice(start).filter((c) => /^lap-time-(last|second|clock|thousandths)\//.test(c));
  }

  /** A lap that is not a personal best, so the best-lap call does not own it. */
  const plain = (overrides: Partial<CountedLapCompleted> = {}): LapCompletedSnapshot =>
    snap({ isBest: false, isFirstValid: false, ...overrides });

  it("reads 1:23.456 as the intro, the clock phrase 1m23 and the thousandths 456", () => {
    fire(plain({ lapTime: 83.456 }));

    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/1m23", "lap-time-thousandths/456"]);
  });

  it("reads 1:23.450 with the base 450 — only the clip's text drops the zero", () => {
    fire(plain({ lapTime: 83.45 }));

    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/1m23", "lap-time-thousandths/450"]);
  });

  it("rounds once at the thousandth: 1:45.2374 is 237 and 1:45.2376 is 238", () => {
    fire(plain({ lapTime: 105.2374 }));
    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/1m45", "lap-time-thousandths/237"]);

    audio._played.length = 0;
    fire(plain({ lap: 6, lapTime: 105.2376 }));
    expect(lastLine().at(-1)).toBe("lap-time-thousandths/238");
  });

  it("reads 2:05.007 as 2m05 and 007", () => {
    fire(plain({ lapTime: 125.007 }));

    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/2m05", "lap-time-thousandths/007"]);
  });

  it("reads 10:00.000 as 10m00 and 000", () => {
    fire(plain({ lapTime: 600.0 }));

    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/10m00", "lap-time-thousandths/000"]);
  });

  it("reads a sub-minute lap from lap-time-second with no clock phrase (58.041)", () => {
    fire(plain({ lapTime: 58.041 }));

    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-second/58", "lap-time-thousandths/041"]);
  });

  it("reads 59.9996 as the minute it rounds into: 1m00 and 000", () => {
    fire(plain({ lapTime: 59.9996 }));

    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/1m00", "lap-time-thousandths/000"]);
  });

  it("aborts 10:59.9996, which rounds into an eleventh minute no clip covers — 10:59.9994 still speaks", () => {
    fire(plain({ lapTime: 659.9996 }));
    expect(voicePaths()).toEqual([]);

    fire(plain({ lap: 6, lapTime: 659.9994 }));
    expect(lastLine()).toEqual(["lap-time-last/intro", "lap-time-clock/10m59", "lap-time-thousandths/999"]);
  });

  it("opens with the one intro whatever the time opens with — the intro ends its sentence", () => {
    const times = [83.4, 125.0, 58.0, 245.0, 15.2, 0.9, 5.0, 9.9, 11.3];

    times.forEach((lapTime, i) => {
      audio._played.length = 0;
      fire(plain({ lap: 10 + i, lapTime }));

      // The intro plays once and the clock follows it (the positive control:
      // the line spoke at all), whatever the time's first word.
      expect(
        lastLine().filter((c) => c.startsWith("lap-time-last/")),
        String(lapTime),
      ).toEqual(["lap-time-last/intro"]);
      expect(lastLine()[1], String(lapTime)).toMatch(/^lap-time-(clock|second)\//);
    });
  });

  it("does not speak a personal best, which the best-lap call owns — and does once the best-lap call is off", () => {
    fire(snap({ lapTime: 63.4 }));
    expect(lastLine()).toEqual([]);
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);

    audio._played.length = 0;
    lapTimeEnabled = false;
    fire(snap({ lap: 6, lapTime: 63.4 }));
    expect(lastLine()[0]).toBe("lap-time-last/intro");
    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(false);
  });

  it("is silent on an out lap and an in lap, and speaks the same lap without either flag", () => {
    fire(plain({ lapTime: 95.1, isOutLap: true }));
    fire(plain({ lap: 6, lapTime: 95.1, isInLap: true }));
    expect(voicePaths()).toEqual([]);

    fire(plain({ lap: 7, lapTime: 95.1 }));
    expect(lastLine()[0]).toBe("lap-time-last/intro");
  });

  it("is silent on the final lap of a race, under a caution and on the lap that ends one", () => {
    raceFinished = true;
    fire(plain({ lapTime: 95.1, sessionType: "race" }));
    raceFinished = false;
    underCaution = true;
    fire(plain({ lap: 6, lapTime: 95.1 }));
    underCaution = false;
    fire(plain({ lap: 7, lapTime: 95.1, wasCaution: true }));

    expect(voicePaths()).toEqual([]);
  });

  it("speaks in practice and qualifying", () => {
    fire(plain({ lapTime: 95.1, sessionType: "practice" }));
    expect(lastLine()[0]).toBe("lap-time-last/intro");

    audio._played.length = 0;
    fire(plain({ lap: 6, lapTime: 95.1, sessionType: "qualifying" }));
    expect(lastLine()[0]).toBe("lap-time-last/intro");
  });

  it("is silent on a lap the sim did not count (#1582), with or without a time reported for it", () => {
    fire(refused({ sessionType: "qualifying" }));
    fire(refused({ lap: 6, sessionType: "race" }));
    fire(refused({ lap: 7, sessionType: "practice", lapTime: 95.1 }));

    expect(voicePaths()).toEqual([]);

    // The positive control: the next lap, counted, is read out.
    fire(plain({ lap: 8, lapTime: 95.1, sessionType: "practice" }));
    expect(lastLine()[0]).toBe("lap-time-last/intro");
  });

  it("is silent with its own opt-in off", () => {
    everyLapEnabled = false;
    fire(plain({ lapTime: 95.1 }));

    expect(voicePaths()).toEqual([]);
  });

  it("drops a lap time that waited out a busy line once the driver has completed another lap", () => {
    // A best lap takes the bus (NORMAL); the next lap's time queues behind it.
    lastSnapshot = snap({ lap: 4, lapTime: 63.4 });
    bus.publishEvent("lap.completed", lastSnapshot as unknown as Record<string, unknown>);
    lastSnapshot = plain({ lap: 5, lapTime: 95.1 });
    bus.publishEvent("lap.completed", lastSnapshot as unknown as Record<string, unknown>);
    // The driver completes lap 6 before the radio frees up.
    lastSnapshot = plain({ lap: 6, lapTime: 95.4 });
    flush(audio);

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(lastLine()).toEqual([]);
  });

  it("speaks the waiting lap time when no newer lap has completed (the positive control)", () => {
    lastSnapshot = snap({ lap: 4, lapTime: 63.4 });
    bus.publishEvent("lap.completed", lastSnapshot as unknown as Record<string, unknown>);
    lastSnapshot = plain({ lap: 5, lapTime: 95.1 });
    bus.publishEvent("lap.completed", lastSnapshot as unknown as Record<string, unknown>);
    flush(audio);

    expect(hasClip("/lap-time-intro/best-lap-yet.mp3")).toBe(true);
    expect(lastLine()[0]).toBe("lap-time-last/intro");
  });
});

describe("buildLapTimeLastContract (issue #1163)", () => {
  const plainLap = (lap: number): LapCompletedSnapshot => snap({ lap, isBest: false });
  const deps = (latest: LapCompletedSnapshot | null) => ({
    getRaceFinishedFired: () => false,
    getUnderFullCourseCaution: () => false,
    getLapOwner: () => "every-lap" as const,
    getLapCompletedSnapshot: () => latest,
  });

  it("carries the scheduling #1163 decides: chatter weight, queueable, its own family, a speak-time gate", () => {
    const c = buildLapTimeLastContract(deps(null));

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.lap-time-last");
    expect(c.when?.event).toBe("lap.completed");
    expect(c.weight).toBe(WEIGHT.CHATTER);
    expect(c.queueable).toBe(true);
    expect(c.family).toBe("lap-time-last");
    expect(c.interrupt).toBeUndefined();
    expect(c.speakGate?.description.length ?? 0).toBeGreaterThan(0);
    expect(SCENARIO_ID_TO_LAP_TIME_ID[c.id]).toBe("every-lap");
    expect(LAP_TIME_SCENARIO_IDS).toEqual(["pit-crew.lap-time-best", c.id]);
  });

  it("admits while the latest lap is the fire's own or none, and refuses once a later lap completed", () => {
    const ctx = (lap: number) =>
      ({ event: { event: "lap.completed" }, data: { lap }, telemetry: null, now: 0 }) as never;

    expect(buildLapTimeLastContract(deps(null)).speakGate?.admit(ctx(5))).toBe(true);
    expect(buildLapTimeLastContract(deps(plainLap(5))).speakGate?.admit(ctx(5))).toBe(true);
    expect(buildLapTimeLastContract(deps(plainLap(6))).speakGate?.admit(ctx(5))).toBe(false);
  });

  it("asks the owner, and fires only on a lap it owns", () => {
    const owned = buildLapTimeLastContract(deps(null));
    const notOwned = buildLapTimeLastContract({ ...deps(null), getLapOwner: () => "best-lap" as const });
    const ev = { event: "lap.completed", data: snap({ isBest: false }), timestamp: 0, telemetry: null } as never;

    expect(owned.when?.where?.(ev)).toBe(true);
    expect(notOwned.when?.where?.(ev)).toBe(false);
  });
});

describe("every lapTime var reads the fire's own lap (#1688)", () => {
  type Resolver = (ctx: ScenarioContext) => unknown;

  /** Every var and condition the vocabulary registers, over a snapshot that is `latest`. */
  function vocabulary(latest: LapCompletedSnapshot | null): Map<string, Resolver> {
    const resolvers = new Map<string, Resolver>();

    registerLapTimeVocabulary(
      {
        defineVar: (name: string, resolver: Resolver) => resolvers.set(name, resolver),
        defineCond: (name: string, predicate: Resolver) => resolvers.set(name, predicate),
      } as never,
      () => latest,
    );

    return resolvers;
  }

  /** A fire of `lap`'s own `lap.completed`, or `null` for a fire with no lap event. */
  function ctxOf(lap: LapCompletedSnapshot | null): ScenarioContext {
    return {
      event: lap
        ? ({ event: "lap.completed", timestamp: 0, telemetry: null, data: lap } as unknown as ScenarioContext["event"])
        : null,
      telemetry: null,
      data: lap,
      now: 0,
      vars: {},
    };
  }

  // The best-lap line waited behind another one, and a newer lap completed
  // before it spoke: the snapshot is that newer lap, a plain one under a
  // minute, while the fire is the session's first valid lap.
  const fired = snap({ lap: 1, lapTime: 127.007, isFirstValid: true, previousBestLapTime: undefined });
  const newer = snap({ lap: 2, lapTime: 58.041, isBest: false, isFirstValid: false });

  it("reads intro, clock and thousandths from the fire's lap, not the newer snapshot", () => {
    const v = vocabulary(newer);
    const ctx = ctxOf(fired);

    expect(v.get("lapTime.intro")?.(ctx)).toBe("pool:lap-time-intro/first-good-lap");
    expect(v.get("lapTime.clock")?.(ctx)).toBe("pool:lap-time-clock/2m07");
    expect(v.get("lapTime.thousandths")?.(ctx)).toBe("pool:lap-time-thousandths/007");
  });

  it("reads #555's full form from the fire's lap too, so a pack script's line agrees with itself", () => {
    const v = vocabulary(newer);
    const ctx = ctxOf(fired);

    expect(v.get("lapTime.minute")?.(ctx)).toBe("pool:lap-time-minute/2");
    expect(v.get("lapTime.second")?.(ctx)).toBe("pool:lap-time-second/7");
    expect(v.get("lapTime.decimal")?.(ctx)).toBe("pool:lap-time-decimal/0");
    expect(v.get("lapTime.hasMinuteComponent")?.(ctx)).toBe(true);
  });

  it("falls back to the snapshot only for a fire with no lap event (the positive control)", () => {
    const v = vocabulary(newer);
    const ctx = ctxOf(null);

    expect(v.get("lapTime.intro")?.(ctx)).toBe("pool:lap-time-intro/best-lap-yet");
    expect(v.get("lapTime.clock")?.(ctx)).toBe("pool:lap-time-second/58");
    expect(v.get("lapTime.second")?.(ctx)).toBe("pool:lap-time-second/58");
    expect(v.get("lapTime.hasMinuteComponent")?.(ctx)).toBe(false);
  });
});

describe("each first-party voice ships every clip its best-lap line can name (#1688)", () => {
  // The fires above run every script over this file's own fixture clips, under
  // one voice; this holds each voice's real clips to the line instead, since
  // the coverage test skips var-driven groups whole.
  const clips = new Set(MANIFEST.clips);
  const expected = (voice: string): string[] => [
    ...INTRO_NAMES.map((n) => `voice/${voice}/lap-time-intro/${n}.mp3`),
    ...CLOCK_NAMES.map((n) => `voice/${voice}/lap-time-clock/${n}.mp3`),
    ...SECOND_NAMES.map((n) => `voice/${voice}/lap-time-second/${n}.mp3`),
    ...THOUSANDTHS_NAMES.map((n) => `voice/${voice}/lap-time-thousandths/${n}.mp3`),
  ];

  for (const { voice } of BUNDLED_SCRIPTS) {
    it(`voice "${voice}": both intros, every clock 1:00–10:59, every second and every thousandth`, () => {
      const wanted = expected(voice);

      expect(wanted).toHaveLength(2 + 600 + 60 + 1000);
      expect(wanted.filter((c) => !clips.has(c))).toEqual([]);
    });
  }

  it("the positive control: a voice the manifest does not carry misses every one", () => {
    expect(expected("no-such-voice").filter((c) => !clips.has(c))).toHaveLength(2 + 600 + 60 + 1000);
  });
});
