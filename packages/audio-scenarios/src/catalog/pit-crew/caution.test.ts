/**
 * The full-course caution family (issue #1127).
 *
 * Nine contracts over the translator's caution events plus the caution flag
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
import { calculateRacePositions, Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import {
  type CautionLineup,
  type CautionPhase,
  type LivePosition,
  resolveCautionLineup,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
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

// The translator's live readers are stubbed; its PURE lineup resolver is the
// real one, so the snapshot cases at the end derive their lineup from the
// committed fixture instead of typing its number in.
vi.mock("@iracedeck/sim-events-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/sim-events-iracing")>()),
  getSessionType: () => mockSessionType(),
  getStandingStart: () => mockStandingStart(),
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
  "position",
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
  position: "caution.lastLapCheckpoint",
  "pace-car-off": "paceCar.off",
  restart: "caution.restarted",
};

/** The two contracts whose event also fires outside a caution. */
const PACE_CAR_IDS: readonly CautionCalloutId[] = ["pace-car-out", "pace-car-off"];

/**
 * The phase each call naturally arrives in — what the translator's
 * `getCautionPhase()` has settled on when the event is published. The follow
 * call and the pace car's arrival land while the field is still waving; the
 * pickup, an extra lap and a mid-caution reorder while it is caught; the
 * last lap's three under one to go; and the restart's own event is published
 * AFTER the phase has returned to none.
 */
const PHASE_OF: Record<CautionCalloutId, CautionPhase> = {
  follow: "waving",
  "pace-car-out": "waving",
  "field-caught": "caught",
  "extra-lap": "caught",
  "one-to-go": "one-to-go",
  "lineup-changed": "caught",
  position: "one-to-go",
  "pace-car-off": "one-to-go",
  restart: "none",
};

let cautionPhase: CautionPhase;
let lineupNow: CautionLineup | null;

function contracts(): readonly ScenarioContract[] {
  return buildCautionContracts({ getCautionPhase: () => cautionPhase, getCautionLineup: () => lineupNow });
}

function contract(id: CautionCalloutId): ScenarioContract {
  const found = contracts().find((c) => c.id === `pit-crew.caution-${id}`);

  if (!found) throw new Error(`contract not found: ${id}`);

  return found;
}

function event(id: CautionCalloutId, telemetry: unknown = IN_CAR, timestamp = 0): SimEventOf<SimEventName> {
  return {
    event: EVENT_OF[id],
    timestamp,
    telemetry,
    data: {},
  } as unknown as SimEventOf<SimEventName>;
}

/** Whether the call's `where:` admits the event, with the phase it naturally arrives in unless told otherwise. */
function fires(id: CautionCalloutId, telemetry: unknown = IN_CAR, phase: CautionPhase = PHASE_OF[id]): boolean {
  cautionPhase = phase;

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

/** No live race position to read — what every lineup-only case hands the vocabulary. */
const NO_LIVE_POSITION = (): LivePosition | null => null;

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
  cautionPhase = "caught";
  lineupNow = LINEUP;
  mockSessionType.mockReturnValue("Race");
  mockStandingStart.mockReturnValue(false);
});

describe("the caution contracts", () => {
  it("exports the nine scenario ids, in the order the caution runs", () => {
    expect(CAUTION_SCENARIO_IDS).toEqual([
      "pit-crew.caution-follow",
      "pit-crew.caution-pace-car-out",
      "pit-crew.caution-field-caught",
      "pit-crew.caution-extra-lap",
      "pit-crew.caution-one-to-go",
      "pit-crew.caution-lineup-changed",
      "pit-crew.caution-position",
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
      "pit-crew.caution-position": "position",
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
      position: "calloutEnabledCautionPosition",
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

  it("weighs the follow and position calls one notch below the rest, so a tie in the pending slot costs them and not the call they follow", () => {
    expect(contract("follow").weight).toBe(WEIGHT.SAFETY - 1);
    expect(contract("position").weight).toBe(WEIGHT.SAFETY - 1);

    for (const id of IDS.filter((x) => x !== "follow" && x !== "position" && x !== "restart")) {
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

      cautionPhase = PHASE_OF[id];
      expect(contract(id).speakGate?.admit({} as never)).toBe(true);

      // The case the gate exists for: a queueable fire parked behind a busy bus
      // replays without re-running `where:`, and the pending slot has no TTL,
      // so by the time it drains the caution can be long over.
      cautionPhase = "none";
      expect(contract(id).speakGate?.admit({} as never)).toBe(false);
      cautionPhase = "caught";
    }
  });

  it("re-checks at speak time that the player still holds a pace row — the follow and lineup-change calls, whose sentence is about the lineup", () => {
    // R15: a driver towed during the hold must not hear "The car ahead of
    // you has changed." in his stall. The one-to-go call deliberately keeps
    // the plain gate — "One lap to green." is true for him too.
    for (const id of ["follow", "lineup-changed"] as const) {
      cautionPhase = PHASE_OF[id];
      lineupNow = LINEUP;
      expect(contract(id).speakGate?.admit({} as never)).toBe(true);

      lineupNow = null;
      expect(contract(id).speakGate?.admit({} as never)).toBe(false);
    }

    lineupNow = null;
    cautionPhase = "one-to-go";
    expect(contract("one-to-go").speakGate?.admit({} as never)).toBe(true);
  });

  it("shares the flag family so a newer caution call supersedes a stale one — except the follow and position calls, which must wait behind a family-mate rather than cut it", () => {
    for (const id of IDS) {
      if (id === "follow" || id === "position") {
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
    for (const id of PACE_CAR_IDS) expect(fires(id, IN_CAR, "none")).toBe(false);

    // With no caution phase at all, only the calls whose event cannot fire
    // outside a caution still pass their `where:` — the rest each ask for
    // the stage they speak at.
    for (const id of ["extra-lap", "one-to-go", "position", "restart"] as const) {
      expect(fires(id, IN_CAR, "none"), id).toBe(true);
    }

    for (const id of ["follow", "field-caught", "lineup-changed"] as const) {
      expect(fires(id, IN_CAR, "none"), id).toBe(false);
    }

    for (const id of PACE_CAR_IDS) expect(fires(id)).toBe(true);
  });

  it("reads the phase and never the raw flag — a one-to-go bit in the event's own telemetry gates nothing", () => {
    // The three raw-bit readers the first build carried are gone (R6): every
    // stage question is asked of the translator's phase, which also folds in
    // the F2 withdrawal and holds its value through a missing read.
    const flagged = { ...IN_CAR, SessionFlags: Flags.Caution | Flags.OneLapToGreen };

    for (const id of IDS) expect(fires(id, flagged), id).toBe(true);
  });

  it("speaks the follow call only while the field is still waving — a re-raised waving bit after the pickup repeats nothing (R4)", () => {
    expect(fires("follow", IN_CAR, "waving")).toBe(true);

    for (const phase of ["caught", "one-to-go", "none"] as const) {
      expect(fires("follow", IN_CAR, phase), phase).toBe(false);
    }
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

describe("the lineup-change call and the one-to-go transition (R1)", () => {
  /**
   * The two contracts from ONE build, because the one-to-go contract's
   * `where:` stashes its event's timestamp for the held lineup-change
   * decision to read — a fresh build per contract would give each its own
   * stash and prove nothing.
   */
  function pair(phase: () => CautionPhase): {
    oneToGo: (timestamp: number) => boolean;
    change: (timestamp: number) => boolean;
  } {
    const built = buildCautionContracts({ getCautionPhase: phase, getCautionLineup: () => LINEUP });
    const find = (id: CautionCalloutId): ScenarioContract => {
      const c = built.find((x) => x.id === `pit-crew.caution-${id}`);

      if (!c) throw new Error(id);

      return c;
    };
    const admits = (c: ScenarioContract, timestamp: number): boolean =>
      c.when?.where?.(event(SCENARIO_ID_TO_CAUTION_ID[c.id], IN_CAR, timestamp)) !== false;

    return {
      oneToGo: (timestamp) => admits(find("one-to-go"), timestamp),
      change: (timestamp) => admits(find("lineup-changed"), timestamp),
    };
  }

  /** The measured shape: the re-form at T, the flag one tick later, the decision after the hold. */
  const T = 415_100;

  it("holds its decision long enough for the one-to-go flag to land", () => {
    expect(contract("lineup-changed").triggerDelay).toBe(CAUTION_LINEUP_CHANGE_DELAY_MS);
    // The measured gap between the re-form and the flag is one tick (20 ms);
    // the hold has to clear it with room for a slower tick.
    expect(CAUTION_LINEUP_CHANGE_DELAY_MS).toBeGreaterThan(100);
  });

  it("stands down for the re-form the one-to-go call names itself — the change emitted a tick BEFORE the flag", () => {
    let phase: CautionPhase = "caught";
    const { oneToGo, change } = pair(() => phase);

    // The change's handler holds its event; the one-to-go's where: runs at
    // T + 20 while it waits, and by the decision the phase is one to go.
    expect(oneToGo(T + 20)).toBe(true);
    phase = "one-to-go";

    expect(change(T)).toBe(false);
  });

  it("speaks a change emitted AFTER the flag — the car ahead pitting on the one-to-green lap, with pits open from that tick", () => {
    let phase: CautionPhase = "caught";
    const { oneToGo, change } = pair(() => phase);

    expect(oneToGo(T + 20)).toBe(true);
    phase = "one-to-go";

    expect(change(T + 30_000)).toBe(true);
  });

  it("speaks a mid-caution reorder no one-to-go has followed", () => {
    const { change } = pair(() => "caught");

    expect(change(T)).toBe(true);
  });

  it("is not silenced by the LAST caution's one-to-go — a stash older than the change is no reason to stand down", () => {
    let phase: CautionPhase = "one-to-go";
    const { oneToGo, change } = pair(() => phase);

    expect(oneToGo(T + 20)).toBe(true);

    // Restart, green running, the next caution: its own re-form, and its own
    // flag a tick later.
    phase = "caught";
    expect(change(T + 400_000)).toBe(true);

    expect(oneToGo(T + 400_020)).toBe(true);
    phase = "one-to-go";
    expect(change(T + 400_000)).toBe(false);
  });

  it("stays quiet once the caution is over, so a change held over the green cannot be spoken into the restart", () => {
    const { change } = pair(() => "none");

    expect(change(T)).toBe(false);
  });

  it("with the one-to-go call switched off nothing is stashed, and the re-form change speaks its lane and car instead", () => {
    // The opt-in wrapper runs ahead of a contract's `where:`, so a disabled
    // one-to-go call never records its moment — and the driver who switched
    // it off still hears the re-form through this call. Documented in the
    // module header as the right way round.
    let phase: CautionPhase = "caught";
    const { change } = pair(() => phase);

    phase = "one-to-go";

    expect(change(T)).toBe(true);
  });
});

/**
 * The two road-course rules (the module header's findings 4 and 5), pinned
 * against the capture they came from: the committed cut of
 * `local/telemetry-watch-20260918-185032-545.jsonl`. The flags are looked up
 * by `SessionTime` in the fixture rather than written out, so a fixture that
 * stops carrying those ticks fails here instead of passing on a copied value.
 */
describe("the pickup and pace-car-off calls on a road course (2026-09-18 capture)", () => {
  type RoadTick = { t: number; SessionFlags: number; CarIdxTrackSurface: number[] };
  const ROAD_FIXTURE = new URL(
    "../../../../sim-events-iracing/src/diff/__fixtures__/caution-road-20260918.json",
    import.meta.url,
  );
  const road = JSON.parse(readFileSync(ROAD_FIXTURE, "utf-8")) as RoadTick[];

  /** The capture's flags at `t`, as the telemetry both events of that tick carry. */
  function flagsAt(t: number): number {
    const tick = road.find((x) => x.t === t);

    if (!tick) throw new Error(`no fixture tick at ${t}`);

    return tick.SessionFlags;
  }

  /**
   * The phase the translator SETTLED on at each tick, as
   * `sim-events-iracing`'s road replay test pins it ("replays the captured
   * ROAD-COURSE cautions"): the deployment ticks land while the caution is
   * still waving, the pickup tick has already moved on to one to go, and the
   * real exit is under one to go. The flags below are checked against the
   * fixture too, so a fixture that stops carrying those ticks fails here.
   */
  const PHASE_AT: Record<number, CautionPhase> = {
    152.23: "waving",
    309.33: "one-to-go",
    461.22: "one-to-go",
    562.07: "waving",
  };

  it('keeps "Two to green" silent when the static caution and one to green rise on the same tick (309.33 s)', () => {
    const flags = flagsAt(309.33);

    expect(hasFlag(flags, Flags.Caution) && hasFlag(flags, Flags.OneLapToGreen)).toBe(true);

    expect(fires("field-caught", IN_CAR, PHASE_AT[309.33])).toBe(false);
  });

  it('speaks "Two to green" at an oval pickup, where the one-to-go flag is a lap away and the phase settles on caught', () => {
    expect(fires("field-caught", IN_CAR, "caught")).toBe(true);
  });

  it('keeps "Pace car\'s off" silent while the pace car rolls out through pit exit to deploy (152.23 s and 562.07 s)', () => {
    for (const t of [152.23, 562.07]) {
      const tick = road.find((x) => x.t === t);

      // The deployment: a pace car that waited parked reads OnTrack, and its
      // three seconds of AproachingPits (slot 20 in the cut) is it rolling OUT
      // onto the circuit, with the caution still waving and no one-to-go flag.
      expect(tick?.CarIdxTrackSurface[20], `${t}`).toBe(2);
      expect(hasFlag(tick?.SessionFlags ?? 0, Flags.OneLapToGreen), `${t}`).toBe(false);

      expect(fires("pace-car-off", IN_CAR, PHASE_AT[t]), `${t}`).toBe(false);
    }
  });

  it('speaks "Pace car\'s off" for the real exit after one to green (461.22 s)', () => {
    const tick = road.find((x) => x.t === 461.22);

    expect(tick?.CarIdxTrackSurface[20]).toBe(2);
    expect(hasFlag(tick?.SessionFlags ?? 0, Flags.OneLapToGreen)).toBe(true);

    expect(fires("pace-car-off", IN_CAR, PHASE_AT[461.22])).toBe(true);
  });

  it('keeps "Pace car\'s off" silent while the field is merely caught — the exit only ever comes after one to go', () => {
    expect(fires("pace-car-off", IN_CAR, "caught")).toBe(false);
  });

  it("never asks the phase for the position call — its event already says the flag is up", () => {
    for (const phase of ["caught", "one-to-go"] as const) expect(fires("position", IN_CAR, phase)).toBe(true);
  });
});

/**
 * The position call's scheduling beside the calls it shares its lap with
 * (R7), driven through the real engine like the follow call's above: with the
 * one-to-go line in flight, the position call must wait behind it, never cut
 * it — and the positive control shows the flag family WOULD cut it.
 */
describe("the position call beside the one-to-go line", () => {
  const VOICE = "test";
  const ONE_TO_GO_CLIP = `voice/${VOICE}/caution/one-to-go-01.mp3`;
  const POSITION_CLIP = `voice/${VOICE}/position-number/7.mp3`;

  const manifest: AudioAssetsManifest = {
    clips: [
      "sfx/IRD-tick-open.mp3",
      "sfx/IRD-tick-close.mp3",
      "sfx/IRD-ambient-pit.mp3",
      ONE_TO_GO_CLIP,
      POSITION_CLIP,
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  const script = {
    schema: 1,
    scenarios: {
      "pit-crew.caution-one-to-go": { comment: "c", test: "t", sequence: ["pool:caution/one-to-go"] },
      "pit-crew.caution-position": { comment: "c", test: "t", sequence: ["pool:position-number/7"] },
    },
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

  function run(opts: { positionFamily?: string } = {}): {
    played: () => string[];
    cutVoice: () => boolean;
    flush: () => void;
  } {
    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

    cautionPhase = "one-to-go";
    engine.defineContract(contract("one-to-go"));
    engine.defineContract({
      ...contract("position"),
      family: "positionFamily" in opts ? opts.positionFamily : contract("position").family,
    });
    engine.setScripts(new Map([[VOICE, script]]));

    bus.publish(event("one-to-go"));
    // The radio frame's open tick plays on SFX first; the body reaches the
    // Voice channel only once that tick completes.
    audio._triggerChannelEnd(AudioChannel.SFX);

    bus.publish(event("position"));

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

  it("waits for the one-to-go line to finish and then speaks — both calls, in order", () => {
    const { played, cutVoice, flush } = run();

    expect(cutVoice()).toBe(false);
    expect(played()).toEqual([ONE_TO_GO_CLIP]);

    flush();

    expect(played()).toEqual([ONE_TO_GO_CLIP, POSITION_CLIP]);
  });

  it("would cut that line mid-word if it shared the flag family — the positive control", () => {
    const { cutVoice } = run({ positionFamily: "flag" });

    expect(cutVoice()).toBe(true);
  });

  it("weighs below Green Held as well, which on a short oval lands near the 35% point", () => {
    const greenHeld = FLAG_CONTRACTS.find((c) => c.id === "pit-crew.flag-green-held");

    expect(greenHeld?.weight ?? 0).toBeGreaterThan(contract("position").weight ?? 0);
    expect(contract("one-to-go").weight ?? 0).toBeGreaterThan(contract("position").weight ?? 0);
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

    // The follow call speaks only while the field is still waving (R4).
    cautionPhase = "waving";
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

    registerCautionVocabulary(engine, () => LINEUP, NO_LIVE_POSITION);

    expect([...vars.keys()]).toEqual(["caution.followCarNumber", "caution.restartPosition", "caution.racePosition"]);
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

      registerCautionVocabulary(engine, () => lineup, NO_LIVE_POSITION);

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

    registerCautionVocabulary(
      engine,
      () => ({ ...LINEUP, restartPosition: position.value }),
      NO_LIVE_POSITION,
      logger as never,
    );

    expect(vars.get("caution.restartPosition")?.()).toBe(poolRef("position-number", String(POSITION_NUMBER_MAX)));
    expect(logger.debug).not.toHaveBeenCalled();

    position.value = POSITION_NUMBER_MAX + 1;

    expect(vars.get("caution.restartPosition")?.()).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(String(POSITION_NUMBER_MAX + 1)));
  });

  it("declares the two lane keys the line case can return", () => {
    const { engine, keys } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP, NO_LIVE_POSITION);

    expect(Object.keys(keys.get("caution.line") ?? {}).sort()).toEqual(["inside", "outside"]);
  });

  it("draws the follow car's number from the car-number group, exactly as the sim spells it", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP, NO_LIVE_POSITION);

    expect(vars.get("caution.followCarNumber")?.()).toBe(poolRef("car-number", "09"));
  });

  it("draws the restart position from the position-number group", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(engine, () => LINEUP, NO_LIVE_POSITION);

    expect(vars.get("caution.restartPosition")?.()).toBe(poolRef("position-number", "14"));
  });

  it("names no car when the car ahead is the pace car — its number is not what a follow line means", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(
      engine,
      () => ({ ...LINEUP, followsPaceCar: true, followCarNumber: "0" }),
      NO_LIVE_POSITION,
    );

    expect(vars.get("caution.followCarNumber")?.()).toBeNull();
  });

  it("names no number when the lineup carries none, and no position when it carries none", () => {
    const { engine, vars } = makeVocabEngine();

    registerCautionVocabulary(
      engine,
      () => ({ ...LINEUP, followCarNumber: null, restartPosition: null }),
      NO_LIVE_POSITION,
    );

    expect(vars.get("caution.followCarNumber")?.()).toBeNull();
    expect(vars.get("caution.restartPosition")?.()).toBeNull();
  });

  it("names nothing at all when there is no lineup to read", () => {
    const { engine, vars, conds, cases } = makeVocabEngine();

    registerCautionVocabulary(engine, () => null, NO_LIVE_POSITION);

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

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: false, followsPaceCar: true }), NO_LIVE_POSITION);

    expect(conds.get("caution.isLeader")?.()).toBe(false);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(true);
  });

  it("and the leader is both — first on the road, with only the pace car ahead", () => {
    const { engine, conds } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: true, followsPaceCar: true }), NO_LIVE_POSITION);

    expect(conds.get("caution.isLeader")?.()).toBe(true);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(true);
  });

  it("and a car mid-pack is neither", () => {
    const { engine, conds } = makeVocabEngine();

    registerCautionVocabulary(engine, () => ({ ...LINEUP, isLeader: false, followsPaceCar: false }), NO_LIVE_POSITION);

    expect(conds.get("caution.isLeader")?.()).toBe(false);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(false);
  });

  it("reports the lineup's own answers for the two conditions and the lane", () => {
    const { engine, conds, cases } = makeVocabEngine();

    registerCautionVocabulary(
      engine,
      () => ({ ...LINEUP, isLeader: true, followsPaceCar: true, line: "outside" }),
      NO_LIVE_POSITION,
    );

    expect(conds.get("caution.isLeader")?.()).toBe(true);
    expect(conds.get("caution.followsPaceCar")?.()).toBe(true);
    expect(conds.get("caution.isDoubleFile")?.()).toBe(true);
    expect(cases.get("caution.line")?.()).toBe("outside");
  });

  it("reads the lineup afresh on every resolution — the field keeps moving while a call waits", () => {
    const { engine, vars } = makeVocabEngine();
    const reads = vi.fn(() => LINEUP);

    registerCautionVocabulary(engine, reads, NO_LIVE_POSITION);

    vars.get("caution.followCarNumber")?.();
    vars.get("caution.followCarNumber")?.();

    expect(reads).toHaveBeenCalledTimes(2);
  });
});

describe("the one-lap-to-green call in the bundled voice, when the car ahead cannot be named", () => {
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

    registerCautionVocabulary(engine, () => lineup, NO_LIVE_POSITION);
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

  it('still says "One lap to green." with a car ahead the session cannot name — never nothing', () => {
    expect(spoken({ ...LINEUP, followsPaceCar: false, followCarNumber: null })).toEqual([ONE_TO_GO]);
  });

  it("names the lane and the car when it can — the positive control, and the reason the fallback replaces rather than precedes", () => {
    // The numbered wording already says "One lap to green", so the fallback is the
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

    // Each call at the phase it naturally arrives in; the speak-time lineup
    // gate reads the same lineup the vocabulary does.
    cautionPhase = PHASE_OF[id];
    lineupNow = lineup;
    registerCautionVocabulary(engine, () => lineup, NO_LIVE_POSITION);
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

  describe("a player towed during the hold (R15)", () => {
    // The road capture's second caution: the player was passed car by car
    // while stopped off track (550.47–557.67 s), the hold coalesced the
    // changes into one decision at ~559 s, and by then he had been towed and
    // held no pace row. The lineup resolves to null, the numberless fallback
    // would play — "The car ahead of you has changed." to a car in its stall.
    function spokenToTowed(id: "follow" | "lineup-changed"): string[] {
      const bus = createMockBus();
      const audio = createFakeAudio();
      const engine = initializeAudioScenarios(bus, audio, BUNDLED_MANIFEST, mockLogger as never, () => VOICE);
      let current: CautionLineup | null = { ...LINEUP, followsPaceCar: false, followCarNumber: null };
      const built = buildCautionContracts({ getCautionPhase: () => "caught", getCautionLineup: () => current });
      const c = built.find((x) => x.id === cautionScenarioId(id));

      if (!c) throw new Error(id);

      registerCautionVocabulary(engine, () => current, NO_LIVE_POSITION);
      engine.defineContract(c);
      engine.setScripts(new Map([[VOICE, BUNDLED_SCRIPT]]));

      bus.publish(event(id));

      // Towed inside the hold: no row by the time the decision is made.
      current = null;
      vi.advanceTimersByTime(Math.max(CAUTION_FOLLOW_DELAY_MS, CAUTION_LINEUP_CHANGE_DELAY_MS) + 1);

      for (let i = 0; i < 10; i++) {
        audio._triggerChannelEnd(AudioChannel.SFX);
        audio._triggerChannelEnd(AudioChannel.Voice);
      }

      return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    }

    it("hears nothing about the car ahead changing — the numberless fallback is not true of a car in its stall", () => {
      expect(spokenToTowed("lineup-changed")).toEqual([]);
    });

    it("hears no instruction to line up behind anyone either", () => {
      expect(spokenToTowed("follow")).toEqual([]);
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

describe("the position call in the bundled voice, against the 2026-09-19 snapshot", () => {
  // The maintainer heard "P21" in a 20-car field while his display showed
  // P19. Even counted correctly the LINEUP says 20 — car #7 was two laps down
  // and lined up ahead of him — so the call speaks the RACE position, read
  // through the same `getLivePosition` the position-change call uses. Driven
  // through the real engine against the bundled script, with the lineup and
  // the race order both taken from the snapshot's fixture, so a script pointed
  // back at the pace-row variable would speak 20 here and fail.
  const VOICE = "default";
  const CURRENTLY = `voice/${VOICE}/position-intro-worse/currently-01.mp3`;
  const SNAPSHOT_FIXTURE = new URL(
    "../../../../sim-events-iracing/src/diff/__fixtures__/caution-lineup-20260919.json",
    import.meta.url,
  );
  const [snapshot] = JSON.parse(readFileSync(SNAPSHOT_FIXTURE, "utf-8")) as [
    {
      PlayerCarPosition: number;
      CarIdxLapCompleted: number[];
      CarIdxLapDistPct: number[];
      CarIdxPaceLine: number[];
      CarIdxPaceRow: number[];
      CarIdxTrackSurface: number[];
    },
  ];

  /** The snapshot's race order, from the same lap-progress calculator the canonical order rests on. */
  const positions = calculateRacePositions(snapshot as unknown as TelemetryData);

  /** What the translator's `getLivePosition()` answered at that moment: the player (index 0), single class. */
  const SNAPSHOT_LIVE: LivePosition = { position: positions[0], classPosition: positions[0], isMultiClass: false };

  /**
   * The snapshot's lineup DERIVED from the fixture through the real resolver
   * (R12), the fixture widened as `caution-lineup.test.ts` widens it — slot
   * 20 is the pace car, index 64 in the raw telemetry. Typed in, the number
   * "the bug was between" was a typed-in 20 and the test never derived it; a
   * resolver drifting to 21 (the old formula) or 19 (the race position) now
   * turns the first case below red.
   */
  const PACE = 64;
  const widen = (values: number[], fill: number): number[] => {
    const out = new Array(72).fill(fill);

    values.forEach((v, i) => (out[i === 20 ? PACE : i] = v));

    return out;
  };
  const SNAPSHOT_TELEMETRY = {
    CarIdxPaceLine: widen(snapshot.CarIdxPaceLine, -1),
    CarIdxPaceRow: widen(snapshot.CarIdxPaceRow, -1),
    CarIdxLapDistPct: widen(snapshot.CarIdxLapDistPct, -1),
    CarIdxTrackSurface: widen(snapshot.CarIdxTrackSurface, -1),
  } as unknown as TelemetryData;
  const SNAPSHOT_SESSION = {
    DriverInfo: { DriverCarIdx: 0, PaceCarIdx: PACE, Drivers: [{ CarIdx: 7, CarNumber: "7" }] },
  };
  const SNAPSHOT_LINEUP = resolveCautionLineup(SNAPSHOT_TELEMETRY, SNAPSHOT_SESSION, true);

  if (SNAPSHOT_LINEUP === null) throw new Error("the snapshot fixture resolved no lineup");

  /** Everything the Voice channel plays for one `caution.lastLapCheckpoint`. */
  function spoken(lineup: CautionLineup | null, live: LivePosition | null): string[] {
    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, BUNDLED_MANIFEST, mockLogger as never, () => VOICE);

    registerCautionVocabulary(
      engine,
      () => lineup,
      () => live,
    );
    engine.defineContract(contract("position"));
    engine.setScripts(new Map([[VOICE, BUNDLED_SCRIPT]]));

    bus.publish({
      event: "caution.lastLapCheckpoint",
      timestamp: 0,
      telemetry: IN_CAR,
      data: {},
    } as unknown as SimEventOf<SimEventName>);

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

  it("the snapshot puts the player 19th in the race and 20th in the lineup — the two numbers the bug was between", () => {
    expect(SNAPSHOT_LIVE.position).toBe(19);
    expect(snapshot.PlayerCarPosition).toBe(19);
    expect(SNAPSHOT_LINEUP).toMatchObject({
      restartPosition: 20,
      followCarIdx: 7,
      followCarNumber: "7",
      line: "inside",
      doubleFile: true,
      isLeader: false,
      followsPaceCar: false,
    });
    expect(SNAPSHOT_LINEUP.restartPosition).not.toBe(SNAPSHOT_LIVE.position);
  });

  it("speaks \"We're currently 19\" — the race position, never the lineup's 20", () => {
    expect(spoken(SNAPSHOT_LINEUP, SNAPSHOT_LIVE)).toEqual([CURRENTLY, `voice/${VOICE}/position-number/19.mp3`]);
  });

  it("speaks nothing with no race position to read, whatever the lineup says — the clause is the whole call", () => {
    expect(spoken(SNAPSHOT_LINEUP, null)).toEqual([]);
  });

  it("speaks the race position with no lineup at all — the call no longer needs the pace rows", () => {
    expect(spoken(null, SNAPSHOT_LIVE)).toEqual([CURRENTLY, `voice/${VOICE}/position-number/19.mp3`]);
  });
});
