/**
 * Position-change callout tests (issue #566; scripted since #1065).
 *
 * Drives the contract through the real scenario engine with the bundled
 * voice's real `callouts.json` narrowed to this family, so var resolution,
 * the `position.readoutShape` case and the `where:` predicate all run the
 * production path. The one case that needs the catalog's opt-in wrapper
 * registers the whole catalog through `registerPitCrew`, as the plugins do.
 *
 * Coverage:
 *   - Position improved → "better" intro + correct number clip
 *   - Position worsened → "worse" intro + correct number clip
 *   - No previous position (first valid lap) → "better" intro (treated as fix)
 *   - Position unchanged → silent
 *   - Position with no clip for the active voice → silent (expansion abort, issues #835/#836)
 *   - Multi-class session uses classPosition; single-class uses overall position
 *   - Session-type gating: qualifying only fires; race / practice / test stay silent
 *   - Per-callout opt-in suppresses fires when off
 *   - The three readout shapes (invalid lap / pole / standard) and their precedence
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { _resetPositionReadoutCooldown, registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  buildPositionContract,
  POSITION_CLIP_SOURCES,
  POSITION_READOUT_SHAPE_KEYS,
  POSITION_SCENARIO_IDS,
  positionChangeIsAnnounceable,
  registerPositionVocabulary,
  resolvePositionReadoutShape,
  selectEffectivePosition,
} from "./position.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
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
  publishEvent: (name: SimEventName, data: Record<string, unknown>) => void;
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
    publishEvent(name: SimEventName, data: Record<string, unknown>) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: null,
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

function flush(audio: FakeAudio, iterations = 20): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "default";

const NUMBER_NAMES = Array.from({ length: 64 }, (_, i) => String(i + 1));

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    `voice/${VOICE}/position-intro-better/that-puts-us-to-01.mp3`,
    `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
    `voice/${VOICE}/position-intro-pole/that-puts-us-on-pole-01.mp3`,
    `voice/${VOICE}/position-invalid-lap/that-lap-didnt-count-01.mp3`,
    ...NUMBER_NAMES.map((n) => `voice/${VOICE}/position-number/${n}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled script narrowed to this family's entry (F7-trap i). */
const POSITION_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(POSITION_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const MANIFEST = manifestJson as AudioAssetsManifest;

type LapPayload = SimEventOf<"lap.completed">["data"];

function snap(overrides: Partial<LapPayload> = {}): LapPayload {
  return {
    lap: 5,
    lapTime: 94.8,
    isBest: false,
    isFirstValid: false,
    // Default to qualifying: position callouts only fire in qualifying.
    // Tests that want to verify the silent-in-X behavior override.
    sessionType: "qualifying",
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let lastSnapshot: LapPayload | null;
let raceFinished: boolean;

function fire(data: LapPayload | null): void {
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

// Live position resolver mirrors the fired snapshot — these tests don't
// simulate a mid-lap change between S/F and speak-time, so the live readout
// speaks the snapshot's effective position (issue #574).
function liveFromSnapshot(): { position: number; classPosition: number; isMultiClass: boolean } | null {
  const s = lastSnapshot as Record<string, unknown> | null;

  if (!s || typeof s.position !== "number" || s.position <= 0) return null;

  return {
    position: s.position,
    classPosition: typeof s.classPosition === "number" ? (s.classPosition as number) : (s.position as number),
    isMultiClass: s.isMultiClass === true,
  };
}

beforeEach(() => {
  lastSnapshot = null;
  raceFinished = false;
  _resetPositionReadoutCooldown();
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, the contract, the
  // script. The family is registered ALONE, so only its own compile
  // diagnostics can appear.
  registerPositionVocabulary(engine, () => lastSnapshot, liveFromSnapshot);
  engine.defineContract(buildPositionContract(() => raceFinished, liveFromSnapshot));
  engine.setScripts(new Map([[VOICE, POSITION_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("selectEffectivePosition", () => {
  it("returns overall position in single-class sessions", () => {
    expect(selectEffectivePosition(snap({ position: 5, classPosition: 5, isMultiClass: false }))).toEqual({
      current: 5,
      previous: undefined,
    });
  });

  it("returns class position in multi-class sessions", () => {
    expect(
      selectEffectivePosition(snap({ position: 12, classPosition: 3, previousClassPosition: 5, isMultiClass: true })),
    ).toEqual({ current: 3, previous: 5 });
  });

  it("returns null when the active position is unavailable", () => {
    expect(selectEffectivePosition(snap({ position: undefined }))).toBeNull();
    expect(selectEffectivePosition(snap({ isMultiClass: true, classPosition: undefined }))).toBeNull();
  });
});

describe("positionChangeIsAnnounceable", () => {
  it("returns true for an improvement", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 3, previousPosition: 5 }))).toBe(true);
  });

  it("returns true for a worsening", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 5, previousPosition: 3 }))).toBe(true);
  });

  it("returns true on the first fix (no previousPosition)", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 4 }))).toBe(true);
  });

  it("returns true when position is unchanged on a non-PB lap in qualifying (status update)", () => {
    expect(
      positionChangeIsAnnounceable(
        snap({ position: 5, previousPosition: 5, isBest: false, sessionType: "qualifying" }),
      ),
    ).toBe(true);
  });

  it("returns false when position is unchanged on a non-PB lap in race (race-status owns hold)", () => {
    // Issue #569 — in race the unchanged-status case is suppressed because
    // the every-3-laps race-status callout handles hold-position updates.
    expect(
      positionChangeIsAnnounceable(snap({ position: 5, previousPosition: 5, isBest: false, sessionType: "race" })),
    ).toBe(false);
  });

  it("returns false when position is unchanged on a PB lap (lap-time-best already speaks)", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 5, previousPosition: 5, isBest: true }))).toBe(false);
  });

  it("returns true for a change to a position beyond the staged clip range — the expansion abort owns speakability (issue #836)", () => {
    expect(positionChangeIsAnnounceable(snap({ position: 65, previousPosition: 99 }))).toBe(true);
  });

  it("returns true for an invalid lap with unchanged position (issue #572 — invalid branch still fires)", () => {
    // The invalid-lap shape (issue #572) prefixes the readout with "That lap
    // didn't count." and forces the worse-framing intro. It rides on the
    // existing announceable path — an invalid lap is `isBest: false`, so the
    // unchanged-non-PB status case in `positionChangeIsAnnounceable` already
    // covers it. This test pins the contract so future predicate changes
    // don't accidentally silence the invalid-lap shape.
    expect(
      positionChangeIsAnnounceable(
        snap({
          position: 5,
          previousPosition: 5,
          isBest: false,
          sessionType: "qualifying",
          lapIsValid: false,
        }),
      ),
    ).toBe(true);
  });
});

describe("position-change contract", () => {
  it("plays the better intro and number for an improvement", () => {
    fire(snap({ position: 3, previousPosition: 5 }));

    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(false);
    expect(hasClip("/position-number/3.mp3")).toBe(true);
  });

  it("plays the worse intro and number for a worsening", () => {
    fire(snap({ position: 5, previousPosition: 3 }));

    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/5.mp3")).toBe(true);
  });

  it("uses the better intro for a first-fix (no previousPosition)", () => {
    // Position 4 chosen so we don't trigger the qualifying pole shape (P1).
    fire(snap({ position: 4, isFirstValid: true }));

    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-number/4.mp3")).toBe(true);
  });

  it("speaks the status update when position is unchanged on a non-PB lap", () => {
    fire(snap({ position: 5, previousPosition: 5, isBest: false }));

    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/5.mp3")).toBe(true);
  });

  it("stays silent when position is unchanged on a PB lap (lap-time-best owns the lap)", () => {
    fire(snap({ position: 5, previousPosition: 5, isBest: true }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when the position has no clip for the active voice (expansion abort, issue #836)", () => {
    fire(snap({ position: 65, previousPosition: 99 }));

    expect(voicePaths()).toEqual([]);
  });

  it("uses class position in multi-class sessions", () => {
    fire(snap({ position: 12, previousPosition: 14, classPosition: 2, previousClassPosition: 4, isMultiClass: true }));

    // Class position improved (4 → 2), even though overall also improved.
    // The number clip must be the class position, not the overall.
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
    expect(hasClip("/position-number/2.mp3")).toBe(true);
    expect(hasClip("/position-number/12.mp3")).toBe(false);
  });

  it("uses overall position in single-class sessions", () => {
    fire(snap({ position: 4, previousPosition: 6, classPosition: 4, previousClassPosition: 6, isMultiClass: false }));

    expect(hasClip("/position-number/4.mp3")).toBe(true);
  });

  it("fires on a real change in race sessions (improvement uses 'currently', not 'that puts us to')", () => {
    // Issue #569 — race fires the position callout on real changes, but the
    // intro is always "We're currently P[n]" regardless of direction. "That
    // puts us to P[n]" implies lap-times-drive-standings which is true in
    // qualifying but wrong in race.
    fire(snap({ position: 3, previousPosition: 5, sessionType: "race" }));

    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/3.mp3")).toBe(true);
  });

  it("fires on a real change in race sessions (worsening)", () => {
    fire(snap({ position: 7, previousPosition: 5, sessionType: "race" }));

    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/7.mp3")).toBe(true);
  });

  it("stays silent when position is unchanged on a non-PB lap in race (race-status owns hold)", () => {
    // The unchanged-on-non-PB status line fires in qualifying only — in race
    // the every-3-laps race-status callout handles hold-position updates.
    fire(snap({ position: 5, previousPosition: 5, isBest: false, sessionType: "race" }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent on the final lap of a race when race-end fires (issue #569)", () => {
    // Race finished — position-change must defer to race-end, otherwise the
    // engine queues "We're currently P6" behind race-end (both `priority:
    // "low"`, no shared family) and the user hears it after the result speech.
    raceFinished = true;
    fire(snap({ position: 6, previousPosition: 5, sessionType: "race" }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent in practice sessions", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: "practice" }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when sessionType is unresolved", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: undefined }));

    expect(voicePaths()).toEqual([]);
  });

  it("fires in qualifying sessions", () => {
    fire(snap({ position: 3, previousPosition: 5, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(true);
  });

  it("plays inside the radio frame, intro before number", () => {
    fire(snap({ position: 3, previousPosition: 5 }));

    const all = audio._played.map((p) => p.path);

    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-better/that-puts-us-to-01.mp3`,
      `voice/${VOICE}/position-number/3.mp3`,
    ]);
  });

  it("keeps every scheduling field verbatim and carries no sequence — what is said is the voice script's", () => {
    const c = buildPositionContract();

    expect(c.id).toBe("pit-crew.position-change");
    expect(c.when?.event).toBe("lap.completed");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.weight).toBe(WEIGHT.CHATTER);
    expect(c.queueable).toBe(true);
    expect(c.family).toBe("position");
    expect(c.frame).toBeUndefined();
    expect("sequence" in c).toBe(false);
  });
});

// The catalog's per-callout opt-in wrapper is `registerPitCrew`'s, not the
// family's — so this one case registers the whole catalog, as the plugins do.
describe("position-change contract — the catalog's opt-in wrapper", () => {
  let positionEnabled: boolean;

  beforeEach(() => {
    _resetAudioScenarios();
    positionEnabled = true;
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    registerPitCrew(bus, {
      logger: mockLogger as never,
      getLapTimeCalloutEnabled: () => false,
      getLapCompletedSnapshot: () => lastSnapshot,
      getPositionCalloutEnabled: () => positionEnabled,
      getRaceFinishedFired: () => raceFinished,
      getLivePosition: liveFromSnapshot,
    });
    engine.setScripts(new Map([[VOICE, SCRIPT]]));
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
  });

  it("fires through the real registration when the opt-in is on", () => {
    fire(snap({ position: 3, previousPosition: 5 }));

    expect(hasClip("/position-number/3.mp3")).toBe(true);
  });

  it("is suppressed when the per-callout opt-in is off", () => {
    positionEnabled = false;
    fire(snap({ position: 3, previousPosition: 5 }));

    expect(voicePaths()).toEqual([]);
  });
});

describe("position-change contract — qualifying pole", () => {
  it("plays the pole clip (no number) when improving to P1 in qualifying", () => {
    fire(snap({ position: 1, previousPosition: 3, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(true);
    // Pole is self-contained — neither the standard intro nor the number plays.
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/1.mp3")).toBe(false);
  });

  it("plays the pole clip when first valid lap lands at P1 in qualifying", () => {
    fire(snap({ position: 1, isFirstValid: true, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(false);
  });

  it("plays the standard status line when holding P1 on a slow lap (does not repeat pole)", () => {
    fire(snap({ position: 1, previousPosition: 1, isBest: false, sessionType: "qualifying" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(false);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(true);
  });

  it("plays the 'currently' intro (never pole or 'puts us to') for P1 improvements in race", () => {
    // The pole shape is qualifying-only — "on pole" doesn't apply to race
    // leadership. The "that puts us to" intro is also qualifying-only — race
    // standings don't follow from lap times. So a P1 improvement in race
    // speaks the standard "We're currently P1" status (issue #569 fix).
    fire(snap({ position: 1, previousPosition: 3, sessionType: "race" }));

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(false);
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(true);
  });

  it("uses pole on class-P1 improvement in multi-class qualifying", () => {
    fire(
      snap({
        position: 12,
        previousPosition: 14,
        classPosition: 1,
        previousClassPosition: 3,
        isMultiClass: true,
        sessionType: "qualifying",
      }),
    );

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(false);
    expect(hasClip("/position-number/12.mp3")).toBe(false);
  });
});

describe("position-change contract — invalid lap (issue #572)", () => {
  it("prefixes with 'that lap didn't count' and uses worse intro when lap is invalid + unchanged", () => {
    fire(
      snap({
        position: 5,
        previousPosition: 5,
        isBest: false,
        sessionType: "qualifying",
        lapIsValid: false,
      }),
    );

    expect(hasClip("/position-invalid-lap/that-lap-didnt-count-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/5.mp3")).toBe(true);
  });

  it("uses worse framing for an invalid lap even when standings improved on paper", () => {
    // An invalid lap can't earn the "better" framing even if standings
    // shifted from others' laps — pin the worse-intro behavior.
    fire(
      snap({
        position: 3,
        previousPosition: 5,
        isBest: false,
        sessionType: "qualifying",
        lapIsValid: false,
      }),
    );

    expect(hasClip("/position-invalid-lap/that-lap-didnt-count-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-better/that-puts-us-to-01.mp3")).toBe(false);
    expect(hasClip("/position-number/3.mp3")).toBe(true);
  });

  it("suppresses the pole shape for an invalid lap landing at P1", () => {
    fire(
      snap({
        position: 1,
        previousPosition: 3,
        isBest: false,
        sessionType: "qualifying",
        lapIsValid: false,
      }),
    );

    expect(hasClip("/position-intro-pole/that-puts-us-on-pole-01.mp3")).toBe(false);
    expect(hasClip("/position-invalid-lap/that-lap-didnt-count-01.mp3")).toBe(true);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
    expect(hasClip("/position-number/1.mp3")).toBe(true);
  });

  it("does not prefix when lapIsValid is undefined (missing signal — existing path)", () => {
    fire(snap({ position: 5, previousPosition: 3, isBest: false, sessionType: "qualifying" }));

    expect(hasClip("/position-invalid-lap/that-lap-didnt-count-01.mp3")).toBe(false);
  });

  it("does not prefix when lapIsValid is true (valid lap — existing path)", () => {
    fire(
      snap({
        position: 5,
        previousPosition: 3,
        isBest: false,
        sessionType: "qualifying",
        lapIsValid: true,
      }),
    );

    expect(hasClip("/position-invalid-lap/that-lap-didnt-count-01.mp3")).toBe(false);
    expect(hasClip("/position-intro-worse/currently-01.mp3")).toBe(true);
  });

  it("speaks the three fixed pieces in order: didn't count, currently, the number", () => {
    fire(snap({ position: 5, previousPosition: 5, isBest: false, sessionType: "qualifying", lapIsValid: false }));

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-invalid-lap/that-lap-didnt-count-01.mp3`,
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/5.mp3`,
    ]);
  });
});

describe("registerPositionVocabulary (issue #1065)", () => {
  it("publishes the readout-shape case and the three vars, each with a description for a pack author", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const positionVars = vars.filter((v) => v.name.startsWith("position."));

    expect(positionVars.map((v) => v.name)).toEqual(["position.intro", "position.number", "position.pole"]);

    for (const v of positionVars) expect(v.description.length, v.name).toBeGreaterThan(0);

    expect(positionVars.find((v) => v.name === "position.number")?.description).toContain("position-number");
    expect(cases.filter((c) => c.name.startsWith("position."))).toEqual([
      {
        name: "position.readoutShape",
        description: expect.stringContaining("shape"),
        keys: POSITION_READOUT_SHAPE_KEYS,
      },
    ]);
    expect(conds.filter((c) => c.name.startsWith("position."))).toEqual([]);

    for (const [key, description] of Object.entries(POSITION_READOUT_SHAPE_KEYS)) {
      expect(description.length, `position.readoutShape key ${key}`).toBeGreaterThan(0);
    }
  });

  it("declares exactly the keys the shape resolver can return — enumerated over the reachable snapshots", () => {
    const reachable = new Set<string>();

    for (const sessionType of ["qualifying", "race"] as const) {
      for (const lapIsValid of [undefined, true, false]) {
        for (const [position, previousPosition] of [
          [1, undefined],
          [1, 3],
          [1, 1],
          [3, 5],
          [5, 3],
          [5, 5],
        ] as const) {
          const key = resolvePositionReadoutShape(snap({ sessionType, lapIsValid, position, previousPosition }));

          expect(key).not.toBeNull();
          reachable.add(key ?? "");
        }
      }
    }

    expect([...reachable].sort()).toEqual(Object.keys(POSITION_READOUT_SHAPE_KEYS).sort());
    expect(Object.keys(POSITION_READOUT_SHAPE_KEYS)).toHaveLength(3);
  });

  it("resolves no shape without a snapshot — the case then takes the absent default and nothing plays", () => {
    expect(resolvePositionReadoutShape(null)).toBeNull();
  });
});

describe("the bundled script's position entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Position harness route and a sequence", () => {
    for (const id of POSITION_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Position → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("is one case over the three declared shapes, with the vars required (never optional) in every branch", () => {
    expect(SCRIPT.scenarios["pit-crew.position-change"].sequence).toEqual([
      {
        case: "position.readoutShape",
        of: {
          "invalid-lap": [
            "pool:position-invalid-lap/that-lap-didnt-count",
            "pool:position-intro-worse/currently",
            "{{position.number}}",
          ],
          pole: ["{{position.pole}}"],
          standard: ["{{position.intro}}", "{{position.number}}"],
        },
      },
    ]);
  });

  it("references only vocabulary this family registers, with the declared case keys", () => {
    const refs = collectScriptReferences(POSITION_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect(refs.vars).toEqual(["position.intro", "position.number", "position.pole"]);
    expect(refs.conds).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.cases).toEqual([{ name: "position.readoutShape", keys: ["invalid-lap", "pole", "standard"] }]);

    const declared = vocabulary.cases.find((v) => v.name === "position.readoutShape");

    expect(Object.keys(declared?.keys ?? {}).sort()).toEqual(["invalid-lap", "pole", "standard"]);
  });

  it("addresses exactly the two fixed lines as pools — the slashed form — and every one has a clip in the bundled voice", () => {
    const sources = ["position-intro-worse/currently", "position-invalid-lap/that-lap-didnt-count"];

    expect([...collectScriptReferences(POSITION_SCRIPT).pools].sort()).toEqual(sources);
    expect(POSITION_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of POSITION_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `no voice/${VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
