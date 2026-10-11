/**
 * The rolling-start formation family (issues #660 and #1167; scripted since
 * #1065).
 *
 * Three contracts: the pace car pulling away, the last of two pace laps, and
 * a change to the car you form up behind. What is asserted here is WHEN each
 * fires and how it is scheduled, and — through the real engine against the
 * bundled voice's script — which wording each lineup gets.
 *
 * Three properties carry the family and get their own blocks:
 *
 * - every call re-checks at SPEAK time that the formation is still running,
 *   so a call queued behind the spotter never drains into the launch;
 * - the change call is judged against the car last NAMED in this formation
 *   (the caution's #1286 rule, through the same mechanism), so a change
 *   queued behind "Pace car's rolling" does not repeat the car it names;
 * - the change call waits behind its siblings and never cuts one.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import { ROLLING_START_CALLOUTS } from "@iracedeck/callout-settings";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { SessionState } from "@iracedeck/iracing-sdk";
import type { LivePosition, PaceLineup } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import {
  _resetAudioScenarios,
  getScenarioEngine,
  initializeAudioScenarios,
  poolMemberPattern,
} from "../../interpreter.js";
import { familyGate } from "./callout-gate.test-util.js";
import { registerCautionVocabulary } from "./caution.js";
import { CAUTION_MAX_QUEUE_WAIT_MS } from "./flag-alerts.js";
import { registerPitCrew, type RollingStartCalloutId, SCENARIO_ID_TO_ROLLING_START_ID } from "./index.js";
import type { NamingEpisode } from "./named-car.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import {
  buildRollingStartContracts,
  ROLLING_START_CLIP_SOURCES,
  ROLLING_START_LINEUP_CHANGE_DELAY_MS,
  ROLLING_START_MAX_QUEUE_WAIT_MS,
  ROLLING_START_SCENARIO_IDS,
} from "./rolling-start.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const mockSessionType = vi.fn(() => "Race");

// The translator's live readers are stubbed; everything else is the real
// module, so the types and enums the catalog imports are the real ones.
vi.mock("@iracedeck/sim-events-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/sim-events-iracing")>()),
  getSessionType: () => mockSessionType(),
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
}));

/** Driver live in the car on the formation lap — what every contract's shared gate needs. */
const IN_CAR = { IsOnTrack: true, IsReplayPlaying: false, SessionState: SessionState.ParadeLaps };

const VOICE = "default";
const BUNDLED_SCRIPT = defaultScript as CalloutScript;
const BUNDLED_MANIFEST: AudioAssetsManifest = manifestJson;

const IDS: readonly RollingStartCalloutId[] = ["pace-car", "one-pace-lap-to-go", "lineup-changed"];

/** Which event each callout rides. */
const EVENT_OF: Record<RollingStartCalloutId, SimEventName> = {
  "pace-car": "rollingStart.pace-car-moving.raised",
  "one-pace-lap-to-go": "flag.one-pace-lap-to-go.raised",
  "lineup-changed": "rollingStart.lineup.changed",
};

/** The published scenario id of each — the middle one keeps the flag family's. */
const SCENARIO_OF: Record<RollingStartCalloutId, string> = {
  "pace-car": "pit-crew.rolling-start-pace-car",
  "one-pace-lap-to-go": "pit-crew.flag-one-pace-lap-to-go",
  "lineup-changed": "pit-crew.rolling-start-lineup-changed",
};

/** The two calls that name the car at their own moment; the change call is judged against them. */
const NAMING_IDS: readonly RollingStartCalloutId[] = ["pace-car", "one-pace-lap-to-go"];

/** The formation the translator reports — a fresh one opened behind {@link LINEUP}'s car unless a case says otherwise. */
let formationNow: NamingEpisode | null;
let lineupNow: PaceLineup | null;

/**
 * A fresh build every call — and so a fresh "last named" record. A case that
 * records through one contract's gate and reads through another's must build
 * ONCE and look both up in that build (see {@link find}).
 */
function contracts(): readonly ScenarioContract[] {
  return buildRollingStartContracts({
    getRollingStartFormation: () => formationNow,
    getPaceLineup: () => lineupNow,
  });
}

/** One contract out of a given build. */
function find(built: readonly ScenarioContract[], id: RollingStartCalloutId): ScenarioContract {
  const found = built.find((c) => c.id === SCENARIO_OF[id]);

  if (!found) throw new Error(`contract not found: ${id}`);

  return found;
}

function contract(id: RollingStartCalloutId): ScenarioContract {
  return find(contracts(), id);
}

function event(id: RollingStartCalloutId, telemetry: unknown = IN_CAR): SimEventOf<SimEventName> {
  return { event: EVENT_OF[id], timestamp: 0, telemetry, data: {} } as unknown as SimEventOf<SimEventName>;
}

/** Whether the call's `where:` admits the event. */
function fires(id: RollingStartCalloutId, telemetry: unknown = IN_CAR): boolean {
  return contract(id).when?.where?.(event(id, telemetry)) !== false;
}

/** Whether a gate of the given build admits now. */
function admits(built: readonly ScenarioContract[], id: RollingStartCalloutId): boolean | undefined {
  return find(built, id).speakGate?.admit({} as never);
}

/**
 * The player of the 2026-09-17 formation: car index 0 on the inside line, row
 * 5, behind car index 9 — car "07" — and eleventh on the grid.
 */
const LINEUP: PaceLineup = {
  followCarIdx: 9,
  followCarNumber: "07",
  line: "inside",
  isLeader: false,
  followsPaceCar: false,
  doubleFile: true,
  lineupPosition: 11,
  anchor: "grid",
  paceFlags: { endOfLine: false, freePass: false, wavedAround: false },
};

/** {@link LINEUP} with another car ahead. */
function behind(followCarIdx: number): PaceLineup {
  return { ...LINEUP, followCarIdx };
}

/** The pole-sitter: first, with only the pace car ahead. */
const POLE: PaceLineup = {
  ...LINEUP,
  followCarIdx: 20,
  followCarNumber: "0",
  isLeader: true,
  followsPaceCar: true,
  lineupPosition: 1,
};

/** The outside front-row car: only the pace car ahead in its own line, and second. */
const OUTSIDE_POLE: PaceLineup = { ...POLE, line: "outside", isLeader: false, lineupPosition: 2 };

/** No live race position to read — the lineup vocabulary's position entry is not under test. */
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

/** Finish everything playing and everything waiting. */
function flush(audio: FakeAudio, iterations = 20): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.SFX);
    audio._triggerChannelEnd(AudioChannel.Voice);
  }
}

function voiceClips(audio: FakeAudio): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

beforeEach(() => {
  vi.clearAllMocks();
  formationNow = { id: 1, firstFollowCarIdx: LINEUP.followCarIdx };
  lineupNow = LINEUP;
  mockSessionType.mockReturnValue("Race");
});

describe("the rolling-start contracts", () => {
  it("exports the three scenario ids, in the order a formation runs through them", () => {
    expect(ROLLING_START_SCENARIO_IDS).toEqual(IDS.map((id) => SCENARIO_OF[id]));
    expect(new Set(ROLLING_START_SCENARIO_IDS).size).toBe(ROLLING_START_SCENARIO_IDS.length);
  });

  it("maps every contract the family builds — an unmapped id makes registerPitCrew throw at plugin startup", () => {
    expect(SCENARIO_ID_TO_ROLLING_START_ID).toEqual(Object.fromEntries(IDS.map((id) => [SCENARIO_OF[id], id])));

    for (const c of contracts()) {
      expect(SCENARIO_ID_TO_ROLLING_START_ID[c.id], `no callout id for ${c.id}`).toBeDefined();
    }
  });

  it("gates each through an opt-in of the rolling-start family — the one-lap-to-green call under the key it always had", () => {
    expect(Object.keys(ROLLING_START_CALLOUTS.callouts)).toEqual([...IDS]);
    expect(ROLLING_START_CALLOUTS.callouts["pace-car"].key).toBe("calloutEnabledRollingStartPaceCar");
    expect(ROLLING_START_CALLOUTS.callouts["one-pace-lap-to-go"].key).toBe("calloutEnabledFlagOnePaceLapToGo");
    expect(ROLLING_START_CALLOUTS.callouts["lineup-changed"].key).toBe("calloutEnabledRollingStartLineupChanged");
  });

  it("rides one event each", () => {
    for (const id of IDS) expect(contract(id).when?.event, id).toBe(EVENT_OF[id]);
  });

  it("carries no sequence and takes the engine's default frame — what it says is the voice script's", () => {
    for (const id of IDS) {
      expect("sequence" in contract(id), id).toBe(false);
      expect(contract(id).frame, id).toBeUndefined();
    }
  });

  it("speaks on the Voice channel and bus, under the active voice's base path", () => {
    for (const id of IDS) {
      expect(contract(id).channel, id).toBe(AudioChannel.Voice);
      expect(contract(id).bus, id).toBe(AudioBus.Voice);
      expect(contract(id).base, id).toBe("voice/{voice}");
    }
  });

  it("is queueable throughout and never interrupts — no formation call is dropped behind the spotter, none cuts a line", () => {
    for (const id of IDS) {
      expect(contract(id).queueable, id).toBe(true);
      expect(contract(id).interrupt, id).not.toBe(true);
      expect(contract(id).cooldown, id).toBeUndefined();
    }
  });

  it("waits as long as a caution call for the bus — each is re-checked at speak time, so a late one is still true", () => {
    expect(ROLLING_START_MAX_QUEUE_WAIT_MS).toBe(CAUTION_MAX_QUEUE_WAIT_MS);

    for (const id of IDS) expect(contract(id).maxQueueWaitMs, id).toBe(ROLLING_START_MAX_QUEUE_WAIT_MS);
  });

  it("keeps the pace-car call in its own family at SAFETY weight, deciding at once", () => {
    const paceCar = contract("pace-car");

    expect(paceCar.family).toBe("rolling-start");
    expect(paceCar.weight).toBe(WEIGHT.SAFETY);
    expect(paceCar.triggerDelay).toBeUndefined();
  });

  it("keeps the one-lap-to-green call in the flag family at SAFETY weight — its id and preemption are the flag family's still", () => {
    const oneLap = contract("one-pace-lap-to-go");

    expect(oneLap.id).toBe("pit-crew.flag-one-pace-lap-to-go");
    expect(oneLap.family).toBe("flag");
    expect(oneLap.weight).toBe(WEIGHT.SAFETY);
    expect(oneLap.triggerDelay).toBeUndefined();
  });

  it("schedules the change call to wait, never to cut or overtake: no family, one notch below, queued behind both siblings", () => {
    const change = contract("lineup-changed");

    expect(change.family).toBeUndefined();
    expect(change.weight).toBe(WEIGHT.SAFETY - 1);
    expect([...(change.queueBehind ?? [])].sort()).toEqual(NAMING_IDS.map((id) => SCENARIO_OF[id]).sort());
  });

  it("holds the change's decision for a second and a half — a renumbering over several ticks is one decision", () => {
    expect(ROLLING_START_LINEUP_CHANGE_DELAY_MS).toBe(1500);
    expect(contract("lineup-changed").triggerDelay).toBe(ROLLING_START_LINEUP_CHANGE_DELAY_MS);
  });

  it("carries a description sentence for every one — the pack-author reference publishes them", () => {
    for (const id of IDS) {
      const description = contract(id).description ?? "";

      expect(description.length, id).toBeGreaterThan(0);
      expect(description.length, id).toBeLessThanOrEqual(200);
      expect(description.endsWith("."), id).toBe(true);
    }
  });

  it("says in the reference that the one-lap-to-green call needs two pace laps, and that the pace-car call names who you form up behind", () => {
    expect(contract("one-pace-lap-to-go").description).toMatch(/two-lap/);
    expect(contract("one-pace-lap-to-go").description).toMatch(/one-lap formation/);
    expect(contract("pace-car").description).toMatch(/who you form up behind/);
    expect(contract("pace-car").description).toMatch(/lane/);
  });

  it("stays silent out of the car, outside a race, and after the checkered", () => {
    for (const id of IDS) {
      expect(fires(id), `${id}: live in a race`).toBe(true);
      expect(fires(id, { ...IN_CAR, IsOnTrack: false }), `${id}: out of the car`).toBe(false);
      expect(fires(id, { ...IN_CAR, IsReplayPlaying: true }), `${id}: replay`).toBe(false);
      expect(fires(id, { ...IN_CAR, SessionState: SessionState.Checkered }), `${id}: post-race`).toBe(false);

      mockSessionType.mockReturnValue("Open Qualify");
      expect(fires(id), `${id}: qualifying`).toBe(false);
      mockSessionType.mockReturnValue("Race");
    }
  });

  it("decides the change after its hold only while a formation is running; the two flag-like calls leave that to their gate", () => {
    formationNow = null;

    expect(fires("lineup-changed")).toBe(false);
    expect(fires("pace-car")).toBe(true);
    expect(fires("one-pace-lap-to-go")).toBe(true);
  });
});

describe("the formation speak gate", () => {
  it("re-checks on every call that the formation is still running — a queued call must never drain into the launch", () => {
    for (const id of IDS) expect(contract(id).speakGate?.description, id).toMatch(/formation is still running/);

    // A build per call, so no call's record of the car it names silences the
    // change; and a formation opened behind another car, so the change is
    // news on every other count and only the formation can refuse it.
    for (const id of IDS) {
      formationNow = { id: 1, firstFollowCarIdx: 99 };
      expect(admits(contracts(), id), `${id}: running`).toBe(true);

      formationNow = null;
      expect(admits(contracts(), id), `${id}: over`).toBe(false);
    }
  });

  it("asks the pace-car and one-lap-to-green calls for no pace row — each has a numberless wording that must still speak", () => {
    const built = contracts();

    lineupNow = null;

    expect(admits(built, "pace-car")).toBe(true);
    expect(admits(built, "one-pace-lap-to-go")).toBe(true);
  });

  it("refuses the change once the player holds no pace row — a change to a lineup he is not in is no news", () => {
    formationNow = { id: 1, firstFollowCarIdx: 99 };
    const built = contracts();

    expect(find(built, "lineup-changed").speakGate?.description).toMatch(/still hold a pace row/);
    expect(admits(built, "lineup-changed"), "the positive control").toBe(true);

    lineupNow = null;
    expect(admits(built, "lineup-changed")).toBe(false);
  });
});

describe("the change call and the car last named in this formation (#1286's rule)", () => {
  /** What the change gate answers with the car `followCarIdx` ahead now. */
  function changeAdmits(built: readonly ScenarioContract[], followCarIdx: number): boolean | undefined {
    lineupNow = behind(followCarIdx);

    return admits(built, "lineup-changed");
  }

  it("says so in its gate's description", () => {
    expect(contract("lineup-changed").speakGate?.description).toMatch(/not the one last named in this formation/);
  });

  it("with nothing named, judges against the formation's first follow car — the baseline the diff does not report", () => {
    formationNow = { id: 1, firstFollowCarIdx: 9 };
    const built = contracts();

    expect(changeAdmits(built, 9)).toBe(false);
    expect(changeAdmits(built, 12)).toBe(true);
  });

  it("stays silent with nothing named and no first car to judge against", () => {
    formationNow = { id: 1, firstFollowCarIdx: null };
    const built = contracts();

    expect(changeAdmits(built, 12)).toBe(false);
  });

  it.each(NAMING_IDS)("judges against the car the %s call named, and records the car it names itself", (recorder) => {
    const built = contracts();

    lineupNow = behind(23);
    expect(admits(built, recorder)).toBe(true);

    // 23 was the first car's replacement AND the car just named: not news.
    expect(changeAdmits(built, 23)).toBe(false);
    expect(changeAdmits(built, 12)).toBe(true);
    // The change named 12, so 12 is no longer news…
    expect(changeAdmits(built, 12)).toBe(false);
    // …and the return to 23 is.
    expect(changeAdmits(built, 23)).toBe(true);
  });

  it("ignores a record from another formation — a restarted race, or a later session", () => {
    const built = contracts();

    lineupNow = behind(12);
    expect(admits(built, "pace-car")).toBe(true);
    expect(changeAdmits(built, 12)).toBe(false);

    // The next formation opens behind car 12 again: the old record is not its.
    formationNow = { id: 2, firstFollowCarIdx: 12 };
    expect(changeAdmits(built, 12)).toBe(false);
    expect(changeAdmits(built, 9)).toBe(true);
  });

  it("records nothing when a naming gate refuses — the previous record stands", () => {
    const built = contracts();

    lineupNow = behind(9);
    expect(admits(built, "pace-car")).toBe(true);

    // The formation is over by the time one lap to green would have spoken.
    const formation = formationNow;
    formationNow = null;
    lineupNow = behind(12);
    expect(admits(built, "one-pace-lap-to-go")).toBe(false);

    formationNow = formation;
    expect(changeAdmits(built, 12)).toBe(true);
  });

  it("records nothing when a naming call speaks with no lineup to read — it needs no row, but names no car", () => {
    const built = contracts();

    lineupNow = behind(9);
    expect(admits(built, "pace-car")).toBe(true);

    lineupNow = null;
    expect(admits(built, "one-pace-lap-to-go")).toBe(true);

    expect(changeAdmits(built, 9)).toBe(false);
    expect(changeAdmits(built, 12)).toBe(true);
  });

  it("keeps its record apart from another build's", () => {
    const first = contracts();
    const second = contracts();

    lineupNow = behind(12);
    expect(admits(first, "pace-car")).toBe(true);

    // The second build named nothing: 12 is news against the first car, 9.
    expect(changeAdmits(second, 12)).toBe(true);
  });
});

/**
 * The bundled voice's wording, through the real engine. The script and the
 * car-number clips are the bundled voice's own; the rolling-start clips the
 * numbered and front-row wordings draw on are named here as well, so these
 * cases say which clip each lineup gets whether or not that clip has been
 * recorded yet — `bundled-scripts.test.ts`, and the last block of this file,
 * are what hold the bundled voice to shipping them.
 */
describe("the formation calls in the bundled voice", () => {
  const rollingStartClip = (name: string): string => `voice/${VOICE}/rolling-start/${name}.mp3`;
  const cautionClip = (name: string): string => `voice/${VOICE}/caution/${name}.mp3`;
  const CAR_07 = `voice/${VOICE}/car-number/07.mp3`;

  const MANIFEST: AudioAssetsManifest = {
    ...BUNDLED_MANIFEST,
    clips: [
      ...new Set([
        ...BUNDLED_MANIFEST.clips,
        ...["inside", "outside", "behind", "leader", "front-row"].map((tail) =>
          rollingStartClip(`pace-car-moving-${tail}-01`),
        ),
      ]),
    ],
  };

  /** Everything the Voice channel plays for one fire of the contract, with the lineup given. */
  function spoken(id: RollingStartCalloutId, lineup: PaceLineup | null): string[] {
    // A fresh engine per fire: a case may ask for more than one lineup.
    _resetAudioScenarios();

    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, MANIFEST, mockLogger as never, () => VOICE);

    // A formation opened behind another car, so a change is news on every
    // count but the one a case is about.
    formationNow = { id: 1, firstFollowCarIdx: 99 };
    lineupNow = lineup;
    registerCautionVocabulary(engine, () => lineupNow, NO_LIVE_POSITION);
    engine.defineContract(contract(id));
    engine.setScripts(new Map([[VOICE, BUNDLED_SCRIPT]]));

    bus.publish(event(id));
    // The change holds before deciding; the lineup is read when the hold ends.
    vi.advanceTimersByTime(ROLLING_START_LINEUP_CHANGE_DELAY_MS + 1);
    flush(audio);

    return voiceClips(audio);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin every pool draw to its first take, so the expectations name a clip.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetAudioScenarios();
  });

  it("the car-number clip these cases expect is the bundled voice's own", () => {
    expect(BUNDLED_MANIFEST.clips).toContain(CAR_07);
  });

  describe("pace car moving", () => {
    it("names the lane and the car on an oval running double file — the car spoken as the sim spells it", () => {
      expect(spoken("pace-car", { ...LINEUP, line: "inside" })).toEqual([
        rollingStartClip("pace-car-moving-inside-01"),
        CAR_07,
      ]);
      expect(spoken("pace-car", { ...LINEUP, line: "outside" })).toEqual([
        rollingStartClip("pace-car-moving-outside-01"),
        CAR_07,
      ]);
    });

    it("names the car without a lane single file or off an oval", () => {
      expect(spoken("pace-car", { ...LINEUP, line: null, doubleFile: false })).toEqual([
        rollingStartClip("pace-car-moving-behind-01"),
        CAR_07,
      ]);
    });

    it("tells the pole-sitter he is on pole, and the car with only the pace car ahead and not leading only that", () => {
      expect(spoken("pace-car", POLE)).toEqual([rollingStartClip("pace-car-moving-leader-01")]);
      expect(spoken("pace-car", OUTSIDE_POLE)).toEqual([rollingStartClip("pace-car-moving-front-row-01")]);
    });

    it("says what it says today with no lineup to read — a rolling start that publishes no pace rows", () => {
      expect(spoken("pace-car", null)).toEqual([rollingStartClip("pace-car-moving-01")]);
    });

    it("says what it says today with a car ahead the session cannot name — never nothing", () => {
      expect(spoken("pace-car", { ...LINEUP, followCarNumber: null })).toEqual([
        rollingStartClip("pace-car-moving-01"),
      ]);
    });
  });

  describe("one lap to green", () => {
    it("says the caution's sentence from the caution's clips, with the lane and the car", () => {
      expect(spoken("one-pace-lap-to-go", { ...LINEUP, line: "inside" })).toEqual([
        cautionClip("one-to-go-inside-01"),
        CAR_07,
      ]);
      expect(spoken("one-pace-lap-to-go", { ...LINEUP, line: "outside" })).toEqual([
        cautionClip("one-to-go-outside-01"),
        CAR_07,
      ]);
    });

    it("names the car without a lane single file or off an oval", () => {
      expect(spoken("one-pace-lap-to-go", { ...LINEUP, line: null, doubleFile: false })).toEqual([
        cautionClip("one-to-go-plain-01"),
        CAR_07,
      ]);
    });

    it("tells the pole-sitter he leads them away, and the outside front-row car the plain line", () => {
      expect(spoken("one-pace-lap-to-go", POLE)).toEqual([cautionClip("one-to-go-leader-01")]);
      expect(spoken("one-pace-lap-to-go", OUTSIDE_POLE)).toEqual([cautionClip("one-to-go-01")]);
    });

    it('still says "One lap to green." with no lineup to read, and with a car it cannot name — never nothing', () => {
      expect(spoken("one-pace-lap-to-go", null)).toEqual([cautionClip("one-to-go-01")]);
      expect(spoken("one-pace-lap-to-go", { ...LINEUP, followCarNumber: null })).toEqual([cautionClip("one-to-go-01")]);
    });
  });

  describe("the car ahead changed", () => {
    it("says the caution's change line with the lane and the new car", () => {
      expect(spoken("lineup-changed", { ...LINEUP, line: "inside" })).toEqual([
        cautionClip("lineup-changed-inside-01"),
        CAR_07,
      ]);
      expect(spoken("lineup-changed", { ...LINEUP, line: "outside" })).toEqual([
        cautionClip("lineup-changed-outside-01"),
        CAR_07,
      ]);
    });

    it("names the new car without a lane single file or off an oval", () => {
      expect(spoken("lineup-changed", { ...LINEUP, line: null, doubleFile: false })).toEqual([
        cautionClip("lineup-changed-plain-01"),
        CAR_07,
      ]);
    });

    it("says the driver is at the front now when only the pace car is left ahead", () => {
      expect(spoken("lineup-changed", POLE)).toEqual([cautionClip("lineup-changed-leader-01")]);
    });

    it("still says the car ahead changed when the session cannot name the new one — never nothing", () => {
      expect(spoken("lineup-changed", { ...LINEUP, followCarNumber: null })).toEqual([
        cautionClip("lineup-changed-noname-01"),
      ]);
    });

    it("says nothing once the player holds no pace row", () => {
      expect(spoken("lineup-changed", null)).toEqual([]);
    });
  });
});

/**
 * Scheduling, through the real engine against a synthetic one-clip-per-call
 * script: no structural assertion can tell waiting apart from cutting, or a
 * refused replay apart from one that never queued.
 */
describe("the formation calls on a busy bus", () => {
  const clip = (name: string): string => `voice/${VOICE}/rolling-start/${name}-01.mp3`;
  const PACE_CAR = clip("pace-car");
  const ONE_LAP = clip("one-lap");
  const CHANGE = clip("change");

  /** Stands in for the spotter holding the Voice bus — PROXIMITY outranks every formation call. */
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
      PACE_CAR,
      ONE_LAP,
      CHANGE,
      HOG_CLIP,
    ],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  const entry = (pool: string): unknown => ({ comment: "c", test: "t", sequence: [`pool:${pool}`] });
  const script = {
    schema: 1,
    scenarios: {
      [SCENARIO_OF["pace-car"]]: entry("rolling-start/pace-car"),
      [SCENARIO_OF["one-pace-lap-to-go"]]: entry("rolling-start/one-lap"),
      [SCENARIO_OF["lineup-changed"]]: entry("rolling-start/change"),
      "pit-crew.flag-debris": entry("flags/debris"),
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

  type Run = {
    /** Publish a formation callout's event, at the formation and lineup the case has set. */
    publish: (id: RollingStartCalloutId) => void;
    /** The spotter takes the Voice bus and holds it until the next flush. */
    hogBus: () => void;
    /** Let the radio frame's open tick finish, so a starting body reaches the Voice channel. */
    openTick: () => void;
    flush: () => void;
    played: () => string[];
    cutVoice: () => boolean;
  };

  /** Every formation contract from one build, plus the hog; `changeOverrides` re-schedules the change for a positive control. */
  function run(changeOverrides: Partial<ScenarioContract> = {}): Run {
    const bus = createMockBus();
    const audio = createFakeAudio();
    const engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

    for (const c of contracts()) {
      engine.defineContract(c.id === SCENARIO_OF["lineup-changed"] ? { ...c, ...changeOverrides } : c);
    }

    engine.defineContract(HOG);
    engine.setScripts(new Map([[VOICE, script]]));

    return {
      publish: (id) => bus.publish(event(id)),
      hogBus: () => {
        bus.publish({
          event: "flag.debris.raised",
          timestamp: 0,
          telemetry: IN_CAR,
          data: {},
        } as unknown as SimEventOf<SimEventName>);
        audio._triggerChannelEnd(AudioChannel.SFX);
      },
      openTick: () => audio._triggerChannelEnd(AudioChannel.SFX),
      flush: () => flush(audio),
      played: () => voiceClips(audio),
      cutVoice: () =>
        (audio.stopChannel as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
          (call) => call[0] === AudioChannel.Voice,
        ),
    };
  }

  /** Past the change's hold, plus a tick. */
  const HOLD = ROLLING_START_LINEUP_CHANGE_DELAY_MS + 1;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetAudioScenarios();
  });

  it.each(NAMING_IDS)("waits for the spotter and then speaks — the %s call is not dropped for a busy bus", (id) => {
    const r = run();

    r.hogBus();
    r.publish(id);
    r.flush();

    expect(r.played()).toEqual([HOG_CLIP, id === "pace-car" ? PACE_CAR : ONE_LAP]);
  });

  it.each(IDS)("refuses a queued %s call once the formation has ended — nothing drains into the launch", (id) => {
    const r = run();

    formationNow = { id: 1, firstFollowCarIdx: 99 };
    r.hogBus();
    r.publish(id);
    vi.advanceTimersByTime(HOLD);

    // The green is held, or shown, while the call waits.
    formationNow = null;
    r.flush();

    expect(r.played()).toEqual([HOG_CLIP]);
  });

  describe("a change behind the pace-car call still waiting for the bus", () => {
    function changeBehindWaitingPaceCar(r: Run): void {
      r.hogBus();
      r.publish("pace-car");
      // The car ahead drops out while both wait: the lineup now names car 12.
      lineupNow = behind(12);
      r.publish("lineup-changed");
      vi.advanceTimersByTime(HOLD);
      r.flush();
    }

    it("lets the pace-car call go first, and is then refused — that call read the lineup live and named the new car", () => {
      const r = run();

      changeBehindWaitingPaceCar(r);

      expect(r.played()).toEqual([HOG_CLIP, PACE_CAR]);
    });

    it("would play ahead of it if it outweighed it with no queueBehind — the positive control (judged before the car is named, both speak)", () => {
      const r = run({ weight: WEIGHT.SAFETY + 1, queueBehind: undefined });

      changeBehindWaitingPaceCar(r);

      expect(r.played()).toEqual([HOG_CLIP, CHANGE, PACE_CAR]);
    });
  });

  describe("a change deciding while the pace-car call plays", () => {
    /** "Pace car's rolling" names car 9 and is still playing when the change's hold ends; the car ahead by then is `aheadAtDecision`. */
    function changeDuringPaceCar(r: Run, aheadAtDecision: number): void {
      lineupNow = behind(9);
      r.publish("pace-car");
      r.openTick();

      lineupNow = behind(aheadAtDecision);
      r.publish("lineup-changed");
      vi.advanceTimersByTime(HOLD);
    }

    it("naming the car just named: never cuts it, and is not spoken after it", () => {
      const r = run();

      changeDuringPaceCar(r, 9);

      expect(r.cutVoice()).toBe(false);
      r.flush();
      expect(r.played()).toEqual([PACE_CAR]);
    });

    it("naming a new car: never cuts it, and is spoken after it", () => {
      const r = run();

      changeDuringPaceCar(r, 12);

      expect(r.cutVoice()).toBe(false);
      r.flush();
      expect(r.played()).toEqual([PACE_CAR, CHANGE]);
    });

    it("would cut it mid-word in the rolling-start family — the positive control for leaving the change out of it", () => {
      const r = run({ family: "rolling-start" });

      changeDuringPaceCar(r, 12);

      expect(r.cutVoice()).toBe(true);
    });
  });

  it("a genuine change waiting when one lap to green arrives lets it go ahead, and is then refused — one lap to green named the new car", () => {
    const r = run();

    // "Pace car's rolling" named car 9 a lap ago.
    lineupNow = behind(9);
    r.publish("pace-car");
    r.flush();

    r.hogBus();
    lineupNow = behind(12);
    r.publish("lineup-changed");
    vi.advanceTimersByTime(HOLD);
    r.publish("one-pace-lap-to-go");
    r.flush();

    expect(r.played()).toEqual([PACE_CAR, HOG_CLIP, ONE_LAP]);
  });

  it("speaks a change on its own once the car named has gone — the ordinary case", () => {
    const r = run();

    lineupNow = behind(9);
    r.publish("pace-car");
    r.flush();

    lineupNow = behind(12);
    r.publish("lineup-changed");
    vi.advanceTimersByTime(HOLD);
    r.flush();

    expect(r.played()).toEqual([PACE_CAR, CHANGE]);
  });

  it("coalesces a round trip inside the hold into silence", () => {
    const r = run();

    lineupNow = behind(9);
    r.publish("pace-car");
    r.flush();

    lineupNow = behind(12);
    r.publish("lineup-changed");
    vi.advanceTimersByTime(HOLD - 500);
    // Back to the car already named before the hold ends: a fresh event replaces the held one.
    lineupNow = behind(9);
    r.publish("lineup-changed");
    vi.advanceTimersByTime(HOLD);
    r.flush();

    expect(r.played()).toEqual([PACE_CAR]);
  });
});

/**
 * The opt-ins and the reader defaults, wired through `registerPitCrew` as
 * the plugins wire them. The script is the bundled voice's, narrowed to this
 * family's entries; the manifest carries one clip per pool those entries can
 * reach with no lineup to read, which is all these cases need.
 */
describe("the formation calls through registerPitCrew", () => {
  const NUMBERLESS: Record<RollingStartCalloutId, string> = {
    "pace-car": `voice/${VOICE}/rolling-start/pace-car-moving-01.mp3`,
    "one-pace-lap-to-go": `voice/${VOICE}/caution/one-to-go-01.mp3`,
    "lineup-changed": `voice/${VOICE}/caution/lineup-changed-noname-01.mp3`,
  };

  const manifest: AudioAssetsManifest = {
    clips: ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3", ...Object.values(NUMBERLESS)],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  const FAMILY_SCRIPT: CalloutScript = {
    ...BUNDLED_SCRIPT,
    scenarios: Object.fromEntries(ROLLING_START_SCENARIO_IDS.map((id) => [id, BUNDLED_SCRIPT.scenarios[id]])),
    fragments: {},
  };

  /** A lineup whose car the session cannot name: every call takes its numberless wording. */
  const UNNAMED: PaceLineup = { ...LINEUP, followCarNumber: null };

  let enabled: Map<RollingStartCalloutId, boolean>;
  let bus: IEventBus;
  let audio: FakeAudio;

  /** Register the catalog; `wired` is whether the two formation readers are handed over at all. */
  function register(wired: boolean): void {
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

    registerPitCrew(bus, {
      logger: mockLogger as never,
      isCalloutEnabled: familyGate(ROLLING_START_CALLOUTS, (id) => enabled.get(id) ?? true),
      ...(wired
        ? { getRollingStartFormation: () => ({ id: 1, firstFollowCarIdx: 99 }), getPaceLineup: () => UNNAMED }
        : {}),
    });
    // A contract is silent without a script (issue #1065): the gate is what is
    // under test here, so the line must be there to be gated.
    getScenarioEngine().setScripts(new Map([[VOICE, FAMILY_SCRIPT]]));
  }

  function fire(id: RollingStartCalloutId): string[] {
    bus.publish(event(id));
    vi.advanceTimersByTime(ROLLING_START_LINEUP_CHANGE_DELAY_MS + 1);
    flush(audio);

    return voiceClips(audio);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    enabled = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetAudioScenarios();
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
  });

  it.each(IDS)("%s speaks when its opt-in is on", (id) => {
    register(true);

    expect(fire(id)).toEqual([NUMBERLESS[id]]);
  });

  it.each(IDS)("%s is suppressed when its opt-in is off, and says so at debug level", (id) => {
    enabled.set(id, false);
    register(true);

    expect(fire(id)).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith(`rolling-start callout suppressed: ${id}`);
  });

  it("switching one off leaves the other two speaking", () => {
    enabled.set("lineup-changed", false);
    register(true);

    expect(fire("pace-car")).toEqual([NUMBERLESS["pace-car"]]);
    expect(fire("one-pace-lap-to-go")).toEqual([NUMBERLESS["pace-car"], NUMBERLESS["one-pace-lap-to-go"]]);
  });

  it.each(IDS)("%s stays silent for a caller that wires no formation reader — never an ungated call", (id) => {
    register(false);

    expect(fire(id)).toEqual([]);
  });
});

describe("the bundled script's rolling-start entries (issues #1065, #1167)", () => {
  const FAMILY_SCRIPT: CalloutScript = {
    ...BUNDLED_SCRIPT,
    scenarios: Object.fromEntries(ROLLING_START_SCENARIO_IDS.map((id) => [id, BUNDLED_SCRIPT.scenarios[id]])),
    fragments: {},
  };

  it("scripts every contract with a comment, a Rolling Start harness route and a sequence", () => {
    for (const id of ROLLING_START_SCENARIO_IDS) {
      const entry = BUNDLED_SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Rolling Start → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("names only the rollingStart vocabulary — never the caution's names, and no position", () => {
    const refs = collectScriptReferences(FAMILY_SCRIPT);

    expect([...refs.vars].sort()).toEqual(["rollingStart.followCarNumber"]);
    expect([...refs.conds].sort()).toEqual([
      "rollingStart.followsPaceCar",
      "rollingStart.hasFollowCarNumber",
      "rollingStart.isLeader",
    ]);
    expect(refs.cases.map((c) => c.name)).toEqual(["rollingStart.line"]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(FAMILY_SCRIPT.pools ?? {})).toEqual([]);
  });

  it("addresses exactly the published clip sources — its own six, and the ten it shares with the caution family", () => {
    const sources = ROLLING_START_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`);

    expect([...collectScriptReferences(FAMILY_SCRIPT).pools].sort()).toEqual([...sources].sort());
    expect(sources.filter((source) => source.startsWith("rolling-start/"))).toHaveLength(6);
    expect(sources.filter((source) => source.startsWith("caution/"))).toHaveLength(10);
  });

  it("says one lap to green in the caution's own pools — the start and the restart share the words", () => {
    const pools = collectScriptReferences({
      ...FAMILY_SCRIPT,
      scenarios: { one: BUNDLED_SCRIPT.scenarios["pit-crew.flag-one-pace-lap-to-go"] },
    }).pools;
    const cautionPools = collectScriptReferences({
      ...FAMILY_SCRIPT,
      scenarios: { one: BUNDLED_SCRIPT.scenarios["pit-crew.caution-one-to-go"] },
    }).pools;

    expect([...pools].sort()).toEqual([...cautionPools].sort());
  });

  it("every clip source has a clip in the bundled voice", () => {
    for (const { group, base } of ROLLING_START_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        BUNDLED_MANIFEST.clips.some((c) => pattern.exec(c)?.[1] === VOICE),
        `no voice/${VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });
});
