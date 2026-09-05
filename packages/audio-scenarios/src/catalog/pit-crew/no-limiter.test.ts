/**
 * No-limiter contract predicates, the property that matters most about the
 * two-family split (issue #1051), and the family's bundled script (#1065).
 *
 * The families are meant to partition the field: a car either has a pit limiter
 * or it does not, and exactly one family should speak to it. The tests below
 * pin that as mutual exclusivity plus joint exhaustiveness over KNOWN telemetry,
 * with both families silent when telemetry is unknown — which is the case a
 * bare `!hasPitLimiter(t)` would have got wrong, loudly.
 *
 * The entry line's spoken limit is one optional clause of three vars; the
 * fire-through cases prove it plays whole when the snapshot has a number the
 * voice can say and drops whole — never a dangling intro — when it does not.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SessionStartSnapshot, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  lacksPitLimiter,
  NO_LIMITER_CLIP_SOURCES,
  NO_LIMITER_CONTRACTS,
  NO_LIMITER_ENTRY,
  NO_LIMITER_SCENARIO_IDS,
  NO_LIMITER_SPEEDING,
  registerNoLimiterVocabulary,
} from "./no-limiter.js";
import { LIMITER_SPEEDING } from "./pit-limiter.js";

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
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry?: unknown) => void;
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
      const set = handlers.get(event.event as SimEventName);

      if (!set) return;

      for (const handler of Array.from(set)) handler(event);
    },
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry: unknown = null) {
      this.publish({ event: name, timestamp: Date.now(), telemetry, data: data as never } as SimEventOf<SimEventName>);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _played: { channel: AudioChannel; path: string; loop: boolean }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
  };
  const played: { channel: AudioChannel; path: string; loop: boolean }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string, loop = false) => {
      played.push({ channel, path, loop });

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

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const WITH_LIMITER: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false };
const NO_LIMITER: Partial<TelemetryData> = {};

function envelope(event: string, telemetry: Partial<TelemetryData> | null): SimEventOf<SimEventName> {
  return { event, timestamp: 0, telemetry, data: {} } as unknown as SimEventOf<SimEventName>;
}

function fires(contract: ScenarioContract, env: SimEventOf<SimEventName>): boolean {
  const where = contract.when?.where;

  if (!where) throw new Error(`${contract.id} is expected to have a where predicate`);

  return where(env);
}

const VOICE = "luca";

/**
 * One clip per source for the test voice, plus the three groups the spoken
 * limit's vars draw from — with ONE number (60), so a snapshot naming any
 * other limit is a number the voice cannot say.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...NO_LIMITER_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    `voice/${VOICE}/session-start/pit-speed-intro.mp3`,
    `voice/${VOICE}/session-start-speed-numbers/60.mp3`,
    `voice/${VOICE}/pit-limiter/unit-kmh.mp3`,
    `voice/${VOICE}/pit-limiter/unit-mph.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the family's own entries (and to no
 * fragments — neither includes one). The engine here registers the no-limiter
 * family ALONE, and an entry for a contract it does not hold would be a
 * `no contract` warn.
 */
const NO_LIMITER_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(NO_LIMITER_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

const SNAPSHOT_60_KMH: SessionStartSnapshot = {
  driverName: "driver",
  sessionType: "practice",
  pitSpeedLimit: 60,
  speedUnit: "kmh",
  trackTemp: 30,
  airTemp: 20,
  tempUnit: "celsius",
  wetness: 1,
};

describe("lacksPitLimiter — the negated gate is not a bare negation", () => {
  it("is false for null telemetry, so the family stays silent when it cannot see the car", () => {
    // The regression this exists for: `hasPitLimiter(null)` is false, so a bare
    // `!hasPitLimiter(t)` would return TRUE here and fire the no-limiter
    // callouts on unknown data — including for cars that DO have a limiter.
    expect(lacksPitLimiter(null)).toBe(false);
  });

  it("is true only when telemetry is present and the capability field is absent", () => {
    expect(lacksPitLimiter(NO_LIMITER as TelemetryData)).toBe(true);
  });

  it("is false when the car has a limiter, whatever the field's value", () => {
    expect(lacksPitLimiter({ dcPitSpeedLimiterToggle: false } as TelemetryData)).toBe(false);
    expect(lacksPitLimiter({ dcPitSpeedLimiterToggle: true } as TelemetryData)).toBe(false);
  });
});

describe("no-limiter where: predicates", () => {
  for (const [name, contract, event] of [
    ["NO_LIMITER_SPEEDING", NO_LIMITER_SPEEDING, "limiter.speeding"],
    ["NO_LIMITER_ENTRY", NO_LIMITER_ENTRY, "pitLane.entered"],
  ] as const) {
    describe(name, () => {
      it("fires on a car with no pit limiter", () => {
        expect(fires(contract, envelope(event, NO_LIMITER))).toBe(true);
      });

      it("does NOT fire on a limiter-equipped car — that is the other family's line", () => {
        expect(fires(contract, envelope(event, WITH_LIMITER))).toBe(false);
      });

      it("does NOT fire on unknown telemetry", () => {
        expect(fires(contract, envelope(event, null))).toBe(false);
      });
    });
  }
});

describe("the two families partition the field (issue #1051)", () => {
  const speeding = (telemetry: Partial<TelemetryData> | null): boolean[] => [
    fires(LIMITER_SPEEDING, envelope("limiter.speeding", telemetry)),
    fires(NO_LIMITER_SPEEDING, envelope("limiter.speeding", telemetry)),
  ];

  it("speaks exactly once to a car that has a limiter", () => {
    expect(speeding(WITH_LIMITER)).toEqual([true, false]);
  });

  it("speaks exactly once to a car that has none — the driver who most needs telling", () => {
    expect(speeding(NO_LIMITER)).toEqual([false, true]);
  });

  it("stays silent on both when telemetry is unknown, rather than guessing", () => {
    expect(speeding(null)).toEqual([false, false]);
  });
});

describe("NO_LIMITER_CONTRACTS structure (issue #1065)", () => {
  it("defines the two contracts, in the published order", () => {
    expect(NO_LIMITER_SCENARIO_IDS).toEqual(["pit-crew.no-limiter-speeding", "pit-crew.no-limiter-entry"]);
    expect(NO_LIMITER_CONTRACTS.map((c) => c.id)).toEqual(NO_LIMITER_SCENARIO_IDS);
  });

  it("keeps every scheduling field verbatim — the legacy `pit-crew` base included — and carries no sequence", () => {
    for (const c of NO_LIMITER_CONTRACTS) {
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("pit-crew");
      expect(c.family).toBe("limiter");
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).toBeUndefined();
      expect(c.queueable).toBeUndefined();
      expect(c.triggerDelay).toBeUndefined();
      expect(c.frame).toBeUndefined();
      expect("sequence" in c).toBe(false);
    }

    expect(NO_LIMITER_SPEEDING.when?.event).toBe("limiter.speeding");
    expect(NO_LIMITER_ENTRY.when?.event).toBe("pitLane.entered");
  });
});

describe("no-limiter through the engine and the bundled script (issue #1065)", () => {
  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let engine: IScenarioEngine;
  let snapshot: SessionStartSnapshot | null;

  beforeEach(() => {
    snapshot = null;
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    // The production order (`registerPitCrew`): vocabulary, contracts, then the script.
    registerNoLimiterVocabulary(engine, () => snapshot);

    for (const c of NO_LIMITER_CONTRACTS) engine.defineContract(c);

    engine.setScripts(new Map([[VOICE, NO_LIMITER_SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  function voiceClipsPlayed(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  describe("registerNoLimiterVocabulary", () => {
    it("publishes the three spoken-limit vars, each with a description naming its clip group, and nothing else", () => {
      const { vars, conds, cases } = engine.vocabulary();

      expect(conds).toEqual([]);
      expect(cases).toEqual([]);
      expect(vars.map((v) => v.name)).toEqual(["pitSpeed.limitIntro", "pitSpeed.limitNumber", "pitSpeed.limitUnit"]);

      for (const v of vars) expect(v.description.length, v.name).toBeGreaterThan(0);

      expect(vars.find((v) => v.name === "pitSpeed.limitIntro")?.description).toContain(
        "session-start/pit-speed-intro",
      );
      expect(vars.find((v) => v.name === "pitSpeed.limitNumber")?.description).toContain("session-start-speed-numbers");
      expect(vars.find((v) => v.name === "pitSpeed.limitUnit")?.description).toContain("pit-limiter/unit-");
    });
  });

  describe("fires", () => {
    it("the speeding line plays on a car with no limiter, inside the radio frame", () => {
      bus.publishEvent("limiter.speeding", {} as never, NO_LIMITER);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-limiter/no-limiter-speeding-01.mp3`]);
      expect(audio._played[0]?.path).toBe("sfx/IRD-tick-open.mp3");
      expect(audio._played.at(-1)?.path).toBe("sfx/IRD-tick-close.mp3");
    });

    it("the entry line speaks the limit — intro, number, unit — when the snapshot names a number the voice can say", () => {
      snapshot = SNAPSHOT_60_KMH;

      bus.publishEvent("pitLane.entered", {} as never, NO_LIMITER);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([
        `voice/${VOICE}/pit-limiter/entry-01.mp3`,
        `voice/${VOICE}/session-start/pit-speed-intro.mp3`,
        `voice/${VOICE}/session-start-speed-numbers/60.mp3`,
        `voice/${VOICE}/pit-limiter/unit-kmh.mp3`,
      ]);
    });

    it("the entry line drops the WHOLE limit clause — never a dangling intro — when there is no snapshot", () => {
      snapshot = null;

      bus.publishEvent("pitLane.entered", {} as never, NO_LIMITER);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-limiter/entry-01.mp3`]);
    });

    it("the entry line drops the WHOLE limit clause when the voice has no clip for the number", () => {
      snapshot = { ...SNAPSHOT_60_KMH, pitSpeedLimit: 61 };

      bus.publishEvent("pitLane.entered", {} as never, NO_LIMITER);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-limiter/entry-01.mp3`]);
    });

    it("a voice with no script is silent — the contract alone says nothing", () => {
      engine.setScripts(new Map());

      bus.publishEvent("limiter.speeding", {} as never, NO_LIMITER);
      flush(audio);

      expect(audio._played).toEqual([]);
    });
  });

  describe("the bundled script's no-limiter entries", () => {
    it("scripts both contracts with a comment, a No Pit Limiter harness route and a sequence", () => {
      for (const id of NO_LIMITER_SCENARIO_IDS) {
        const entry = SCRIPT.scenarios[id];

        expect(entry, `no script entry for ${id}`).toBeDefined();
        expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
        expect(entry.test, `${id}: test`).toMatch(/^Harness → No Pit Limiter → /);
        expect(entry.skip).toBeUndefined();
        expect(entry.frame).toBeUndefined();
      }
    });

    it("plays the speeding line plain, and the entry line with the spoken limit as ONE optional clause", () => {
      expect(SCRIPT.scenarios["pit-crew.no-limiter-speeding"].sequence).toEqual([
        "pool:pit-limiter/no-limiter-speeding",
      ]);
      expect(SCRIPT.scenarios["pit-crew.no-limiter-entry"].sequence).toEqual([
        "pool:pit-limiter/entry",
        { optional: ["{{pitSpeed.limitIntro}}", "{{pitSpeed.limitNumber}}", "{{pitSpeed.limitUnit}}"] },
      ]);
    });

    it("references only the three vars the family registers — no condition, case, fragment or frame", () => {
      const refs = collectScriptReferences(NO_LIMITER_SCRIPT);
      const vocabulary = engine.vocabulary();

      expect(refs.conds).toEqual([]);
      expect(refs.cases).toEqual([]);
      expect(refs.includes).toEqual([]);
      expect(refs.frames).toEqual([]);
      expect(refs.vars).toEqual(["pitSpeed.limitIntro", "pitSpeed.limitNumber", "pitSpeed.limitUnit"]);

      for (const v of refs.vars) {
        expect(vocabulary.vars.map((x) => x.name)).toContain(v);
      }
    });

    it("addresses exactly the published clip sources — the slashed form, no named pool — and every one has a clip in the bundled voice", () => {
      const sources = ["pit-limiter/entry", "pit-limiter/no-limiter-speeding"];

      expect([...collectScriptReferences(NO_LIMITER_SCRIPT).pools].sort()).toEqual(sources);
      expect(NO_LIMITER_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
      expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

      for (const { group, base } of NO_LIMITER_CLIP_SOURCES) {
        const pattern = poolMemberPattern(group, base);

        expect(
          MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
          `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
        ).toBe(true);
        expect(
          manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
          `fixture manifest carries no ${group}/${base} for the test voice`,
        ).toBe(true);
      }
    });

    it("the bundled voice ships the var-driven groups the limit clause draws from", () => {
      for (const [group, base] of [
        ["session-start", "pit-speed-intro"],
        ["session-start-speed-numbers", "60"],
        ["pit-limiter", "unit-kmh"],
        ["pit-limiter", "unit-mph"],
      ] as const) {
        const pattern = poolMemberPattern(group, base);

        expect(
          MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
          `${group}/${base}`,
        ).toBe(true);
      }
    });

    it("compiles for the test voice with nothing skipped — no unknown pool, var, fragment or frame", () => {
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
