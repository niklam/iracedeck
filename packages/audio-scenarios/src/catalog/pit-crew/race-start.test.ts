/**
 * Race-start greeting + qualifying-position readout tests (issue #568;
 * scripted since #1065).
 *
 * Drives the contract through the real scenario engine — same harness shape
 * as `session-start.test.ts` — with the bundled voice's REAL `callouts.json`
 * narrowed to this family's entry, so var resolution, the optional clauses
 * and the grid-position case all run the production compile + expansion
 * path. The snapshot is read from a resolver closure (`currentSnapshot`) at
 * fire time.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences, type ScriptStep } from "@iracedeck/callout-script";
import type { IEventBus, RaceStartSnapshot, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import { SessionState } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import {
  _resetAudioScenarios,
  getScenarioEngine,
  initializeAudioScenarios,
  poolMemberPattern,
} from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  buildRaceStartContract,
  describeMissingStartConditions,
  isRaceSession,
  RACE_START_CLIP_SOURCES,
  RACE_START_DELAY_MS,
  RACE_START_GRID_POSITION_KEYS,
  RACE_START_SCENARIO_IDS,
  registerRaceStartVocabulary,
  resolveRaceStartGridPosition,
  START_BRIEF_SETTLE_MAX_MS,
  START_BRIEF_SETTLE_POLL_MS,
} from "./race-start.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";
import { temperatureClipName } from "./temperature-number.js";

const mockSessionType = vi.fn<() => string>(() => "Race");

const mockLatestTelemetry = vi.fn<() => Record<string, unknown> | null>(() => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
  getLatestTelemetry: () => mockLatestTelemetry(),
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

function createMockBus(): IEventBus & {
  publishEvent: (name: SimEventName, data: Record<string, unknown>, telemetry?: unknown) => void;
} {
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
    publishEvent(name: SimEventName, data: Record<string, unknown>, telemetry?: unknown) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: (telemetry ?? null) as unknown,
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

const VOICE = "luca";

const WETNESS_SUFFIXES = [
  "dry",
  "mostly-dry",
  "very-lightly-wet",
  "lightly-wet",
  "moderately-wet",
  "very-wet",
  "extremely-wet",
] as const;

const SESSION_START_CLIPS = [
  "track-temp-intro",
  "air-temp-intro",
  "wetness-intro",
  ...WETNESS_SUFFIXES.map((s) => `wetness-${s}`),
];

const RACE_START_CLIPS = ["starting-from-pole-01", "qualifying-put-us-to-01"];

const GREETING_NAMES = ["niklas", "driver"];

// The temperature figures the bundled voice records (issue #1187): -20 … 176,
// below zero named minus<N>.
const TEMP_CLIP_NAMES = Array.from({ length: 197 }, (_, i) => temperatureClipName(i - 20));

// A voice with only the "driver" greeting, no setup-warning clips and no
// conditions-still-unknown line — exercises the optional-clause skips (issue
// #835), and the unknown-wetness branch being optional (issue #1284).
const BARE_VOICE = "bare";

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...GREETING_NAMES.map((n) => `voice/${VOICE}/race-start-greeting/${n}.mp3`),
    ...RACE_START_CLIPS.map((c) => `voice/${VOICE}/race-start/${c}.mp3`),
    ...SESSION_START_CLIPS.map((c) => `voice/${VOICE}/session-start/${c}.mp3`),
    // The conditions-still-unknown line (issue #1284).
    `voice/${VOICE}/session-start/wetness-unknown-01.mp3`,
    // The optional unit-only clips a pack may record (issue #1187); the
    // bundled voice has none.
    `voice/${VOICE}/session-start/unit-celsius.mp3`,
    `voice/${VOICE}/session-start/unit-fahrenheit.mp3`,
    // The race-start scenario speaks integer temps from the numbers-degrees
    // group the session-start brief also draws (issue #1187). Stage the same
    // -20..176 range as the session-start tests.
    ...TEMP_CLIP_NAMES.map((n) => `voice/${VOICE}/numbers-degrees/${n}.mp3`),
    // Position numbers — reused from the existing position-number group
    // (issue #566). 1..64 covers the entire speakable range.
    ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
    // Beyond the historical 64-position bound — speakability derives from the
    // clips that exist, not a code constant (issue #836).
    `voice/${VOICE}/position-number/70.mp3`,
    `voice/${VOICE}/setup-warning/qualifying-01.mp3`,
    `voice/${VOICE}/setup-warning/race-01.mp3`,
    `voice/${BARE_VOICE}/race-start-greeting/driver.mp3`,
    ...RACE_START_CLIPS.map((c) => `voice/${BARE_VOICE}/race-start/${c}.mp3`),
    ...SESSION_START_CLIPS.map((c) => `voice/${BARE_VOICE}/session-start/${c}.mp3`),
    ...TEMP_CLIP_NAMES.map((n) => `voice/${BARE_VOICE}/numbers-degrees/${n}.mp3`),
    ...Array.from({ length: 64 }, (_, i) => `voice/${BARE_VOICE}/position-number/${i + 1}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entry — handed to both
 * test voices, so the per-voice clip availability tests below read the same
 * body against two clip sets. `fragments` is narrowed too (to none): the
 * entry includes none, and `collectScriptReferences` walks every fragment it
 * is given, so another family's fragment would otherwise widen the
 * reference set under the assertions below.
 */
const RACE_START_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(RACE_START_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

/**
 * `script` with `{{<varPrefix>.degreesUnit}}` appended to each temperature
 * clause — what a pack that wants its engineer to say the unit writes. The
 * bundled voice records no unit clip and never names the var (issue #1187).
 */
function withUnitStep(script: CalloutScript, id: string, varPrefix: string): CalloutScript {
  const entry = script.scenarios[id];
  const sequence = (entry.sequence ?? []).map((step): ScriptStep =>
    typeof step === "object" &&
    "optional" in step &&
    step.optional.some((s) => typeof s === "string" && /TempNumber/.test(s))
      ? { optional: [...step.optional, `{{${varPrefix}.degreesUnit}}`] }
      : step,
  );

  return { ...script, scenarios: { ...script.scenarios, [id]: { ...entry, sequence } } };
}

const BASE_SNAPSHOT: RaceStartSnapshot = {
  driverName: "niklas",
  trackTemp: 28,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: TrackWetness.MostlyDry,
  playerCarPosition: 7,
};

function snap(overrides: Partial<RaceStartSnapshot> = {}): RaceStartSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentSnapshot: RaceStartSnapshot | null;
let raceStartEnabled: boolean;
let masterEnabled: boolean;
let setupWarningMismatch: (kind: "qualifying" | "race") => boolean;

function fire(
  snapshot: RaceStartSnapshot | null,
  data: { from: number; to: number } = { from: 0, to: 1 },
  telemetry?: Record<string, unknown>,
): void {
  currentSnapshot = snapshot;
  bus.publishEvent("session.changed", data, telemetry);
  flush(audio);
}

/** Publishes `session.changed` without advancing time — for the settle-wait tests that step the clock themselves. */
function publish(
  snapshot: RaceStartSnapshot | null,
  data: { from: number; to: number } = { from: 0, to: 1 },
  telemetry?: Record<string, unknown>,
): void {
  currentSnapshot = snapshot;
  bus.publishEvent("session.changed", data, telemetry);
}

/** Every message logged at info so far. */
function infoMessages(): string[] {
  return mockLogger.info.mock.calls.map(([message]) => String(message));
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function hasClip(suffix: string): boolean {
  return voicePaths().some((p) => p.endsWith(suffix));
}

let activeVoice: string;

beforeEach(() => {
  vi.useFakeTimers();
  currentSnapshot = null;
  raceStartEnabled = true;
  masterEnabled = true;
  mockLatestTelemetry.mockReturnValue(null);
  setupWarningMismatch = () => false;
  activeVoice = VOICE;
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getRaceEngineerMasterEnabled: () => masterEnabled,
    getRaceStartCalloutEnabled: () => raceStartEnabled,
    getRaceStartSnapshot: () => currentSnapshot,
    getSetupWarningMismatch: (kind) => setupWarningMismatch(kind),
  });
  // After the registration, as the plugins do: the brief's body is looked up
  // in the active voice's compiled script at fire time (issue #1065).
  getScenarioEngine().setScripts(new Map([VOICE, BARE_VOICE].map((v) => [v, RACE_START_SCRIPT])));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("isRaceSession", () => {
  it("returns true for race-typed sessions", () => {
    expect(isRaceSession("Race")).toBe(true);
    expect(isRaceSession("Warmup")).toBe(true); // warmup falls into the race bucket
  });

  it("returns false for practice / qualifying / testing", () => {
    expect(isRaceSession("Practice")).toBe(false);
    expect(isRaceSession("Lone Practice")).toBe(false);
    expect(isRaceSession("Offline Testing")).toBe(false);
    expect(isRaceSession("Open Qualify")).toBe(false);
    expect(isRaceSession("Lone Qualify")).toBe(false);
  });
});

describe("per-voice clip availability (issue #835)", () => {
  it("skips the setup-warning nudge for a voice with no setup-warning clips, playing the rest", () => {
    activeVoice = BARE_VOICE;
    setupWarningMismatch = (kind) => kind === "race";
    fire(snap({ driverName: "driver" }));

    expect(voicePaths().some((p) => p.includes("setup-warning"))).toBe(false);
    expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
  });

  it("skips the greeting for a voice lacking the picked name clip, playing the rest", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ driverName: "niklas" }));

    expect(voicePaths().some((p) => p.includes("race-start-greeting"))).toBe(false);
    expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
  });
});

describe("race-start scenario", () => {
  it("plays the full readout on session.changed in race sessions", () => {
    fire(snap());

    expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-number/7.mp3")).toBe(true);
    expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
    expect(hasClip("/numbers-degrees/28.mp3")).toBe(true);
    expect(hasClip("/session-start/air-temp-intro.mp3")).toBe(true);
    expect(hasClip("/numbers-degrees/20.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
  });

  it("waits RACE_START_DELAY_MS before any audio plays", () => {
    currentSnapshot = snap();
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    // Nothing plays during the delay window.
    vi.advanceTimersByTime(RACE_START_DELAY_MS - 100);
    expect(voicePaths()).toEqual([]);

    // Once the delay elapses the readout begins.
    flush(audio);
    expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
  });

  // Regression: where: is implemented as `triggerDelay` rather than a leading
  // `{ pause }` step so the where: predicate and var resolvers see telemetry
  // that has had time to settle. iRacing's `session.changed` lands on a tick
  // where `TrackWetness` can briefly read `Unknown`; a leading pause inside
  // the sequence wouldn't help because vars are resolved at expansion time
  // (synchronously when the immediate where: returns true).
  it("re-evaluates where: at the deferred fire time, not at event arrival", () => {
    // Snapshot is null at event arrival — would cause an immediate where: to
    // reject. But triggerDelay defers the check, so we can populate the
    // snapshot during the wait window.
    currentSnapshot = null;
    bus.publishEvent("session.changed", { from: 0, to: 1 });

    // Mid-wait: snapshot becomes valid (simulating telemetry settling).
    vi.advanceTimersByTime(RACE_START_DELAY_MS - 1000);
    currentSnapshot = snap();

    // Complete the delay — where: should re-evaluate and now pass.
    flush(audio);

    expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
  });

  it("does not fire when the snapshot resolver returns null", () => {
    fire(null);

    expect(voicePaths()).toEqual([]);
  });

  it("does not fire in non-race sessions", () => {
    mockSessionType.mockReturnValue("Open Qualify");
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  it("does not fire in practice sessions", () => {
    mockSessionType.mockReturnValue("Lone Practice");
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    raceStartEnabled = false;
    fire(snap());

    expect(voicePaths()).toEqual([]);
  });

  describe("position clause", () => {
    it("P1 picks the pole branch (single clip — no composed number)", () => {
      fire(snap({ playerCarPosition: 1 }));

      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(true);
      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(false);
      // No position number for pole.
      expect(voicePaths().some((p) => p.includes("/position-number/"))).toBe(false);
    });

    it("P2 picks the composed branch", () => {
      fire(snap({ playerCarPosition: 2 }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(true);
      expect(hasClip("/position-number/2.mp3")).toBe(true);
      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(false);
    });

    it("speaks any position that has a clip — no hardcoded bound (issue #836)", () => {
      fire(snap({ playerCarPosition: 70 }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(true);
      expect(hasClip("/position-number/70.mp3")).toBe(true);
    });

    it("skips the position clause entirely when the position has no clip (greeting + conditions still play)", () => {
      fire(snap({ playerCarPosition: 65 }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(false);
      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(false);
      expect(voicePaths().some((p) => p.includes("/position-number/"))).toBe(false);
      // Greeting + conditions still play.
      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
      expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(true);
    });

    it("skips the position clause entirely when position is missing", () => {
      fire(snap({ playerCarPosition: undefined }));

      expect(hasClip("/race-start/qualifying-put-us-to-01.mp3")).toBe(false);
      expect(hasClip("/race-start/starting-from-pole-01.mp3")).toBe(false);
      // Greeting + conditions still play.
      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
      expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    });
  });

  describe("driver name resolution", () => {
    it("falls back to driver when the snapshot name is empty", () => {
      fire(snap({ driverName: "" }));

      expect(hasClip("/race-start-greeting/driver.mp3")).toBe(true);
    });
  });

  describe("conditions readout", () => {
    it.each(WETNESS_SUFFIXES)("speaks wetness-%s", (suffix) => {
      const wetnessByLabel: Record<(typeof WETNESS_SUFFIXES)[number], TrackWetness> = {
        dry: TrackWetness.Dry,
        "mostly-dry": TrackWetness.MostlyDry,
        "very-lightly-wet": TrackWetness.VeryLightlyWet,
        "lightly-wet": TrackWetness.LightlyWet,
        "moderately-wet": TrackWetness.ModeratelyWet,
        "very-wet": TrackWetness.VeryWet,
        "extremely-wet": TrackWetness.ExtremelyWet,
      };

      fire(snap({ wetness: wetnessByLabel[suffix] }));

      expect(hasClip(`/session-start/wetness-${suffix}.mp3`)).toBe(true);
    });

    it("reads a Fahrenheit figure from the same degrees group (issue #1187)", () => {
      fire(snap({ tempUnit: "fahrenheit", trackTemp: 150, airTemp: 68 }));

      expect(hasClip("/numbers-degrees/150.mp3")).toBe(true);
      expect(hasClip("/numbers-degrees/68.mp3")).toBe(true);
    });

    it("reads a below-zero temperature as a minus clip, never a hyphenated name (issue #1187)", () => {
      fire(snap({ trackTemp: -4, airTemp: -20 }));

      expect(hasClip("/numbers-degrees/minus4.mp3")).toBe(true);
      expect(hasClip("/numbers-degrees/minus20.mp3")).toBe(true);
      expect(voicePaths().some((p) => p.includes("numbers-degrees/-"))).toBe(false);
    });

    it.each([
      ["celsius", "unit-celsius"],
      ["fahrenheit", "unit-fahrenheit"],
    ] as const)(
      "a pack that adds the unit step hears the unit-only clip for %s after each figure (issue #1187)",
      (tempUnit, clip) => {
        getScenarioEngine().setScripts(
          new Map([[VOICE, withUnitStep(RACE_START_SCRIPT, "pit-crew.race-start", "raceStart")]]),
        );
        fire(snap({ tempUnit, trackTemp: 28, airTemp: 20 }));

        const played = voicePaths().map((p) => p.split(`voice/${VOICE}/`)[1]);

        expect(played).toContain(`session-start/${clip}.mp3`);
        expect(played.indexOf("numbers-degrees/28.mp3") + 1).toBe(played.indexOf(`session-start/${clip}.mp3`));
        expect(played.filter((p) => p === `session-start/${clip}.mp3`)).toHaveLength(2);
      },
    );

    it("the bundled script says no unit word", () => {
      fire(snap({ tempUnit: "fahrenheit" }));

      expect(voicePaths().some((p) => /session-start\/unit-/.test(p))).toBe(false);
    });

    it("skips a temp clause whose reading has no clip (no clamping, issue #836), keeping the rest", () => {
      fire(snap({ trackTemp: 999, airTemp: 20 }));

      expect(hasClip("/session-start/track-temp-intro.mp3")).toBe(false);
      expect(voicePaths().some((p) => p.includes("numbers-degrees/999"))).toBe(false);
      expect(voicePaths().some((p) => p.includes("numbers-degrees/176"))).toBe(false);
      // The air-temp clause and the wetness readout still play.
      expect(hasClip("/session-start/air-temp-intro.mp3")).toBe(true);
      expect(hasClip("/numbers-degrees/20.mp3")).toBe(true);
      expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    });
  });

  describe("setup-warning clause (issue #625)", () => {
    it("appends the race warning when the resolver reports a mismatch", () => {
      setupWarningMismatch = (kind) => kind === "race";
      fire(snap());

      expect(hasClip("/setup-warning/race-01.mp3")).toBe(true);
      // The rest of the readout still plays — the clause is appended, not a replacement.
      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
      expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
    });

    it("is silent when the resolver reports no mismatch", () => {
      setupWarningMismatch = () => false;
      fire(snap());

      expect(hasClip("/setup-warning/race-01.mp3")).toBe(false);
    });
  });

  // Issue #871: the translator's fresh-connect synthesis marks itself with
  // `from: -1`. A fresh connect into a race already underway (post-green or
  // post-race) must not replay the grid brief; a pre-green grid restart still
  // briefs (starting position + conditions are still actionable), and genuine
  // transitions (`from >= 0`) are untouched. Defense-in-depth: the translator
  // already latches silently on a race + Racing connect, but the scenario owns
  // its own firing conditions for harness-fired events.
  describe("mid-session fresh-connect suppression (issue #871)", () => {
    it("suppresses the brief on a synthetic fresh connect with the race underway (Racing)", () => {
      fire(snap(), { from: -1, to: 1 }, { SessionState: SessionState.Racing });

      expect(voicePaths()).toEqual([]);
    });

    it("suppresses the brief on a synthetic fresh connect after the race (Checkered)", () => {
      fire(snap(), { from: -1, to: 1 }, { SessionState: SessionState.Checkered });

      expect(voicePaths()).toEqual([]);
    });

    it("suppresses the brief on a synthetic fresh connect during cool-down (CoolDown)", () => {
      fire(snap(), { from: -1, to: 1 }, { SessionState: SessionState.CoolDown });

      expect(voicePaths()).toEqual([]);
    });

    it("still briefs on a synthetic fresh connect on the pre-green grid (Warmup)", () => {
      fire(snap(), { from: -1, to: 1 }, { SessionState: SessionState.Warmup });

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });

    it("still briefs on a genuine session transition when the state reads Racing", () => {
      fire(snap(), { from: 0, to: 1 }, { SessionState: SessionState.Racing });

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });

    it("briefs on a synthetic fresh connect with no telemetry attached (don't punish missing data)", () => {
      fire(snap(), { from: -1, to: 1 });

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });

    // Issue #1284: the settle wait can hold the fire for up to 10 s, so a
    // connect during the parade laps can see the green fly before the brief
    // would speak. The gate asks the live telemetry at decision time too.
    it("suppresses a parade-lap connect whose live telemetry reads Racing by the time it decides (the green flew during the wait)", () => {
      mockLatestTelemetry.mockReturnValue({ SessionState: SessionState.Racing });
      fire(snap(), { from: -1, to: 1 }, { SessionState: SessionState.ParadeLaps });

      expect(voicePaths()).toEqual([]);
      expect(infoMessages()).toContainEqual(
        expect.stringContaining("race-start where: rejected — fresh connect into a race already underway"),
      );
    });

    it("still briefs on a synthetic fresh connect when both the connect tick and the live telemetry read Warmup", () => {
      mockLatestTelemetry.mockReturnValue({ SessionState: SessionState.Warmup });
      fire(snap(), { from: -1, to: 1 }, { SessionState: SessionState.Warmup });

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });

    it("still briefs on a genuine transition even when the live telemetry reads Racing", () => {
      mockLatestTelemetry.mockReturnValue({ SessionState: SessionState.Racing });
      fire(snap(), { from: 0, to: 1 }, { SessionState: SessionState.Warmup });

      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
    });
  });

  describe("scripted delivery (issue #1065)", () => {
    it("reads the clauses in the script's order, inside the engine's radio frame", () => {
      setupWarningMismatch = (kind) => kind === "race";
      fire(snap({ playerCarPosition: 7 }));

      expect(voicePaths().map((p) => p.split(`voice/${VOICE}/`)[1])).toEqual([
        "race-start-greeting/niklas.mp3",
        "race-start/qualifying-put-us-to-01.mp3",
        "position-number/7.mp3",
        "session-start/track-temp-intro.mp3",
        "numbers-degrees/28.mp3",
        "session-start/air-temp-intro.mp3",
        "numbers-degrees/20.mp3",
        "session-start/wetness-intro.mp3",
        "session-start/wetness-mostly-dry.mp3",
        "setup-warning/race-01.mp3",
      ]);
      expect(audio._played[0]?.path).toBe("sfx/IRD-tick-open.mp3");
      expect(audio._played.at(-1)?.path).toBe("sfx/IRD-tick-close.mp3");
    });

    it("a voice with no script plays no brief at all — no line, no frame", () => {
      getScenarioEngine().setScripts(new Map([["titan", RACE_START_SCRIPT]]));
      fire(snap());

      expect(audio._played).toEqual([]);
    });
  });
});

// Issue #1284: the brief no longer decides once at +3 s. It waits — re-asking
// every START_BRIEF_SETTLE_POLL_MS — until every condition it reads is known
// or START_BRIEF_SETTLE_MAX_MS have passed since the event, then speaks once
// with whatever is known.
describe("settle wait for the conditions (issue #1284)", () => {
  // Scoped to this contract: registerPitCrew also registers session-start,
  // whose snapshot resolver is absent here and so writes its own line at 10 s.
  const PROCEEDING = 'Scenario "pit-crew.race-start" proceeding without';
  const greetings = () => voicePaths().filter((p) => p.endsWith("/race-start-greeting/niklas.mp3"));

  it("speaks once, with the wetness clause, after a wetness that was unknown at +3 s arrives at +5 s", () => {
    publish(snap({ wetness: null }));

    vi.advanceTimersByTime(4900);
    expect(audio._played).toEqual([]);

    currentSnapshot = snap();
    vi.advanceTimersByTime(100);
    expect(audio._played.length).toBeGreaterThan(0);

    flush(audio);

    expect(greetings()).toHaveLength(1);
    expect(hasClip("/session-start/wetness-intro.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-unknown-01.mp3")).toBe(false);
    expect(infoMessages().some((m) => m.includes(PROCEEDING))).toBe(false);
  });

  it("speaks at the deadline with the conditions-still-unknown line when the wetness never arrives, and logs it", () => {
    publish(snap({ wetness: null }));

    vi.advanceTimersByTime(START_BRIEF_SETTLE_MAX_MS - 1);
    expect(audio._played).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(audio._played.length).toBeGreaterThan(0);

    flush(audio);

    expect(greetings()).toHaveLength(1);
    expect(hasClip("/position-number/7.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-unknown-01.mp3")).toBe(true);
    expect(hasClip("/session-start/wetness-intro.mp3")).toBe(false);
    expect(infoMessages()).toContainEqual(expect.stringContaining(`${PROCEEDING} track wetness`));
  });

  it("ends the brief without any wetness line for a voice that lacks the unknown line — the else branch is optional", () => {
    activeVoice = BARE_VOICE;
    fire(snap({ driverName: "driver", wetness: null }));

    const played = voicePaths();

    expect(hasClip("/race-start-greeting/driver.mp3")).toBe(true);
    expect(played.some((p) => p.includes("/session-start/wetness-"))).toBe(false);
    expect(played.at(-1)).toMatch(/[/]numbers-degrees[/]20[.]mp3$/);
  });

  it.each([
    ["trackTemp", "track-temp-intro", "28", "air-temp-intro", "20", "track temperature"],
    ["airTemp", "air-temp-intro", "20", "track-temp-intro", "28", "air temperature"],
  ] as const)(
    "an unknown %s drops only its own clause, at the deadline",
    (field, droppedIntro, droppedFigure, keptIntro, keptFigure, logged) => {
      publish(snap({ [field]: null }));

      vi.advanceTimersByTime(START_BRIEF_SETTLE_MAX_MS - 1);
      expect(audio._played).toEqual([]);

      flush(audio);

      expect(hasClip(`/session-start/${droppedIntro}.mp3`)).toBe(false);
      expect(hasClip(`/numbers-degrees/${droppedFigure}.mp3`)).toBe(false);
      expect(hasClip(`/session-start/${keptIntro}.mp3`)).toBe(true);
      expect(hasClip(`/numbers-degrees/${keptFigure}.mp3`)).toBe(true);
      expect(hasClip("/race-start-greeting/niklas.mp3")).toBe(true);
      expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
      expect(infoMessages()).toContainEqual(expect.stringContaining(`${PROCEEDING} ${logged}`));
    },
  );

  it("names every condition it went ahead without in one log line", () => {
    fire(snap({ wetness: null, trackTemp: null, airTemp: null }));

    expect(infoMessages()).toContainEqual(
      expect.stringContaining(`${PROCEEDING} track wetness, track temperature, air temperature`),
    );
    expect(voicePaths().some((p) => p.includes("/numbers-degrees/"))).toBe(false);
    expect(hasClip("/session-start/wetness-unknown-01.mp3")).toBe(true);
  });

  it("speaks at +3 s with no further wait when everything is known by then", () => {
    publish(snap());

    vi.advanceTimersByTime(RACE_START_DELAY_MS - 1);
    expect(audio._played).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(audio._played.length).toBeGreaterThan(0);

    flush(audio);

    expect(greetings()).toHaveLength(1);
    expect(infoMessages().some((m) => m.includes(PROCEEDING))).toBe(false);
  });

  it("plays nothing when the snapshot stays null through the window, and where: logs the rejection", () => {
    fire(null);

    expect(audio._played).toEqual([]);
    expect(infoMessages()).toContainEqual(expect.stringContaining(`${PROCEEDING} telemetry or session info`));
    expect(infoMessages()).toContainEqual(expect.stringContaining("race-start where: rejected — snapshot is null"));
  });

  it("restarts the wait on a second session.changed during it, and plays one brief", () => {
    publish(snap({ wetness: null }));
    vi.advanceTimersByTime(6000);
    expect(audio._played).toEqual([]);

    // The session changes again mid-wait: the newest event wins, so its own
    // 3 s delay and 10 s window start over.
    publish(snap({ wetness: null }), { from: 1, to: 2 });

    // The first event's deadline passes without a fire.
    vi.advanceTimersByTime(START_BRIEF_SETTLE_MAX_MS - 6000);
    expect(audio._played).toEqual([]);

    // The second event's deadline fires the brief.
    vi.advanceTimersByTime(6000 - 1);
    expect(audio._played).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(audio._played.length).toBeGreaterThan(0);

    flush(audio);

    expect(greetings()).toHaveLength(1);
    expect(infoMessages().filter((m) => m.includes(PROCEEDING))).toHaveLength(1);
  });

  it("is deferred, not dropped, when its settle ends while an equal-weight line holds the Voice bus", () => {
    // An imperative line at the default weight, on the Voice bus, in flight
    // when the brief settles.
    getScenarioEngine().defineScenario({
      id: "test.voice-hold",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["voice/{voice}/setup-warning/race-01.mp3"],
    });
    publish(snap({ wetness: null }));

    vi.advanceTimersByTime(4900);
    getScenarioEngine().fire("test.voice-hold");
    currentSnapshot = snap();
    vi.advanceTimersByTime(100);

    // The brief settled at +5 s into a busy bus: it is parked, not dropped,
    // and nothing of it has played yet.
    expect(greetings()).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith('Scenario "pit-crew.race-start" pending — deferred (bus busy)');

    flush(audio);

    const played = voicePaths();

    expect(greetings()).toHaveLength(1);
    expect(played[0]).toMatch(/setup-warning[/]race-01[.]mp3$/);
    expect(played.findIndex((p) => p.endsWith("/race-start-greeting/niklas.mp3"))).toBeGreaterThan(0);
    expect(hasClip("/session-start/wetness-mostly-dry.mp3")).toBe(true);
  });

  it("answers ready at once in a qualifying session — session-start's — so it neither waits nor logs a settle line", () => {
    mockSessionType.mockReturnValue("Open Qualify");
    publish(snap({ wetness: null }));

    vi.advanceTimersByTime(RACE_START_DELAY_MS);
    expect(infoMessages()).toContainEqual(expect.stringContaining("race-start where: rejected — sessionType="));

    flush(audio);

    expect(audio._played).toEqual([]);
    expect(infoMessages().some((m) => m.includes(PROCEEDING))).toBe(false);
  });

  it("neither waits nor logs a settle line while its per-callout opt-in is off", () => {
    raceStartEnabled = false;
    fire(snap({ wetness: null }));

    expect(audio._played).toEqual([]);
    expect(infoMessages().some((m) => m.includes(PROCEEDING))).toBe(false);
  });

  it("neither waits nor logs a settle line while the Race Engineer master gate is off", () => {
    masterEnabled = false;
    fire(snap({ wetness: null }));

    expect(audio._played).toEqual([]);
    expect(infoMessages().some((m) => m.includes(PROCEEDING))).toBe(false);
  });
});

describe("describeMissingStartConditions (issue #1284)", () => {
  it("is null once every condition is known", () => {
    expect(describeMissingStartConditions(snap())).toBeNull();
  });

  it("names each missing condition", () => {
    expect(describeMissingStartConditions(snap({ wetness: null }))).toBe("track wetness");
    expect(describeMissingStartConditions(snap({ trackTemp: null }))).toBe("track temperature");
    expect(describeMissingStartConditions(snap({ airTemp: null }))).toBe("air temperature");
  });

  it("joins several missing conditions with commas, in a fixed order", () => {
    expect(describeMissingStartConditions(snap({ airTemp: null, wetness: null }))).toBe(
      "track wetness, air temperature",
    );
    expect(describeMissingStartConditions(snap({ wetness: null, trackTemp: null, airTemp: null }))).toBe(
      "track wetness, track temperature, air temperature",
    );
  });

  it("names the whole snapshot for a null one", () => {
    expect(describeMissingStartConditions(null)).toBe("telemetry or session info");
  });

  it("does not wait on a zero temperature, the pit speed limit or the grid position", () => {
    expect(describeMissingStartConditions(snap({ trackTemp: 0, airTemp: 0 }))).toBeNull();
    expect(describeMissingStartConditions(snap({ playerCarPosition: undefined }))).toBeNull();
  });

  it("pins the shared window: 10 s from the event, re-asked every 500 ms", () => {
    expect(START_BRIEF_SETTLE_MAX_MS).toBe(10_000);
    expect(START_BRIEF_SETTLE_POLL_MS).toBe(500);
  });
});

describe("buildRaceStartContract (issue #1065)", () => {
  it("carries no sequence and keeps every scheduling field verbatim — the 3 s trigger delay included, queueable since #1284 — taking the engine's default frame", () => {
    const c = buildRaceStartContract(() => null);

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.race-start");
    expect([...RACE_START_SCENARIO_IDS]).toEqual([c.id]);
    expect(c.when?.event).toBe("session.changed");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.family).toBe("race-start");
    expect(c.triggerDelay).toBe(RACE_START_DELAY_MS);
    expect(c.weight).toBeUndefined();
    expect(c.interrupt).toBeUndefined();
    expect(c.queueable).toBe(true);
    expect(c.cooldown).toBeUndefined();
    expect(c.frame).toBeUndefined();
  });

  it("settles on the shared start-brief window, asking what of its own snapshot is still unknown (issue #1284)", () => {
    let snapshot: RaceStartSnapshot | null = snap({ wetness: null });
    const c = buildRaceStartContract(() => snapshot);

    expect(c.settle?.maxWaitMs).toBe(START_BRIEF_SETTLE_MAX_MS);
    expect(c.settle?.pollMs).toBe(START_BRIEF_SETTLE_POLL_MS);
    expect(c.settle?.pending({} as never)).toBe("track wetness");

    snapshot = snap();
    expect(c.settle?.pending({} as never)).toBeNull();

    snapshot = null;
    expect(c.settle?.pending({} as never)).toBe("telemetry or session info");
  });
});

describe("registerRaceStartVocabulary (issue #1065)", () => {
  it("publishes the six vars, the grid-position case and the wetness-known and setup-warning conditions, each with a description for a pack author", () => {
    const { vars, conds, cases } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("raceStart.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "raceStart.airTempNumber",
      "raceStart.degreesUnit",
      "raceStart.greeting",
      "raceStart.position",
      "raceStart.trackTempNumber",
      "raceStart.wetness",
    ]);
    expect(cases.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["raceStart.gridPosition"]);
    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["raceStart.wetnessKnown"]);
    expect(conds.map((c) => c.name)).toContain("setupWarning.raceMismatch");

    const entries = [
      ...vars.filter((v) => ours(v.name)),
      ...cases.filter((c) => ours(c.name)),
      ...conds.filter((c) => ours(c.name) || c.name === "setupWarning.raceMismatch"),
    ];

    for (const entry of entries) expect(entry.description.length, entry.name).toBeGreaterThan(0);

    for (const [key, description] of Object.entries(
      cases.find((c) => c.name === "raceStart.gridPosition")?.keys ?? {},
    )) {
      expect(description.length, `raceStart.gridPosition key ${key}`).toBeGreaterThan(0);
    }
  });

  it("raceStart.wetnessKnown follows the snapshot: true only when it exists and carries a wetness (issue #1284)", () => {
    const conds = new Map<string, (ctx: never) => boolean>();
    let snapshot: RaceStartSnapshot | null = snap();

    registerRaceStartVocabulary(
      {
        defineVar: vi.fn(),
        defineCase: vi.fn(),
        defineCond: (name: string, predicate: (ctx: never) => boolean) => conds.set(name, predicate),
      } as never,
      () => snapshot,
    );

    const wetnessKnown = conds.get("raceStart.wetnessKnown");

    expect(wetnessKnown).toBeDefined();
    expect(wetnessKnown?.({} as never)).toBe(true);

    snapshot = snap({ wetness: TrackWetness.Dry });
    expect(wetnessKnown?.({} as never)).toBe(true);

    snapshot = snap({ wetness: null });
    expect(wetnessKnown?.({} as never)).toBe(false);

    snapshot = null;
    expect(wetnessKnown?.({} as never)).toBe(false);
  });

  it("declares exactly the keys the grid-position resolver can return — enumerated over every position and the missing one", () => {
    const declared =
      getScenarioEngine()
        .vocabulary()
        .cases.find((c) => c.name === "raceStart.gridPosition")?.keys ?? {};
    const reachable = new Set<string>();

    for (const playerCarPosition of [undefined, 0, -1, ...Array.from({ length: 70 }, (_, i) => i + 1)]) {
      reachable.add(resolveRaceStartGridPosition(snap({ playerCarPosition })));
    }

    reachable.add(resolveRaceStartGridPosition(null));

    expect([...reachable].sort()).toEqual(Object.keys(declared).sort());
    expect(Object.keys(declared).sort()).toEqual(Object.keys(RACE_START_GRID_POSITION_KEYS).sort());
    expect(resolveRaceStartGridPosition(snap({ playerCarPosition: 1 }))).toBe("pole");
    expect(resolveRaceStartGridPosition(snap({ playerCarPosition: 2 }))).toBe("composed");
    expect(resolveRaceStartGridPosition(snap({ playerCarPosition: undefined }))).toBe("none");
    expect(resolveRaceStartGridPosition(null)).toBe("none");
  });
});

describe("the bundled script's race-start entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Race Start harness route and a sequence", () => {
    for (const id of RACE_START_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Race Start → Race start — P5/);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("keeps every clause optional, the grid position a case inside its clause, and the wetness a branch on whether it is known (issue #1284)", () => {
    expect(SCRIPT.scenarios["pit-crew.race-start"].sequence).toEqual([
      { optional: ["{{raceStart.greeting}}"] },
      {
        optional: [
          {
            case: "raceStart.gridPosition",
            of: {
              pole: ["pool:race-start/starting-from-pole"],
              composed: ["pool:race-start/qualifying-put-us-to", "{{raceStart.position}}"],
              none: [],
            },
          },
        ],
      },
      { optional: ["pool:session-start/track-temp-intro", "{{raceStart.trackTempNumber}}"] },
      { optional: ["pool:session-start/air-temp-intro", "{{raceStart.airTempNumber}}"] },
      {
        if: "raceStart.wetnessKnown",
        then: [{ optional: ["pool:session-start/wetness-intro", "{{raceStart.wetness}}"] }],
        else: [{ optional: ["pool:session-start/wetness-unknown"] }],
      },
      { if: "setupWarning.raceMismatch", then: [{ optional: ["pool:setup-warning/race"] }] },
    ]);
  });

  it("references only vocabulary the race-start family registers, with the declared case keys, and no frame, fragment or alias", () => {
    const refs = collectScriptReferences(RACE_START_SCRIPT);
    const vocabulary = getScenarioEngine().vocabulary();

    expect(refs.vars).toEqual([
      "raceStart.airTempNumber",
      "raceStart.greeting",
      "raceStart.position",
      "raceStart.trackTempNumber",
      "raceStart.wetness",
    ]);
    expect(refs.conds).toEqual(["raceStart.wetnessKnown", "setupWarning.raceMismatch"]);
    expect(refs.cases).toEqual([
      { name: "raceStart.gridPosition", keys: Object.keys(RACE_START_GRID_POSITION_KEYS).sort() },
    ]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(RACE_START_SCRIPT.pools ?? {})).toEqual([]);

    for (const v of refs.vars) expect(vocabulary.vars.map((x) => x.name)).toContain(v);

    for (const c of refs.conds) expect(vocabulary.conds.map((x) => x.name)).toContain(c);

    for (const c of refs.cases) {
      const declared = vocabulary.cases.find((v) => v.name === c.name);

      expect(declared).toBeDefined();
      expect(Object.keys(declared?.keys ?? {}).sort()).toEqual([...c.keys].sort());
    }
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    const sources = [
      "race-start/qualifying-put-us-to",
      "race-start/starting-from-pole",
      "session-start/air-temp-intro",
      "session-start/track-temp-intro",
      "session-start/wetness-intro",
      "session-start/wetness-unknown",
      "setup-warning/race",
    ];

    expect([...collectScriptReferences(RACE_START_SCRIPT).pools].sort()).toEqual(sources);
    expect(RACE_START_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of RACE_START_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `fixture: ${group}/${base}`,
      ).toBe(true);
    }
  });

  it("compiles for both test voices with nothing skipped — no unknown pool, var, condition, case key or fragment", () => {
    const raceStartWarnings = mockLogger.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("race-start"));

    expect(raceStartWarnings).toEqual([]);
  });
});
