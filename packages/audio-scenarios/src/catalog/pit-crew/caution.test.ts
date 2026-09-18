/**
 * The full-course caution family (issue #1127).
 *
 * Eight contracts over the translator's caution events plus the caution flag
 * itself. The assertions here are about WHEN each one fires and how it is
 * scheduled — what it says is the bundled voice's script, which does not exist
 * yet, so the cases are structural but for one: the follow call's scheduling
 * beside the existing caution-flag line is driven through the real engine
 * against a two-entry synthetic script, because no structural assertion can
 * tell deferring apart from cutting.
 *
 * Three behaviours are load-bearing enough to get their own cases, because
 * each was measured rather than assumed (the 2026-09-17 Homestead capture):
 *
 * - the two pace-car events are DELIBERATELY generic — the same pair of
 *   transitions fires at a rolling start (deployed 132.35, off 196.53, both
 *   with `SessionState` ParadeLaps) as under a caution — so the two pace-car
 *   contracts gate on the translator's caution state;
 * - `caution.lineup.changed` lands ONE TICK BEFORE `caution.oneLapToGreen`
 *   in both captured cautions (415.10 / 415.12 and 793.92 / 793.93), because
 *   the field re-forms double file on the tick before the flag, so the
 *   lineup-change call holds its decision and then finds the one-to-go call
 *   already owns the moment;
 * - the pace rows are assigned ~50 ms AFTER the caution flag (239.88 →
 *   239.93), so the follow call cannot read the lineup on the flag's own tick.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { Flags, SessionState } from "@iracedeck/iracing-sdk";
import type { CautionLineup } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import {
  buildCautionContracts,
  CAUTION_CALLOUT_SETTING_KEYS,
  CAUTION_FOLLOW_DELAY_MS,
  CAUTION_LINEUP_CHANGE_DELAY_MS,
  CAUTION_SCENARIO_IDS,
  type CautionCalloutId,
  cautionScenarioId,
  POSITION_NUMBER_MAX,
  registerCautionVocabulary,
  SCENARIO_ID_TO_CAUTION_ID,
} from "./caution.js";
import { FLAG_CONTRACTS, WAVING_FLAG_COOLDOWN_MS } from "./flag-alerts.js";

const mockSessionType = vi.fn(() => "Race");
const mockStandingStart = vi.fn(() => false);
const mockLatestTelemetry = vi.fn((): unknown => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
  getStandingStart: () => mockStandingStart(),
  getLatestTelemetry: () => mockLatestTelemetry(),
}));

/** Driver live in their own car, racing — what every contract's shared gate needs. */
const IN_CAR = { IsOnTrack: true, IsReplayPlaying: false, SessionState: SessionState.Racing };

/** The bundled voice's real script and manifest, for the expansion cases at the end — the `bundled-scripts.test.ts` casts. */
const BUNDLED_SCRIPT = defaultScript as CalloutScript;
const BUNDLED_MANIFEST: AudioAssetsManifest = manifestJson;

const IDS: readonly CautionCalloutId[] = [
  "follow",
  "pace-car-out",
  "field-caught",
  "extra-lap",
  "one-to-go",
  "lineup-changed",
  "pace-car-off",
  "restart",
];

/** Which event each callout rides — the whole point of the family. */
const EVENT_OF: Record<CautionCalloutId, SimEventName> = {
  follow: "flag.caution-waving.raised",
  "pace-car-out": "paceCar.deployed",
  "field-caught": "caution.fieldCaught",
  "extra-lap": "caution.extraLap",
  "one-to-go": "caution.oneLapToGreen",
  "lineup-changed": "caution.lineup.changed",
  "pace-car-off": "paceCar.off",
  restart: "caution.restarted",
};

/** The two contracts whose event also fires outside a caution. */
const PACE_CAR_IDS: readonly CautionCalloutId[] = ["pace-car-out", "pace-car-off"];

let underCaution: boolean;

function contracts(): readonly ScenarioContract[] {
  return buildCautionContracts(() => underCaution);
}

function contract(id: CautionCalloutId): ScenarioContract {
  const found = contracts().find((c) => c.id === `pit-crew.caution-${id}`);

  if (!found) throw new Error(`contract not found: ${id}`);

  return found;
}

function event(id: CautionCalloutId, telemetry: unknown = IN_CAR): SimEventOf<SimEventName> {
  return {
    event: EVENT_OF[id],
    timestamp: 0,
    telemetry,
    data: {},
  } as unknown as SimEventOf<SimEventName>;
}

function fires(id: CautionCalloutId, telemetry: unknown = IN_CAR): boolean {
  return contract(id).when?.where?.(event(id, telemetry)) !== false;
}

const LINEUP: CautionLineup = {
  followCarIdx: 7,
  followCarNumber: "09",
  line: "inside",
  isLeader: false,
  followsPaceCar: false,
  doubleFile: true,
  restartPosition: 14,
};

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus {
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
    publish: (e: SimEventOf<SimEventName>) => {
      for (const handler of Array.from(handlers.get(e.event as SimEventName) ?? [])) handler(e);
    },
  } as unknown as IEventBus;
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

function makeVocabEngine(): {
  engine: IScenarioEngine;
  vars: Map<string, () => unknown>;
  conds: Map<string, () => unknown>;
  cases: Map<string, () => unknown>;
  keys: Map<string, Readonly<Record<string, string>>>;
  descriptions: Map<string, string>;
} {
  const vars = new Map<string, () => unknown>();
  const conds = new Map<string, () => unknown>();
  const cases = new Map<string, () => unknown>();
  const keys = new Map<string, Readonly<Record<string, string>>>();
  const descriptions = new Map<string, string>();
  const stub = {
    defineVar: vi.fn((name: string, fn: () => unknown, description = "") => {
      vars.set(name, fn);
      descriptions.set(name, description);
    }),
    defineCond: vi.fn((name: string, fn: () => unknown, description: string) => {
      conds.set(name, fn);
      descriptions.set(name, description);
    }),
    defineCase: vi.fn((name: string, fn: () => unknown, k: Record<string, string>, description: string) => {
      cases.set(name, fn);
      keys.set(name, k);
      descriptions.set(name, description);
    }),
  } as unknown as IScenarioEngine;

  return { engine: stub, vars, conds, cases, keys, descriptions };
}

beforeEach(() => {
  vi.clearAllMocks();
  underCaution = true;
  mockSessionType.mockReturnValue("Race");
  mockStandingStart.mockReturnValue(false);
  mockLatestTelemetry.mockReturnValue(null);
});

describe("the caution contracts", () => {
  it("exports the eight scenario ids, in the order the caution runs", () => {
    expect(CAUTION_SCENARIO_IDS).toEqual([
      "pit-crew.caution-follow",
      "pit-crew.caution-pace-car-out",
      "pit-crew.caution-field-caught",
      "pit-crew.caution-extra-lap",
      "pit-crew.caution-one-to-go",
      "pit-crew.caution-lineup-changed",
      "pit-crew.caution-pace-car-off",
      "pit-crew.caution-restart",
    ]);
  });

  it("maps every scenario id to its callout id and every callout id to its setting key", () => {
    expect(SCENARIO_ID_TO_CAUTION_ID).toEqual({
      "pit-crew.caution-follow": "follow",
      "pit-crew.caution-pace-car-out": "pace-car-out",
      "pit-crew.caution-field-caught": "field-caught",
      "pit-crew.caution-extra-lap": "extra-lap",
      "pit-crew.caution-one-to-go": "one-to-go",
      "pit-crew.caution-lineup-changed": "lineup-changed",
      "pit-crew.caution-pace-car-off": "pace-car-off",
      "pit-crew.caution-restart": "restart",
    });

    expect(CAUTION_CALLOUT_SETTING_KEYS).toEqual({
      follow: "calloutEnabledCautionFollow",
      "pace-car-out": "calloutEnabledCautionPaceCarOut",
      "field-caught": "calloutEnabledCautionFieldCaught",
      "extra-lap": "calloutEnabledCautionExtraLap",
      "one-to-go": "calloutEnabledCautionOneToGo",
      "lineup-changed": "calloutEnabledCautionLineupChanged",
      "pace-car-off": "calloutEnabledCautionPaceCarOff",
      restart: "calloutEnabledCautionRestart",
    });
  });

  it("maps every contract the family builds — an unmapped id makes registerPitCrew throw at plugin startup", () => {
    // The map is derived from the setting keys through the same id spelling
    // the contracts use, so a callout added to the family can never reach the
    // opt-in wrapper without a mapping. That wrapper's throw takes EVERY Race
    // Engineer callout down, not just this family's.
    const built = contracts();

    expect(built.length).toBe(IDS.length);

    for (const c of built) {
      const calloutId = SCENARIO_ID_TO_CAUTION_ID[c.id];

      expect(calloutId, `${c.id} has no callout id`).toBeDefined();
      expect(cautionScenarioId(calloutId)).toBe(c.id);
      expect(CAUTION_CALLOUT_SETTING_KEYS[calloutId], `${calloutId} has no setting key`).toBeDefined();
    }
  });

  it("rides one event each — the caution flag for the follow call, a translator caution event for the rest", () => {
    for (const id of IDS) expect(contract(id).when?.event).toBe(EVENT_OF[id]);
  });

  it("carries no sequence and takes the engine's default frame — what it says is the voice script's", () => {
    for (const id of IDS) {
      expect("sequence" in contract(id)).toBe(false);
      expect(contract(id).frame).toBeUndefined();
    }
  });

  it("speaks on the Voice channel and bus, under the active voice's base path", () => {
    for (const id of IDS) {
      expect(contract(id).channel).toBe(AudioChannel.Voice);
      expect(contract(id).bus).toBe(AudioBus.Voice);
      expect(contract(id).base).toBe("voice/{voice}");
    }
  });

  it("is queueable throughout — nothing in a caution sequence is ever dropped for a busy bus", () => {
    for (const id of IDS) expect(contract(id).queueable).toBe(true);
  });

  it("interrupts only for the restart, which lands on the driver's launch", () => {
    for (const id of IDS) {
      if (id === "restart") {
        expect(contract(id).interrupt).toBe(true);
        expect(contract(id).weight).toBe(WEIGHT.CRITICAL);
      } else {
        expect(contract(id).interrupt).toBeUndefined();
      }
    }
  });

  it("weighs the follow call one notch below the rest, so a tie in the pending slot costs it and not the caution announcement", () => {
    expect(contract("follow").weight).toBe(WEIGHT.SAFETY - 1);

    for (const id of IDS.filter((x) => x !== "follow" && x !== "restart")) {
      expect(contract(id).weight).toBe(WEIGHT.SAFETY);
    }
  });

  it("re-checks at speak time that the caution is still out — every call but the restart, which speaks as it ends", () => {
    for (const id of IDS) {
      if (id === "restart") {
        expect(contract(id).speakGate).toBeUndefined();
        continue;
      }

      expect(contract(id).speakGate?.description.length ?? 0).toBeGreaterThan(20);

      underCaution = true;
      expect(contract(id).speakGate?.admit({} as never)).toBe(true);

      // The case the gate exists for: a queueable fire parked behind a busy bus
      // replays without re-running `where:`, and the pending slot has no TTL,
      // so by the time it drains the caution can be long over.
      underCaution = false;
      expect(contract(id).speakGate?.admit({} as never)).toBe(false);
      underCaution = true;
    }
  });

  it("shares the flag family so a newer caution call supersedes a stale one — except the follow call, which pairs with the caution flag's own line", () => {
    for (const id of IDS) {
      if (id === "follow") {
        expect(contract(id).family).toBeUndefined();
      } else {
        expect(contract(id).family).toBe("flag");
      }
    }
  });

  it("carries a description sentence for every one — the pack-author reference publishes them", () => {
    for (const id of IDS) {
      expect(contract(id).description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("stays silent out of the car, outside a race, and after the checkered", () => {
    for (const id of IDS) {
      expect(fires(id)).toBe(true);

      expect(fires(id, { ...IN_CAR, IsOnTrack: false })).toBe(false);
      expect(fires(id, { ...IN_CAR, IsReplayPlaying: true })).toBe(false);
      expect(fires(id, { ...IN_CAR, SessionState: SessionState.Checkered })).toBe(false);

      mockSessionType.mockReturnValue("Practice");
      expect(fires(id)).toBe(false);
      mockSessionType.mockReturnValue("Race");
    }
  });

  it("speaks about the pace car only under a caution — the rolling start's pace car belongs to the start", () => {
    underCaution = false;

    for (const id of PACE_CAR_IDS) expect(fires(id)).toBe(false);

    for (const id of IDS.filter((x) => !PACE_CAR_IDS.includes(x) && x !== "lineup-changed")) {
      expect(fires(id)).toBe(true);
    }

    underCaution = true;

    for (const id of PACE_CAR_IDS) expect(fires(id)).toBe(true);
  });

  it("holds the follow call, because the pace rows land after the flag and the announcement needs the bus first", () => {
    expect(contract("follow").triggerDelay).toBe(CAUTION_FOLLOW_DELAY_MS);
    // The rows land 50 ms after the flag, so that half of the reason would be
    // satisfied by a fraction of a second. The binding half is the single
    // pending slot: the hold has to outlast the caution announcement (the
    // bundled clip is 2.95 s plus its frame) so the two rarely contend at all.
    // It is a rarity knob, not the correctness one — the weight above is what
    // decides a contest that does happen.
    expect(CAUTION_FOLLOW_DELAY_MS).toBeGreaterThanOrEqual(2500);
  });

  it("gives the follow call the caution flag's own cooldown — the bit re-raises on every re-approach", () => {
    expect(contract("follow").cooldown).toBe(WAVING_FLAG_COOLDOWN_MS);
  });
});

describe("the lineup-change call and the one-to-go flag", () => {
  it("holds its decision long enough for the one-to-go flag to land", () => {
    expect(contract("lineup-changed").triggerDelay).toBe(CAUTION_LINEUP_CHANGE_DELAY_MS);
    // The measured gap between the re-form and the flag is one tick (20 ms);
    // the hold has to clear it with room for a slower tick.
    expect(CAUTION_LINEUP_CHANGE_DELAY_MS).toBeGreaterThan(100);
  });

  it("stays quiet once the one-to-go flag is out — that call names the car and the line itself", () => {
    mockLatestTelemetry.mockReturnValue({ SessionFlags: Flags.Caution | Flags.OneLapToGreen });

    expect(fires("lineup-changed")).toBe(false);
  });

  it("speaks a mid-caution reorder, with the one-to-go flag not yet out", () => {
    mockLatestTelemetry.mockReturnValue({ SessionFlags: Flags.Caution });

    expect(fires("lineup-changed")).toBe(true);
  });

  it("speaks when there is no live telemetry to read — a missing signal never silences a call", () => {
    mockLatestTelemetry.mockReturnValue(null);

    expect(fires("lineup-changed")).toBe(true);
  });

  it("stays quiet once the caution is over, so a change held over the green cannot be spoken into the restart", () => {
    underCaution = false;
    mockLatestTelemetry.mockReturnValue({ SessionFlags: 0 });

    expect(fires("lineup-changed")).toBe(false);
  });

  it("leaves the one-to-go flag alone for every other call — only the held one consults it", () => {
    mockLatestTelemetry.mockReturnValue({ SessionFlags: Flags.Caution | Flags.OneLapToGreen });

    for (const id of IDS.filter((x) => x !== "lineup-changed" && !PACE_CAR_IDS.includes(x))) {
      expect(fires(id)).toBe(true);
    }
  });
});

/**
 * The follow call's missing `family` is the one scheduling choice here that no
 * structural assertion can justify on its own, so it is driven through the real
 * engine against a two-entry script: the existing caution-flag line, and the
 * follow line that rides the same event. The case carries its own positive
 * control — the same pair with `family: "flag"` restored, which is what the
 * rest of the family carries — so a run where neither ordering could be
 * distinguished would fail rather than pass twice.
 */
describe("the follow call beside the caution flag's own line", () => {
  const VOICE = "test";
  const CAUTION_CLIP = `voice/${VOICE}/flags/caution-waving-01.mp3`;
  const FOLLOW_CLIP = `voice/${VOICE}/caution/follow-01.mp3`;

  /** Stands in for the spotter holding the Voice bus when the caution comes out. */
  const HOG_CLIP = `voice/${VOICE}/flags/debris-01.mp3`;
  const HOG: ScenarioContract = {
    id: "pit-crew.flag-debris",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.PROXIMITY,
    when: { event: "flag.debris.raised" },
  };

  const manifest: AudioAssetsManifest = {
    clips: [
      "sfx/IRD-tick-open.mp3",
      "sfx/IRD-tick-close.mp3",
      "sfx/IRD-ambient-pit.mp3",
      CAUTION_CLIP,
      FOLLOW_CLIP,
      HOG_CLIP,
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  const script = {
    schema: 1,
    scenarios: {
      "pit-crew.flag-caution-waving": { comment: "c", test: "t", sequence: ["pool:flags/caution-waving"] },
      "pit-crew.caution-follow": { comment: "c", test: "t", sequence: ["pool:caution/follow"] },
      "pit-crew.flag-debris": { comment: "c", test: "t", sequence: ["pool:flags/debris"] },
    },
    // The engine wraps every body in the frame the contract names, and the
    // default is "radio" — a script without it has every entry skipped.
    frames: {
      radio: {
        comment: "f",
        open: [{ clip: "sfx/IRD-tick-open.mp3" }],
        close: [{ clip: "sfx/IRD-tick-close.mp3" }],
      },
    },
    pools: {},
    fragments: {},
  } as unknown as CalloutScript;

  function run(opts: { followFamily?: string; followWeight?: number; hogBus?: boolean } = {}): {
    played: () => string[];
    cutVoice: () => boolean;
    flush: () => void;
  } {
    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    const cautionWaving = FLAG_CONTRACTS.find((c) => c.id === "pit-crew.flag-caution-waving");

    if (!cautionWaving) throw new Error("the caution-waving flag contract is gone");

    engine.defineContract(cautionWaving);
    engine.defineContract({
      ...contract("follow"),
      family: "followFamily" in opts ? opts.followFamily : contract("follow").family,
      weight: opts.followWeight ?? contract("follow").weight,
    });

    if (opts.hogBus) engine.defineContract(HOG);

    engine.setScripts(new Map([[VOICE, script]]));

    if (opts.hogBus) {
      // Stands in for the spotter, which the capture measured holding the bus
      // when the caution came out. PROXIMITY outranks everything here, so both
      // caution lines can only queue behind it.
      bus.publish({
        event: "flag.debris.raised",
        timestamp: 0,
        telemetry: IN_CAR,
        data: {},
      } as unknown as SimEventOf<SimEventName>);
      audio._triggerChannelEnd(AudioChannel.SFX);
    }

    bus.publish({
      event: "flag.caution-waving.raised",
      timestamp: 0,
      telemetry: IN_CAR,
      data: {},
    } as unknown as SimEventOf<SimEventName>);

    // The radio frame's open tick plays on SFX first; the body reaches the
    // Voice channel only once that tick completes. Skipped when the hog holds
    // the Voice bus — nothing new is starting there.
    if (!opts.hogBus) audio._triggerChannelEnd(AudioChannel.SFX);

    return {
      played: () => audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path),
      cutVoice: () =>
        (audio.stopChannel as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (call) => call[0] === AudioChannel.Voice,
        ),
      flush: () => {
        for (let i = 0; i < 20; i++) {
          audio._triggerChannelEnd(AudioChannel.Voice);
          audio._triggerChannelEnd(AudioChannel.SFX);
        }
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetAudioScenarios();
  });

  it("waits for the caution line to finish and then speaks — both calls, in order", () => {
    const { played, cutVoice, flush } = run();

    expect(played()).toEqual([CAUTION_CLIP]);

    vi.advanceTimersByTime(CAUTION_FOLLOW_DELAY_MS + 1);

    // The follow fire found the bus busy and deferred: the caution line is
    // still the only thing that has reached the Voice channel, and nothing
    // stopped it.
    expect(cutVoice()).toBe(false);
    expect(played()).toEqual([CAUTION_CLIP]);

    flush();

    expect(played()).toEqual([CAUTION_CLIP, FOLLOW_CLIP]);
  });

  // `BusState.pending` is ONE slot and `setPending` replaces on
  // `weight >= pending.weight`, silently. Both calls ride the same event, so
  // with the bus held — the capture measured the spotter holding it when the
  // caution came out — they compete for that slot, and a tie would discard the
  // safety announcement in favour of a navigational detail.
  it("never evicts the caution announcement from the pending slot when the bus is held", () => {
    const { played, flush } = run({ hogBus: true });

    vi.advanceTimersByTime(CAUTION_FOLLOW_DELAY_MS + 1);
    flush();

    expect(played()).toEqual([HOG_CLIP, CAUTION_CLIP]);
  });

  it("would evict it at the family's own weight — the positive control", () => {
    const { played, flush } = run({ hogBus: true, followWeight: WEIGHT.SAFETY });

    vi.advanceTimersByTime(CAUTION_FOLLOW_DELAY_MS + 1);
    flush();

    expect(played()).toEqual([HOG_CLIP, FOLLOW_CLIP]);
  });

  it("would cut that line mid-word if it shared the flag family — the positive control", () => {
    const { cutVoice } = run({ followFamily: "flag" });

    expect(cutVoice()).toBe(false);

    vi.advanceTimersByTime(CAUTION_FOLLOW_DELAY_MS + 1);

    // Same-family preemption replaces the in-flight fire wholesale, regardless
    // of weight and of `interrupt` — the caution announcement is stopped
    // mid-sentence to make room for this line.
    expect(cutVoice()).toBe(true);
  });
});

describe("registerCautionVocabulary", () => {
  it("registers the vars, conditions and case the caution scripts name, each with a description", () => {
    const { engine, vars, conds, cases, descriptions } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP);

    expect([...vars.keys()]).toEqual(["caution.followCarNumber", "caution.restartPosition"]);
    expect([...conds.keys()]).toEqual([
      "caution.hasFollowCarNumber",
      "caution.isLeader",
      "caution.followsPaceCar",
      "caution.isDoubleFile",
    ]);
    expect([...cases.keys()]).toEqual(["caution.line"]);

    for (const name of [...vars.keys(), ...conds.keys(), ...cases.keys()]) {
      expect((descriptions.get(name) ?? "").length).toBeGreaterThan(20);
    }
  });

  it("answers caution.hasFollowCarNumber exactly when caution.followCarNumber would resolve", () => {
    // The condition exists so a script can give the numberless case a wording
    // of its own instead of an empty callout (the one-to-go call, above all).
    // It must agree with the var in every case, or a script that branches on
    // it would name a number the var then refuses.
    const cases: Array<[label: string, lineup: CautionLineup | null, named: boolean]> = [
      ["a car ahead with a number", LINEUP, true],
      ["the pace car ahead", { ...LINEUP, followsPaceCar: true, followCarNumber: "0" }, false],
      ["a car ahead the session cannot spell", { ...LINEUP, followCarNumber: null }, false],
      ["a car ahead spelled as nothing", { ...LINEUP, followCarNumber: "" }, false],
      ["no lineup at all", null, false],
    ];

    for (const [label, lineup, named] of cases) {
      const { engine, vars, conds } = makeVocabEngine();

      registerCautionVocabulary(engine, () => lineup);

      expect(conds.get("caution.hasFollowCarNumber")?.(), label).toBe(named);
      expect(vars.get("caution.followCarNumber")?.() !== null, `${label} — the var disagrees`).toBe(named);
    }
  });

  it("stops the restart position at the last spoken number, and says so at debug level", () => {
    // The position-number group ends at POSITION_NUMBER_MAX and a field can run
    // past it. A reference to a clip nobody ships would be dropped by the
    // script's optional clause anyway — but silently; the bound makes it a
    // logged decision.
    const logger = { ...mockLogger, debug: vi.fn() };
    const { engine, vars } = makeVocabEngine();
    const position = { value: POSITION_NUMBER_MAX };

    registerCautionVocabulary(engine, () => ({ ...LINEUP, restartPosition: position.value }), logger as never);

    expect(vars.get("caution.restartPosition")?.()).toBe(poolRef("position-number", String(POSITION_NUMBER_MAX)));
    expect(logger.debug).not.toHaveBeenCalled();

    position.value = POSITION_NUMBER_MAX + 1;

    expect(vars.get("caution.restartPosition")?.()).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(String(POSITION_NUMBER_MAX + 1)));
  });

  it("declares the two lane keys the line case can return", () => {
    const { engine, keys } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP);

    expect(Object.keys(keys.get("caution.line") ?? {}).sort()).toEqual(["inside", "outside"]);
  });

  it("draws the follow car's number from the car-number group, exactly as the sim spells it", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP);

    expect(vars.get("caution.followCarNumber")?.()).toBe(poolRef("car-number", "09"));
  });

  it("draws the restart position from the position-number group", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP);

    expect(vars.get("caution.restartPosition")?.()).toBe(poolRef("position-number", "14"));
  });

  it("names no car when the car ahead is the pace car — its number is not what a follow line means", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, followsPaceCar: true, followCarNumber: "0" }));

    expect(vars.get("caution.followCarNumber")?.()).toBeNull();
  });

  it("names no number when the lineup carries none, and no position when it carries none", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, followCarNumber: null, restartPosition: null }));

    expect(vars.get("caution.followCarNumber")?.()).toBeNull();
    expect(vars.get("caution.restartPosition")?.()).toBeNull();
  });

  it("names nothing at all when there is no lineup to read", () => {
    const { engine, vars, conds, cases } = makeVocabEngine();

    registerCautionVocabulary(engine, () => null);

    expect(vars.get("caution.followCarNumber")?.()).toBeNull();
    expect(vars.get("caution.restartPosition")?.()).toBeNull();
    expect(conds.get("caution.isLeader")?.()).toBe(false);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(false);
    expect(conds.get("caution.isDoubleFile")?.()).toBe(false);
    expect(cases.get("caution.line")?.()).toBeNull();
  });

  // The two conditions answer different questions and every other fixture here
  // has them equal, so swapping the two resolver bodies would survive the whole
  // suite — while telling the outside front car it is leading at every
  // double-file restart, which is the case Task 5's redefinition of `isLeader`
  // exists for. This fixture is the one that pulls them apart.
  it("keeps leading and following-the-pace-car apart — the outside front car follows the pace car and is NOT leading", () => {
    const { engine, conds } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: false, followsPaceCar: true }));

    expect(conds.get("caution.isLeader")?.()).toBe(false);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(true);
  });

  it("and the leader is both — first on the road, with only the pace car ahead", () => {
    const { engine, conds } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: true, followsPaceCar: true }));

    expect(conds.get("caution.isLeader")?.()).toBe(true);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(true);
  });

  it("and a car mid-pack is neither", () => {
    const { engine, conds } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: false, followsPaceCar: false }));

    expect(conds.get("caution.isLeader")?.()).toBe(false);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(false);
  });

  it("reports the lineup's own answers for the two conditions and the lane", () => {
    const { engine, conds, cases } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: true, followsPaceCar: true, line: "outside" }));

    expect(conds.get("caution.isLeader")?.()).toBe(true);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(true);
    expect(conds.get("caution.isDoubleFile")?.()).toBe(true);
    expect(cases.get("caution.line")?.()).toBe("outside");
  });

  it("reads the lineup afresh on every resolution — the field keeps moving while a call waits", () => {
    const { engine, vars } = makeVocabEngine();
    const reads = vi.fn(() => LINEUP);

    registerCautionVocabulary(engine, reads);

    vars.get("caution.followCarNumber")?.();
    vars.get("caution.followCarNumber")?.();

    expect(reads).toHaveBeenCalledTimes(2);
  });
});

describe("the one-to-go call in the bundled voice, when the car ahead cannot be named", () => {
  // The review finding the maintainer hit in the harness: an `else` branch
  // holding nothing but an optional clause expands to NOTHING when the number
  // in it resolves to null, and the most time-critical call in the sequence
  // goes silent. Driven through the real engine against the bundled script
  // and manifest, because only the expansion can show the difference between
  // "a numberless wording" and "no callout at all".
  const VOICE = "default";
  const ONE_TO_GO = `voice/${VOICE}/caution/one-to-go-01.mp3`;

  /** Everything the Voice channel plays for one `caution.oneLapToGreen`, with the lineup given. */
  function spoken(lineup: CautionLineup | null): string[] {
    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, BUNDLED_MANIFEST, mockLogger as never, () => VOICE);

    registerCautionVocabulary(engine, () => lineup);
    engine.defineContract(contract("one-to-go"));
    engine.setScripts(new Map([[VOICE, BUNDLED_SCRIPT]]));

    bus.publish({
      event: "caution.oneLapToGreen",
      timestamp: 0,
      telemetry: IN_CAR,
      data: {},
    } as unknown as SimEventOf<SimEventName>);

    // The radio frame's open tick plays on SFX first; each Voice clip plays
    // once the one before it completes.
    for (let i = 0; i < 10; i++) {
      audio._triggerChannelEnd(AudioChannel.SFX);
      audio._triggerChannelEnd(AudioChannel.Voice);
    }

    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetAudioScenarios();
  });

  it('still says "One to go." with a car ahead the session cannot name — never nothing', () => {
    expect(spoken({ ...LINEUP, followsPaceCar: false, followCarNumber: null })).toEqual([ONE_TO_GO]);
  });

  it("names the lane and the car when it can — the positive control, and the reason the fallback replaces rather than precedes", () => {
    // The numbered wording already says "One to go", so the fallback is the
    // other branch of a condition, not a clip in front of the clause.
    expect(spoken({ ...LINEUP, followsPaceCar: false, followCarNumber: "09", line: "inside" })).toEqual([
      `voice/${VOICE}/caution/one-to-go-inside-01.mp3`,
      `voice/${VOICE}/car-number/09.mp3`,
    ]);
  });

  it("keeps the plain wording for the outside front car, which follows the pace car without leading", () => {
    expect(spoken({ ...LINEUP, followsPaceCar: true, isLeader: false, followCarNumber: null })).toEqual([ONE_TO_GO]);
  });
});

describe("the follow and lineup-change calls in the bundled voice, when the car ahead cannot be named", () => {
  // The same defect as the one-to-go call's, in the two calls that had no
  // numberless wording in the reference voice until the `*-noname` clips were
  // cut: an `else` branch holding nothing but an optional clause expands to
  // NOTHING when the number in it resolves to null. The rule the fix rests
  // on: an optional clause is safe only when something outside it still
  // speaks. Driven through the real engine against the bundled script and
  // manifest, because only the expansion can show "a numberless wording"
  // apart from "no callout at all".
  const VOICE = "default";
  const CAR_09 = `voice/${VOICE}/car-number/09.mp3`;

  /** Everything the Voice channel plays for one fire of the contract, with the lineup given. */
  function spoken(id: "follow" | "lineup-changed", lineup: CautionLineup | null): string[] {
    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, BUNDLED_MANIFEST, mockLogger as never, () => VOICE);

    registerCautionVocabulary(engine, () => lineup);
    engine.defineContract(contract(id));
    engine.setScripts(new Map([[VOICE, BUNDLED_SCRIPT]]));

    bus.publish(event(id));

    // Both contracts hold before deciding; the lineup is read when the hold
    // ends, not at the event.
    vi.advanceTimersByTime(Math.max(CAUTION_FOLLOW_DELAY_MS, CAUTION_LINEUP_CHANGE_DELAY_MS) + 1);

    // The radio frame's open tick plays on SFX first; each Voice clip plays
    // once the one before it completes.
    for (let i = 0; i < 10; i++) {
      audio._triggerChannelEnd(AudioChannel.SFX);
      audio._triggerChannelEnd(AudioChannel.Voice);
    }

    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Every pool here has more than one take; pin the draw to the first so
    // the expectations can name the clip rather than match a pattern.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetAudioScenarios();
  });

  describe("the follow call", () => {
    it("still says who to line up behind with a car ahead the session cannot name — never nothing", () => {
      expect(spoken("follow", { ...LINEUP, followsPaceCar: false, followCarNumber: null })).toEqual([
        `voice/${VOICE}/caution/follow-noname-01.mp3`,
      ]);
    });

    it("names the car when it can — the positive control, the number-bearing branch unchanged", () => {
      expect(spoken("follow", { ...LINEUP, followsPaceCar: false, followCarNumber: "09" })).toEqual([
        `voice/${VOICE}/caution/follow-behind-01.mp3`,
        CAR_09,
      ]);
    });
  });

  describe("the lineup-change call", () => {
    it("still says the car ahead changed with a car ahead the session cannot name — never nothing, and without the lane", () => {
      // The lane is deliberately dropped on this path even though
      // `caution.line` would answer: the fallback sits outside the case, and
      // four more clips to keep the lane on a rare path is not proportionate.
      expect(
        spoken("lineup-changed", { ...LINEUP, followsPaceCar: false, followCarNumber: null, line: "inside" }),
      ).toEqual([
        `voice/${VOICE}/caution/lineup-changed-noname-01.mp3`,
      ]);
    });

    it("names the lane and the car when it can — the positive control, the number-bearing branch unchanged", () => {
      expect(
        spoken("lineup-changed", { ...LINEUP, followsPaceCar: false, followCarNumber: "09", line: "inside" }),
      ).toEqual([
        `voice/${VOICE}/caution/lineup-changed-inside-01.mp3`,
        CAR_09,
      ]);
    });
  });
});
