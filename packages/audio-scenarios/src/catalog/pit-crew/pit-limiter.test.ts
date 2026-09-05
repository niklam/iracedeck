/**
 * Pit-limiter contracts: their `where:` predicates, the speak-time gates the
 * bundled script wraps the two delayed warnings in, and the script itself
 * (issue #1051; scripted since #1065).
 *
 * Two contracts of behaviour live here.
 *
 * The equipment gate (issue #639): on a car with no pit limiter
 * (`dcPitSpeedLimiterToggle` absent ⇒ `hasPitLimiter` false), none of them fire.
 * Since #1051 that is not merely suppression — the no-limiter car gets its own
 * family instead, so the complementary half of this contract lives in
 * `no-limiter.test.ts`, which asserts the two partition the field rather than
 * leaving a gap.
 *
 * The telemetry SOURCE (issue #1051): `LIMITER_ON_TRACK` and `LIMITER_MISSING`
 * are `triggerDelay` contracts whose predicates read `getLatestTelemetry()`
 * rather than the event envelope, because the interpreter re-runs `where:`
 * after the delay with the ORIGINAL envelope — whose telemetry was captured
 * before the window. So the tests below drive the LIVE snapshot, and hand the
 * envelope a contradicting one wherever the two could be confused: a predicate
 * "simplified" back to `e.telemetry` fails them. The same predicates are the
 * `limiter.still*` conditions the script wraps each body in, so the
 * fire-through cases prove the gate holds at speak time too. The end-to-end
 * half with the real registration (opt-ins, the family split) lives in
 * `register-pit-crew.test.ts`.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  LIMITER_DROPPED,
  LIMITER_MISSING,
  LIMITER_MISSING_DELAY_MS,
  LIMITER_ON_TRACK,
  LIMITER_ON_TRACK_DELAY_MS,
  LIMITER_SPEEDING,
  PIT_LIMITER_CLIP_SOURCES,
  PIT_LIMITER_CONTRACTS,
  PIT_LIMITER_SCENARIO_IDS,
  registerPitLimiterVocabulary,
} from "./pit-limiter.js";

// Live-telemetry feed for the two delayed predicates, mirroring how
// `flag-alerts.test.ts` drives its speak-time `Furled` gate. `null` (the
// default) is "no live signal", which every predicate here must read as "cannot
// see the car" and stay silent on.
const mockLatestTelemetry = vi.fn((): unknown => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
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

// Live snapshots for the two delayed contracts. `hasPitLimiter` tests for the
// PRESENCE of `dcPitSpeedLimiterToggle`, never its value, so all four of these
// are equipped cars.
const ENGAGED_OFF_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: true, OnPitRoad: false };
const DISENGAGED_OFF_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false, OnPitRoad: false };
const ENGAGED_ON_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: true, OnPitRoad: true };
const DISENGAGED_ON_PIT_ROAD: Partial<TelemetryData> = { dcPitSpeedLimiterToggle: false, OnPitRoad: true };

function envelope(event: string, data: unknown, telemetry: Partial<TelemetryData> | null): SimEventOf<SimEventName> {
  return { event, timestamp: 0, telemetry, data } as unknown as SimEventOf<SimEventName>;
}

function fires(contract: ScenarioContract, env: SimEventOf<SimEventName>): boolean {
  const where = contract.when?.where;

  if (!where) throw new Error(`${contract.id} is expected to have a where predicate`);

  return where(env);
}

/**
 * Evaluate a delayed predicate against a live snapshot.
 *
 * The envelope deliberately carries a snapshot the predicate must IGNORE:
 * `null` telemetry, which every predicate here treats as "cannot see the car,
 * stay silent". So an `e.telemetry`-reading predicate can only ever return
 * false through this helper, and each `toBe(true)` below is an assertion about
 * the source as much as about the condition.
 */
function firesLive(contract: ScenarioContract, event: string, live: Partial<TelemetryData> | null): boolean {
  mockLatestTelemetry.mockReturnValue(live);

  return fires(contract, envelope(event, {}, null));
}

const VOICE = "luca";

/**
 * One clip per source for the test voice, so a pool draw is deterministic and
 * a played path names its pool — plus one clip for the test-only blocker line
 * the deferral cases hold the bus with.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...PIT_LIMITER_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    `voice/${VOICE}/blocker/line-01.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the family's own entries (and to no
 * fragments — none of them includes one). The engine here registers the
 * pit-limiter family ALONE, and an entry for a contract it does not hold
 * would be a `no contract` warn.
 */
const PIT_LIMITER_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(PIT_LIMITER_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

beforeEach(() => {
  mockLatestTelemetry.mockReturnValue(null);
});

describe("pit-limiter where: predicates — no-limiter suppression (issue #639)", () => {
  describe("LIMITER_ON_TRACK (pitLane.exited, delayed)", () => {
    it("fires on a limiter-equipped car still holding the limiter out on track", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", ENGAGED_OFF_PIT_ROAD)).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", { ...NO_LIMITER, OnPitRoad: false })).toBe(false);
    });

    it("does NOT fire once the limiter is disengaged", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", DISENGAGED_OFF_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire while still on pit road (expected behaviour, even with a limiter)", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", ENGAGED_ON_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire when live telemetry is unknown", () => {
      expect(firesLive(LIMITER_ON_TRACK, "pitLane.exited", null)).toBe(false);
    });

    // The source assertion stated head-on: the envelope says everything the
    // callout wants to hear, while the live snapshot says the driver has
    // already switched the limiter off. Reading the envelope scolds that driver.
    it("reads the LIVE snapshot, not the envelope's stale one", () => {
      mockLatestTelemetry.mockReturnValue(DISENGAGED_OFF_PIT_ROAD);

      expect(fires(LIMITER_ON_TRACK, envelope("pitLane.exited", {}, ENGAGED_OFF_PIT_ROAD))).toBe(false);
    });
  });

  describe("LIMITER_MISSING (limiter.missing, delayed)", () => {
    it("fires on a limiter-equipped car still on pit road without it engaged", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", DISENGAGED_ON_PIT_ROAD)).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", { ...NO_LIMITER, OnPitRoad: true })).toBe(false);
    });

    it("does NOT fire once the limiter is engaged — the earlier nudge was heeded", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", ENGAGED_ON_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire once the car has left pit road", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", DISENGAGED_OFF_PIT_ROAD)).toBe(false);
    });

    it("does NOT fire when live telemetry is unknown", () => {
      expect(firesLive(LIMITER_MISSING, "limiter.missing", null)).toBe(false);
    });

    // Mirror of the LIMITER_ON_TRACK case above: the envelope still shows the
    // limiter off on pit road, the live snapshot shows it engaged.
    it("reads the LIVE snapshot, not the envelope's stale one", () => {
      mockLatestTelemetry.mockReturnValue(ENGAGED_ON_PIT_ROAD);

      expect(fires(LIMITER_MISSING, envelope("limiter.missing", {}, DISENGAGED_ON_PIT_ROAD))).toBe(false);
    });
  });

  // The two undelayed contracts, which read the envelope and only the envelope.
  describe.each([
    ["LIMITER_DROPPED", LIMITER_DROPPED, "limiter.dropped"],
    ["LIMITER_SPEEDING", LIMITER_SPEEDING, "limiter.speeding"],
  ] as const)("%s (%s)", (_name, contract, event) => {
    it("fires on a limiter-equipped car", () => {
      expect(fires(contract, envelope(event, {}, WITH_LIMITER))).toBe(true);
    });

    it("does NOT fire on a car with no pit limiter", () => {
      expect(fires(contract, envelope(event, {}, NO_LIMITER))).toBe(false);
    });

    it("does NOT fire when telemetry is null", () => {
      expect(fires(contract, envelope(event, {}, null))).toBe(false);
    });
  });
});

describe("PIT_LIMITER_CONTRACTS structure (issue #1065)", () => {
  it("defines the four contracts, in the published order", () => {
    expect(PIT_LIMITER_SCENARIO_IDS).toEqual([
      "pit-crew.limiter-on-track",
      "pit-crew.limiter-missing",
      "pit-crew.limiter-dropped",
      "pit-crew.limiter-speeding",
    ]);
    expect(PIT_LIMITER_CONTRACTS.map((c) => c.id)).toEqual(PIT_LIMITER_SCENARIO_IDS);
  });

  it("keeps every scheduling field verbatim — the legacy `pit-crew` base included — and carries no sequence", () => {
    for (const c of PIT_LIMITER_CONTRACTS) {
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("pit-crew");
      expect(c.family).toBe("limiter");
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).toBeUndefined();
      expect(c.frame).toBeUndefined();
      expect("sequence" in c).toBe(false);
    }

    expect(LIMITER_ON_TRACK.triggerDelay).toBe(LIMITER_ON_TRACK_DELAY_MS);
    expect(LIMITER_ON_TRACK.queueable).toBe(true);
    expect(LIMITER_MISSING.triggerDelay).toBe(LIMITER_MISSING_DELAY_MS);
    expect(LIMITER_MISSING.queueable).toBe(true);
    expect(LIMITER_DROPPED.triggerDelay).toBeUndefined();
    expect(LIMITER_DROPPED.queueable).toBeUndefined();
    expect(LIMITER_SPEEDING.triggerDelay).toBeUndefined();
    expect(LIMITER_SPEEDING.queueable).toBeUndefined();
  });
});

describe("pit-limiter through the engine and the bundled script (issue #1065)", () => {
  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let engine: IScenarioEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    // The production order (`registerPitCrew`): vocabulary, contracts, then the script.
    registerPitLimiterVocabulary(engine);

    for (const c of PIT_LIMITER_CONTRACTS) engine.defineContract(c);

    engine.setScripts(new Map([[VOICE, PIT_LIMITER_SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function voiceClipsPlayed(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  describe("registerPitLimiterVocabulary", () => {
    it("publishes the two delayed re-checks as conditions, each with a description for a pack author, and nothing else", () => {
      const { vars, conds, cases } = engine.vocabulary();

      expect(vars).toEqual([]);
      expect(cases).toEqual([]);
      expect(conds.map((c) => c.name)).toEqual(["limiter.stillEngagedOffPitRoad", "limiter.stillMissingOnPitRoad"]);

      for (const c of conds) expect(c.description.length, c.name).toBeGreaterThan(0);
    });
  });

  describe("fires", () => {
    it("the on-track warning plays after its delay while the limiter is still engaged off pit road", () => {
      mockLatestTelemetry.mockReturnValue(ENGAGED_OFF_PIT_ROAD);
      bus.publishEvent("pitLane.exited", {} as never);
      flush(audio);

      // Nothing before the window closes.
      expect(audio._played).toEqual([]);

      vi.advanceTimersByTime(LIMITER_ON_TRACK_DELAY_MS);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-limiter/on-track-01.mp3`]);
      expect(audio._played[0]?.path).toBe("sfx/IRD-tick-open.mp3");
      expect(audio._played.at(-1)?.path).toBe("sfx/IRD-tick-close.mp3");
    });

    it("the missing warning plays after its delay while the limiter is still off on pit road", () => {
      mockLatestTelemetry.mockReturnValue(DISENGAGED_ON_PIT_ROAD);
      bus.publishEvent("limiter.missing", {} as never);
      vi.advanceTimersByTime(LIMITER_MISSING_DELAY_MS);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-limiter/missing-01.mp3`]);
    });

    it.each([
      { id: "dropped", event: "limiter.dropped" as const },
      { id: "speeding", event: "limiter.speeding" as const },
    ])("the $id warning plays at once on a limiter-equipped car", ({ id, event }) => {
      bus.publishEvent(event, {} as never, WITH_LIMITER);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-limiter/${id}-01.mp3`]);
    });

    it("a voice with no script is silent — the contract alone says nothing", () => {
      engine.setScripts(new Map());

      bus.publishEvent("limiter.dropped", {} as never, WITH_LIMITER);
      flush(audio);

      expect(audio._played).toEqual([]);
    });
  });

  // The script's gate is the SAME predicate as `where:`, read again when the
  // fire comes to speak. Observable here by flipping the live snapshot between
  // the fire decision and the expansion: a fire that was allowed and then
  // queued behind a busier line would otherwise speak a stale warning.
  describe("the speak-time gate in the script", () => {
    it("the on-track body expands to silence — no tick either — once the limiter is off by the time it speaks", () => {
      // A busy bus: a HEAVIER, family-less line on an unrelated event holds
      // the Voice channel when the on-track window closes, so the delayed
      // fire is deferred (`queueable: true`) rather than played or dropped,
      // and replays — re-expanding the script — once the blocker finishes.
      engine.defineContract({
        id: "test.blocker",
        when: { event: "flag.red.raised" },
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        base: "voice/{voice}",
        weight: 70,
      });
      engine.setScripts(
        new Map([
          [
            VOICE,
            {
              ...PIT_LIMITER_SCRIPT,
              scenarios: { ...PIT_LIMITER_SCRIPT.scenarios, "test.blocker": { sequence: ["pool:blocker/line"] } },
            },
          ],
        ]),
      );

      mockLatestTelemetry.mockReturnValue(ENGAGED_OFF_PIT_ROAD);
      bus.publishEvent("pitLane.exited", {} as never);
      bus.publishEvent("flag.red.raised", {} as never);
      // Let the blocker's open tick finish so its voice clip is the thing
      // playing — and leave it playing.
      audio._triggerChannelEnd(AudioChannel.SFX);
      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/blocker/line-01.mp3`]);

      vi.advanceTimersByTime(LIMITER_ON_TRACK_DELAY_MS);

      // The driver switches the limiter off while the warning waits.
      mockLatestTelemetry.mockReturnValue(DISENGAGED_OFF_PIT_ROAD);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/blocker/line-01.mp3`]);
      // Only the blocker's own frame played: an empty body gets no ticks.
      expect(audio._played.filter((p) => p.channel === AudioChannel.SFX)).toHaveLength(2);
    });

    it("the same deferral replays the warning when the limiter is STILL on — the gate is the only thing that silenced it above", () => {
      engine.defineContract({
        id: "test.blocker",
        when: { event: "flag.red.raised" },
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        base: "voice/{voice}",
        weight: 70,
      });
      engine.setScripts(
        new Map([
          [
            VOICE,
            {
              ...PIT_LIMITER_SCRIPT,
              scenarios: { ...PIT_LIMITER_SCRIPT.scenarios, "test.blocker": { sequence: ["pool:blocker/line"] } },
            },
          ],
        ]),
      );

      mockLatestTelemetry.mockReturnValue(ENGAGED_OFF_PIT_ROAD);
      bus.publishEvent("pitLane.exited", {} as never);
      bus.publishEvent("flag.red.raised", {} as never);
      audio._triggerChannelEnd(AudioChannel.SFX);
      vi.advanceTimersByTime(LIMITER_ON_TRACK_DELAY_MS);
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([
        `voice/${VOICE}/blocker/line-01.mp3`,
        `voice/${VOICE}/pit-limiter/on-track-01.mp3`,
      ]);
    });
  });

  describe("the bundled script's pit-limiter entries", () => {
    it("scripts every contract with a comment, a Pit Limiter harness route and a sequence", () => {
      for (const id of PIT_LIMITER_SCENARIO_IDS) {
        const entry = SCRIPT.scenarios[id];

        expect(entry, `no script entry for ${id}`).toBeDefined();
        expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
        expect(entry.test, `${id}: test`).toMatch(/^Harness → Pit Limiter → /);
        expect(entry.skip).toBeUndefined();
        expect(entry.frame).toBeUndefined();
        expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
      }
    });

    it("wraps the two delayed warnings' whole bodies in their re-check, and plays the other two plain", () => {
      expect(SCRIPT.scenarios["pit-crew.limiter-on-track"].sequence).toEqual([
        { if: "limiter.stillEngagedOffPitRoad", then: ["pool:pit-limiter/on-track"] },
      ]);
      expect(SCRIPT.scenarios["pit-crew.limiter-missing"].sequence).toEqual([
        { if: "limiter.stillMissingOnPitRoad", then: ["pool:pit-limiter/missing"] },
      ]);
      expect(SCRIPT.scenarios["pit-crew.limiter-dropped"].sequence).toEqual(["pool:pit-limiter/dropped"]);
      expect(SCRIPT.scenarios["pit-crew.limiter-speeding"].sequence).toEqual(["pool:pit-limiter/speeding"]);
    });

    it("references only the two conditions the family registers — no var, case, fragment or frame", () => {
      const refs = collectScriptReferences(PIT_LIMITER_SCRIPT);
      const vocabulary = engine.vocabulary();

      expect(refs.vars).toEqual([]);
      expect(refs.cases).toEqual([]);
      expect(refs.includes).toEqual([]);
      expect(refs.frames).toEqual([]);
      expect(refs.conds).toEqual(["limiter.stillEngagedOffPitRoad", "limiter.stillMissingOnPitRoad"]);

      for (const cond of refs.conds) {
        expect(vocabulary.conds.map((c) => c.name)).toContain(cond);
      }
    });

    it("addresses exactly the published clip sources — the slashed form, no named pool — and every one has a clip in the bundled voice", () => {
      const sources = ["pit-limiter/dropped", "pit-limiter/missing", "pit-limiter/on-track", "pit-limiter/speeding"];

      expect([...collectScriptReferences(PIT_LIMITER_SCRIPT).pools].sort()).toEqual(sources);
      expect(PIT_LIMITER_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
      expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

      for (const { group, base } of PIT_LIMITER_CLIP_SOURCES) {
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

    it("compiles for the test voice with nothing skipped — no unknown pool, condition, case key or fragment", () => {
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});
