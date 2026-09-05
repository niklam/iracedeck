/**
 * Qualifying lap-invalidation callout tests (issue #567; scripted since
 * #1065).
 *
 * Drives the contract through the real scenario engine with the bundled
 * voice's REAL `callouts.json` narrowed to this family's entry, so the tail
 * gate, the laps-left case and the per-lap latch all run the production
 * compile + expansion path; what the engineer says is the script's.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
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
  buildQualifyingInvalidationContract,
  checkAndUpdateQualifyingLatch,
  QUALIFYING_INVALIDATION_CLIP_SOURCES,
  QUALIFYING_INVALIDATION_SCENARIO_IDS,
  QUALIFYING_LAP_COUNT_MAX,
  QUALIFYING_LAP_COUNT_MIN,
  QUALIFYING_LAPS_LEFT_KEYS,
  type QualifyingInvalidationSnapshot,
  resetQualifyingInvalidationLatch,
  resolveQualifyingLapsLeft,
} from "./qualifying-invalidation.js";
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

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    `voice/${VOICE}/qualifying-invalidation/invalidated-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/out-of-laps-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/plenty-of-laps-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/1-lap-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/2-laps-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/3-laps-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/4-laps-left-01.mp3`,
    `voice/${VOICE}/qualifying-invalidation/5-laps-left-01.mp3`,
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
const QUALIFYING_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(QUALIFYING_INVALIDATION_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

function snap(overrides: Partial<QualifyingInvalidationSnapshot> = {}): QualifyingInvalidationSnapshot {
  return {
    sessionType: "qualifying",
    sessionNum: 1,
    lapsRemaining: 3,
    lapLimited: true,
    // Default to a flying lap (lapCompleted=1) so most tests exercise the
    // normal callout path; out-lap suppression is opted into explicitly via
    // overrides where it matters.
    lapCompleted: 1,
    lapStartedFromPits: false,
    lapCounted: true,
    ...overrides,
  };
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let lastSnapshot: QualifyingInvalidationSnapshot | null;
let qualifyingEnabled: boolean;

function fire(data: QualifyingInvalidationSnapshot | null): void {
  lastSnapshot = data;
  bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" });
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
  qualifyingEnabled = true;
  resetQualifyingInvalidationLatch();
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getQualifyingInvalidationCalloutEnabled: () => qualifyingEnabled,
    getQualifyingInvalidationSnapshot: () => lastSnapshot,
  });
  // After the registration, as the plugins do: the callout's body is looked
  // up in the active voice's compiled script at fire time (issue #1065).
  getScenarioEngine().setScripts(new Map([[VOICE, QUALIFYING_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("checkAndUpdateQualifyingLatch (unit)", () => {
  beforeEach(() => resetQualifyingInvalidationLatch());

  it("returns false when sessionType is not qualifying", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ sessionType: "race" }))).toBe(false);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionType: "practice" }))).toBe(false);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionType: undefined }))).toBe(false);
  });

  it("returns true on the first qualifying incident and false on the second for the same lap", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 2 }))).toBe(true);
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 2 }))).toBe(false);
  });

  it("re-arms on a new LapCompleted within the same session", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 2, lapCompleted: 2 }))).toBe(true);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 2, lapCompleted: 3 }))).toBe(true);
  });

  it("re-arms across a session change even if LapCompleted matches", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 1, lapCompleted: 5 }))).toBe(true);
    expect(checkAndUpdateQualifyingLatch(snap({ sessionNum: 2, lapCompleted: 5 }))).toBe(true);
  });

  it("returns false when lapStartedFromPits and does not arm the latch", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 4, lapStartedFromPits: true }))).toBe(false);
    // Same lap with the flag cleared (driver finished the post-pit lap and
    // started a fresh flying lap with the same LapCompleted value) still
    // fires. Confirms the pit-exit path doesn't pollute the latch — the
    // same lap with the flag flipped to false counts as a fresh fire.
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 4, lapStartedFromPits: false }))).toBe(true);
  });

  it("returns false on a lap beyond the counted attempts and does not arm the latch", () => {
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 3, lapCounted: false }))).toBe(false);
    // The suppression path must not pollute the latch — the same composite
    // key with the flag flipped counts as a fresh fire (mirrors the
    // pit-exit-lap invariant above).
    expect(checkAndUpdateQualifyingLatch(snap({ lapCompleted: 3, lapCounted: true }))).toBe(true);
  });
});

describe("qualifying-invalidation scenario — tail branches", () => {
  it("always plays the core invalidated line", () => {
    fire(snap({ lapsRemaining: 3 }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
  });

  it("plays out-of-laps when lapsRemaining is 0", () => {
    fire(snap({ lapsRemaining: 0 }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
    expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(false);
  });

  it("plays the per-N clip for lapsRemaining 1..5", () => {
    const expectedNames: Record<number, string> = {
      1: "1-lap-left-01",
      2: "2-laps-left-01",
      3: "3-laps-left-01",
      4: "4-laps-left-01",
      5: "5-laps-left-01",
    };

    for (const n of [1, 2, 3, 4, 5] as const) {
      resetQualifyingInvalidationLatch();
      audio._played.length = 0;
      fire(snap({ lapsRemaining: n }));

      expect(hasClip(`/qualifying-invalidation/${expectedNames[n]}.mp3`)).toBe(true);
      expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
      // No other tail clip should play
      expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(false);
      expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(false);
    }
  });

  it("falls back to plenty-of-laps when lapsRemaining exceeds the counted max", () => {
    fire(snap({ lapsRemaining: QUALIFYING_LAP_COUNT_MAX + 1 }));

    expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
  });

  it("speaks only the core line in time-limited qualifying", () => {
    fire(snap({ lapLimited: false, lapsRemaining: undefined }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(false);
    expect(hasClip("/qualifying-invalidation/plenty-of-laps-01.mp3")).toBe(false);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
  });

  it("speaks only the core line when lapsRemaining is missing", () => {
    fire(snap({ lapLimited: true, lapsRemaining: undefined }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(voicePaths().some((p) => p.match(/\/qualifying-invalidation\/\d-laps?-left/))).toBe(false);
  });
});

describe("qualifying-invalidation scenario — pit-exit lap suppression", () => {
  it("stays silent on a lap started from pits (covers both the session out-lap and mid-session post-pit-exit laps)", () => {
    fire(snap({ lapCompleted: 3, lapsRemaining: 2, lapStartedFromPits: true }));

    expect(voicePaths()).toEqual([]);
  });

  it("fires normally on the next flying lap after a pit-out lap", () => {
    // The plugin clears the flag at the next lap.started event. The scenario
    // then sees a fresh lap with the flag cleared and the latch unarmed.
    fire(snap({ lapCompleted: 3, lapStartedFromPits: true })); // suppressed
    expect(voicePaths()).toEqual([]);

    fire(snap({ lapCompleted: 4, lapStartedFromPits: false, lapsRemaining: 1 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/1-lap-left-01.mp3")).toBe(true);
  });
});

describe("qualifying-invalidation scenario — beyond-counted-laps suppression (issue #776)", () => {
  it("stays fully silent on an extra lap after the counted attempts are done", () => {
    // Lap 3 of a 2-lap qualifying: the raw SessionLapsRemainEx hit 0, so the
    // translator reports lapsRemaining 0 AND lapCounted false. The lap was
    // never a timed attempt — nothing is invalidated, nothing is spoken.
    fire(snap({ lapCompleted: 3, lapsRemaining: 0, lapCounted: false }));

    expect(voicePaths()).toEqual([]);
  });

  it("keeps the out-of-laps tail on the final counted lap", () => {
    // Lap 2 of 2 (raw SessionLapsRemainEx = 1): still a counted attempt, and
    // after this invalidated lap nothing remains — the out-of-laps tail is
    // exactly right here and must survive the #776 suppression.
    fire(snap({ lapCompleted: 2, lapsRemaining: 0, lapCounted: true }));

    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(true);
  });

  it("suppresses every extra lap, not just the first", () => {
    // The user's exact report: out-of-laps speaks once on the final counted
    // lap, then the driver keeps circulating — each extra lap re-arms the
    // per-lap latch, so without the lapCounted gate every extra lap's first
    // incident would replay the callout.
    fire(snap({ lapCompleted: 2, lapsRemaining: 0, lapCounted: true }));
    expect(hasClip("/qualifying-invalidation/out-of-laps-01.mp3")).toBe(true);
    audio._played.length = 0;

    fire(snap({ lapCompleted: 3, lapsRemaining: 0, lapCounted: false }));
    fire(snap({ lapCompleted: 4, lapsRemaining: 0, lapCounted: false }));

    expect(voicePaths()).toEqual([]);
  });
});

describe("qualifying-invalidation scenario — session gating", () => {
  it.each(["practice", "race", undefined] as const)("stays silent when sessionType is %s", (sessionType) => {
    fire(snap({ sessionType, lapsRemaining: 3 }));

    expect(voicePaths()).toEqual([]);
  });

  it("stays silent when the snapshot resolver returns null", () => {
    fire(null);

    expect(voicePaths()).toEqual([]);
  });
});

describe("qualifying-invalidation scenario — per-lap latch", () => {
  it("collapses two incidents on the same lap into one callout", () => {
    fire(snap({ lapCompleted: 4, lapsRemaining: 2 }));
    const firstFireCount = voicePaths().length;

    fire(snap({ lapCompleted: 4, lapsRemaining: 2 }));

    expect(voicePaths().length).toBe(firstFireCount);
  });

  it("re-fires on a new LapCompleted within the same session", () => {
    fire(snap({ lapCompleted: 4, lapsRemaining: 2 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
    audio._played.length = 0;

    fire(snap({ lapCompleted: 5, lapsRemaining: 1 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
  });

  it("re-fires on a session change even if LapCompleted is identical", () => {
    fire(snap({ sessionNum: 1, lapCompleted: 2, lapsRemaining: 2 }));
    audio._played.length = 0;

    fire(snap({ sessionNum: 2, lapCompleted: 2, lapsRemaining: 2 }));
    expect(hasClip("/qualifying-invalidation/invalidated-01.mp3")).toBe(true);
  });
});

describe("qualifying-invalidation scenario — opt-in gate", () => {
  it("stays silent when the per-callout opt-in is false", () => {
    qualifyingEnabled = false;

    fire(snap({ lapsRemaining: 3 }));

    expect(voicePaths()).toEqual([]);
  });
});

describe("constants", () => {
  it("exposes the counted-clip range as 1..5", () => {
    expect(QUALIFYING_LAP_COUNT_MIN).toBe(1);
    expect(QUALIFYING_LAP_COUNT_MAX).toBe(5);
  });
});

describe("qualifying-invalidation scripted delivery (issue #1065)", () => {
  it("reads the core line then the tail, in the script's order, inside the engine's radio frame", () => {
    fire(snap({ lapsRemaining: 2 }));

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/qualifying-invalidation/invalidated-01.mp3`,
      `voice/${VOICE}/qualifying-invalidation/2-laps-left-01.mp3`,
    ]);
    expect(audio._played[0]?.path).toBe("sfx/IRD-tick-open.mp3");
    expect(audio._played.at(-1)?.path).toBe("sfx/IRD-tick-close.mp3");
  });

  it("a fractional count the case has no key for keeps the core line and drops the tail (the default branch)", () => {
    fire(snap({ lapsRemaining: 2.5 }));

    expect(voicePaths()).toEqual([`voice/${VOICE}/qualifying-invalidation/invalidated-01.mp3`]);
  });

  it("a voice with no script plays nothing at all — no line, no frame", () => {
    getScenarioEngine().setScripts(new Map([["titan", QUALIFYING_SCRIPT]]));
    fire(snap({ lapsRemaining: 3 }));

    expect(audio._played).toEqual([]);
  });
});

describe("buildQualifyingInvalidationContract (issue #1065)", () => {
  it("carries no sequence and keeps the former literal verbatim — Voice bus, family, no base, default weight and frame", () => {
    const c = buildQualifyingInvalidationContract(() => null);

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.qualifying-invalidation-lap-invalidated");
    expect([...QUALIFYING_INVALIDATION_SCENARIO_IDS]).toEqual([c.id]);
    expect(c.when?.event).toBe("incident.occurred");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.family).toBe("qualifying-invalidation");
    // The literal never named a base: the script's slashed pool steps resolve
    // through the manifest without one, so nothing is missing.
    expect(c.base).toBeUndefined();
    expect(c.weight).toBeUndefined();
    expect(c.interrupt).toBeUndefined();
    expect(c.queueable).toBeUndefined();
    expect(c.cooldown).toBeUndefined();
    expect(c.triggerDelay).toBeUndefined();
    expect(c.frame).toBeUndefined();
  });
});

describe("registerQualifyingInvalidationVocabulary (issue #1065)", () => {
  it("publishes the tail gate and the laps-left case, each with a description for a pack author", () => {
    const { conds, cases } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("qualifying.");

    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["qualifying.tailIsSpeakable"]);
    expect(cases.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["qualifying.lapsLeft"]);

    for (const entry of [...conds, ...cases].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }

    for (const [key, description] of Object.entries(cases.find((c) => c.name === "qualifying.lapsLeft")?.keys ?? {})) {
      expect(description.length, `qualifying.lapsLeft key ${key}`).toBeGreaterThan(0);
    }
  });

  it("declares exactly the keys the laps-left resolver can return — enumerated over every whole count", () => {
    const declared =
      getScenarioEngine()
        .vocabulary()
        .cases.find((c) => c.name === "qualifying.lapsLeft")?.keys ?? {};
    const reachable = new Set<string>();

    for (let lapsRemaining = 0; lapsRemaining <= 30; lapsRemaining++) {
      const key = resolveQualifyingLapsLeft(snap({ lapsRemaining }));

      expect(key, `lapsRemaining=${lapsRemaining}`).not.toBeNull();
      reachable.add(key ?? "");
    }

    expect([...reachable].sort()).toEqual(Object.keys(declared).sort());
    expect(Object.keys(declared).sort()).toEqual(Object.keys(QUALIFYING_LAPS_LEFT_KEYS).sort());
    expect(resolveQualifyingLapsLeft(snap({ lapsRemaining: 0 }))).toBe("out-of-laps");
    expect(resolveQualifyingLapsLeft(snap({ lapsRemaining: 5 }))).toBe("5");
    expect(resolveQualifyingLapsLeft(snap({ lapsRemaining: 6 }))).toBe("plenty");
  });

  it("resolves to no key when the tail is not speakable, or the count is not a whole number", () => {
    expect(resolveQualifyingLapsLeft(null)).toBeNull();
    expect(resolveQualifyingLapsLeft(snap({ lapLimited: false }))).toBeNull();
    expect(resolveQualifyingLapsLeft(snap({ lapsRemaining: undefined }))).toBeNull();
    expect(resolveQualifyingLapsLeft(snap({ lapsRemaining: 2.5 }))).toBeNull();
  });
});

describe("the bundled script's qualifying-invalidation entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Qualifying Invalidation harness route and a sequence", () => {
    for (const id of QUALIFYING_INVALIDATION_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Qualifying Invalidation → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("keeps the core line required and the tail a whole clause: an if with no else, over the declared case keys", () => {
    const sequence = SCRIPT.scenarios["pit-crew.qualifying-invalidation-lap-invalidated"].sequence ?? [];

    expect(sequence[0]).toBe("pool:qualifying-invalidation/invalidated");
    expect(sequence[1]).toEqual({
      if: "qualifying.tailIsSpeakable",
      then: [
        {
          case: "qualifying.lapsLeft",
          of: {
            "out-of-laps": ["pool:qualifying-invalidation/out-of-laps"],
            plenty: ["pool:qualifying-invalidation/plenty-of-laps"],
            "1": ["pool:qualifying-invalidation/1-lap-left"],
            "2": ["pool:qualifying-invalidation/2-laps-left"],
            "3": ["pool:qualifying-invalidation/3-laps-left"],
            "4": ["pool:qualifying-invalidation/4-laps-left"],
            "5": ["pool:qualifying-invalidation/5-laps-left"],
            default: [],
          },
        },
      ],
    });
    expect(sequence).toHaveLength(2);
  });

  it("references only vocabulary the family registers, with the declared case keys, and no var, frame, fragment or alias", () => {
    const refs = collectScriptReferences(QUALIFYING_SCRIPT);
    const vocabulary = getScenarioEngine().vocabulary();

    expect(refs.vars).toEqual([]);
    expect(refs.conds).toEqual(["qualifying.tailIsSpeakable"]);
    expect(refs.cases).toEqual([{ name: "qualifying.lapsLeft", keys: Object.keys(QUALIFYING_LAPS_LEFT_KEYS).sort() }]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(QUALIFYING_SCRIPT.pools ?? {})).toEqual([]);

    for (const c of refs.conds) expect(vocabulary.conds.map((x) => x.name)).toContain(c);

    for (const c of refs.cases) {
      const declared = vocabulary.cases.find((v) => v.name === c.name);

      expect(declared).toBeDefined();
      expect(Object.keys(declared?.keys ?? {}).sort()).toEqual([...c.keys].sort());
    }
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    const sources = [
      "qualifying-invalidation/1-lap-left",
      "qualifying-invalidation/2-laps-left",
      "qualifying-invalidation/3-laps-left",
      "qualifying-invalidation/4-laps-left",
      "qualifying-invalidation/5-laps-left",
      "qualifying-invalidation/invalidated",
      "qualifying-invalidation/out-of-laps",
      "qualifying-invalidation/plenty-of-laps",
    ];

    expect([...collectScriptReferences(QUALIFYING_SCRIPT).pools].sort()).toEqual(sources);
    expect(QUALIFYING_INVALIDATION_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of QUALIFYING_INVALIDATION_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `no voice/${VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `fixture: ${group}/${base}`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    const qualifyingWarnings = mockLogger.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("qualifying-invalidation"));

    expect(qualifyingWarnings).toEqual([]);
  });
});
