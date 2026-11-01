/**
 * The fastest lap of the race (issue #1571): the contract driven through the
 * real scenario engine and the real `registerPitCrew`, over a hand-built
 * default-voice entry in the shape the spec's decision 4 gives (its bundled
 * entry is authored with its clips) and a manifest of exactly the clips the
 * lines below need. The holder case, the positions, the gap clause, the
 * grace, the caution and finish gates, the drop rule and the scheduling are
 * each pinned with a positive control beside the refusal.
 */
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, type CalloutScriptEntry, collectScriptReferences } from "@iracedeck/callout-script";
import { FASTEST_LAP_CALLOUTS, LAP_TIME_CALLOUTS } from "@iracedeck/callout-settings";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import type { LiveGaps } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import {
  buildFastestLap,
  FASTEST_LAP_CLIP_SOURCES,
  FASTEST_LAP_HOLDER_KEYS,
  FASTEST_LAP_SCENARIO_IDS,
  type FastestLapData,
  relationPositions,
  resolveFastestLapHolder,
  SCENARIO_ID_TO_FASTEST_LAP_ID,
} from "./fastest-lap.js";
import { speakableGap } from "./gaps.js";
import { registerPitCrew } from "./index.js";
import type { LapCompletedSnapshot } from "./lap-time.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import type { LivePosition } from "./position-readout.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const VOICE = "default";

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & { publishEvent: (name: SimEventName, data: object) => void } {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
    },
    publishEvent(name: SimEventName, data: object) {
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
  end: (channel: AudioChannel) => void;
  played: { channel: AudioChannel; path: string }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks = new Map<AudioChannel, () => void>();
  const played: { channel: AudioChannel; path: string }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string) => {
      played.push({ channel, path });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => callbacks.delete(channel)),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => callbacks.set(channel, cb)),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
    end: (channel: AudioChannel) => {
      const cb = callbacks.get(channel);
      callbacks.delete(channel);
      cb?.();
    },
    played,
  } as unknown as FakeAudio;
}

/** The default voice's entry, in the spec's shape (decision 4). */
const DEFAULT_ENTRY: CalloutScriptEntry = {
  comment: "A new fastest lap of the race in our class.",
  test: "Harness → Fastest Lap → Yours.",
  sequence: [
    {
      case: "fastestLap.holder",
      of: {
        yours: ["pool:fastest-lap/yours"],
        "taken-from-you": ["{{fastestLap.carNumber}}", "pool:fastest-lap/taken-from-you"],
        leader: ["pool:fastest-lap/leader"],
        ahead: ["pool:fastest-lap/ahead"],
        behind: ["pool:fastest-lap/behind"],
        other: ["{{fastestLap.carNumber}}", "pool:fastest-lap/in", "{{fastestLap.position}}", "pool:fastest-lap/other"],
      },
    },
    { if: "fastestLap.hasMinuteComponent", then: ["{{fastestLap.minute}}"] },
    "{{fastestLap.second}}",
    "{{fastestLap.decimal}}",
    { optional: ["{{fastestLap.gapIntro}}", "{{fastestLap.gapSecond}}", "{{fastestLap.gapDecimal}}"] },
  ],
};

/** The Short Calls voice's entry, in the spec's shape (decision 6): `other` and `taken-from-you` lead into the number. */
const SHORT_CALLS_ENTRY: CalloutScriptEntry = {
  comment: "Fastest lap.",
  test: "Harness → Fastest Lap → Yours.",
  sequence: [
    {
      case: "fastestLap.holder",
      of: {
        yours: ["pool:fastest-lap/yours"],
        "taken-from-you": ["pool:fastest-lap/lost-to", "{{fastestLap.carNumber}}"],
        leader: ["pool:fastest-lap/leader"],
        ahead: ["pool:fastest-lap/ahead"],
        behind: ["pool:fastest-lap/behind"],
        other: ["pool:fastest-lap/for", "{{fastestLap.carNumber}}"],
      },
    },
    { if: "fastestLap.hasMinuteComponent", then: ["{{fastestLap.minute}}"] },
    "{{fastestLap.second}}",
    "{{fastestLap.decimal}}",
    { optional: ["{{fastestLap.gapIntro}}", "{{fastestLap.gapSecond}}", "{{fastestLap.gapDecimal}}"] },
  ],
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled frames and the best-lap entry (the precedence's partner), plus the hand-built fastest-lap entry. */
const TEST_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: {
    "pit-crew.lap-time-best": SCRIPT.scenarios["pit-crew.lap-time-best"],
    "pit-crew.fastest-lap-race": DEFAULT_ENTRY,
  },
  fragments: {},
};

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...["yours", "taken-from-you", "leader", "ahead", "behind", "in", "other"].map(
      (b) => `voice/${VOICE}/fastest-lap/${b}-01.mp3`,
    ),
    ...["5", "7", "42"].map((n) => `voice/${VOICE}/car-number/${n}.mp3`),
    ...["1", "2", "3", "4", "6", "8"].map((n) => `voice/${VOICE}/position-number/${n}.mp3`),
    // 1:23.4 and 1:22.1 in the compact form, to the tenth.
    `voice/${VOICE}/lap-time-compact-minute/1-twenty.mp3`,
    `voice/${VOICE}/lap-time-compact-second/23.mp3`,
    `voice/${VOICE}/lap-time-compact-second/22.mp3`,
    `voice/${VOICE}/lap-time-compact-second/58.mp3`,
    `voice/${VOICE}/lap-time-compact-tenth/4.mp3`,
    `voice/${VOICE}/lap-time-compact-tenth/1.mp3`,
    // The gap clause.
    `voice/${VOICE}/gap/readout-intro-01.mp3`,
    `voice/${VOICE}/lap-time-second/1.mp3`,
    `voice/${VOICE}/lap-time-decimal/2.mp3`,
    // The best-lap readout the precedence and the queue tests use.
    `voice/${VOICE}/lap-time-intro/best-lap-yet.mp3`,
    `voice/${VOICE}/lap-time-minute/1.mp3`,
    `voice/${VOICE}/lap-time-second/23.mp3`,
    `voice/${VOICE}/lap-time-decimal/4.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let fastestLapEnabled: boolean;
let underCaution: boolean;
let raceFinished: boolean;
let latestLap: LapCompletedSnapshot | null;
let liveCar: Map<number, { position: number; classPosition: number }>;
let livePlayer: LivePosition | null;
let liveGaps: LiveGaps | null;

function record(overrides: Partial<FastestLapData> = {}): FastestLapData {
  return {
    carIdx: 3,
    isPlayer: false,
    lap: 5,
    lapTime: 83.4,
    carNumber: "5",
    position: 6,
    playerPosition: 4,
    playerLapsCompleted: 5,
    ...overrides,
  };
}

function bestLap(overrides: Partial<LapCompletedSnapshot> = {}): LapCompletedSnapshot {
  return { lap: 5, lapTime: 83.4, isBest: true, isFirstValid: false, sessionType: "race", ...overrides };
}

function flush(iterations = 60): void {
  for (let i = 0; i < iterations; i++) {
    audio.end(AudioChannel.Voice);
    audio.end(AudioChannel.SFX);
    vi.advanceTimersByTime(1000);
  }
}

/** The voice clips played, as `<group>/<base>` with a take suffix dropped. */
function line(): string[] {
  return audio.played
    .filter((p) => p.channel === AudioChannel.Voice)
    .map((p) =>
      p.path
        .split(`voice/${VOICE}/`)[1]
        .replace(/\.mp3$/, "")
        .replace(/-01$/, ""),
    );
}

function fire(data: FastestLapData): void {
  bus.publishEvent("fastestLap.set", data);
  flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  fastestLapEnabled = true;
  underCaution = false;
  raceFinished = false;
  latestLap = null;
  liveCar = new Map();
  livePlayer = null;
  liveGaps = null;
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getSessionType: () => "Race",
    isCalloutEnabled: (key) => (key === "calloutEnabledFastestLap" ? fastestLapEnabled : true),
    getUnderFullCourseCaution: () => underCaution,
    getRaceFinishedFired: () => raceFinished,
    getLapCompletedSnapshot: () => latestLap,
    getOpponentFlagLivePosition: ({ carIdx, isMultiClass }) => {
      const p = liveCar.get(carIdx);

      return p ? (isMultiClass ? p.classPosition : p.position) : null;
    },
    getLivePosition: () => livePlayer,
    getLiveGaps: () => liveGaps,
  });
  getScenarioEngine().setScripts(new Map([[VOICE, TEST_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const TIME = ["lap-time-compact-minute/1-twenty", "lap-time-compact-second/23", "lap-time-compact-tenth/4"];

describe("the holder case, from payloads built for each key (live reads unknown)", () => {
  it("yours: the player set it", () => {
    fire(record({ isPlayer: true, carIdx: 0, position: 4, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/yours", ...TIME]);
  });

  it("taken-from-you: another car beat the player's record, named by its number", () => {
    fire(record({ previous: { carIdx: 0, lapTime: 83.9, isPlayer: true } }));

    expect(line()).toEqual(["car-number/5", "fastest-lap/taken-from-you", ...TIME]);
  });

  it("leader: the car leads", () => {
    fire(record({ position: 1 }));

    expect(line()).toEqual(["fastest-lap/leader", ...TIME]);
  });

  it("ahead: the car one place ahead of the player", () => {
    fire(record({ position: 3, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/ahead", ...TIME]);
  });

  it("behind: the car one place behind the player", () => {
    fire(record({ position: 5, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/behind", ...TIME]);
  });

  it("other: any other car, by number and position", () => {
    fire(record({ position: 6, playerPosition: 4 }));

    expect(line()).toEqual(["car-number/5", "fastest-lap/in", "position-number/6", "fastest-lap/other", ...TIME]);
  });

  it("aborts a line that needs the car number when the payload has none — never a half line", () => {
    fire(record({ carNumber: undefined }));

    expect(line()).toEqual([]);
  });

  it("speaks a sub-minute record without a minute (58.1)", () => {
    fire(record({ position: 1, lapTime: 58.1 }));

    expect(line()).toEqual(["fastest-lap/leader", "lap-time-compact-second/58", "lap-time-compact-tenth/1"]);
  });
});

describe("the precedence of the keys", () => {
  it("the player who is also the leader hears yours", () => {
    fire(record({ isPlayer: true, carIdx: 0, position: 1, playerPosition: 1 }));

    expect(line()[0]).toBe("fastest-lap/yours");
  });

  it("a record the leader takes from the player is taken-from-you", () => {
    fire(record({ position: 1, playerPosition: 2, previous: { carIdx: 0, lapTime: 83.9, isPlayer: true } }));

    expect(line().slice(0, 2)).toEqual(["car-number/5", "fastest-lap/taken-from-you"]);
  });

  it("the car ahead that leads is the leader", () => {
    fire(record({ position: 1, playerPosition: 2 }));

    expect(line()[0]).toBe("fastest-lap/leader");
  });
});

describe("positions: live wins, the payload's pair is the fallback", () => {
  it("live positions win over the payload's", () => {
    // The payload says other (P6 vs P4); live says the car is right ahead.
    liveCar.set(3, { position: 3, classPosition: 3 });
    livePlayer = { position: 4, classPosition: 4, isMultiClass: false };
    fire(record({ position: 6, playerPosition: 4 }));

    expect(line()[0]).toBe("fastest-lap/ahead");
  });

  it("the payload's pair is used when a live read is unknown", () => {
    liveCar.set(3, { position: 3, classPosition: 3 });
    livePlayer = null;
    fire(record({ position: 5, playerPosition: 4 }));

    expect(line()[0]).toBe("fastest-lap/behind");
  });

  it("reads class positions in a multi-class payload", () => {
    liveCar.set(3, { position: 8, classPosition: 3 });
    livePlayer = { position: 20, classPosition: 4, isMultiClass: true };
    fire(record({ position: 9, playerPosition: 9, isMultiClass: true }));

    expect(line()[0]).toBe("fastest-lap/ahead");
  });

  it("reads overall positions in a single-class payload (the positive control)", () => {
    liveCar.set(3, { position: 8, classPosition: 3 });
    livePlayer = { position: 20, classPosition: 4, isMultiClass: true };
    fire(record({ position: 9, playerPosition: 9 }));

    expect(line().slice(0, 4)).toEqual(["car-number/5", "fastest-lap/in", "position-number/8", "fastest-lap/other"]);
  });

  it("speaks the live position for other", () => {
    liveCar.set(3, { position: 8, classPosition: 8 });
    livePlayer = { position: 4, classPosition: 4, isMultiClass: false };
    fire(record({ position: 6 }));

    expect(line()).toContain("position-number/8");
  });

  it("relationPositions pairs both live reads, or both payload values", () => {
    const data = record({ position: 6, playerPosition: 4 });

    expect(
      relationPositions(data, {
        getCarLivePosition: () => 2,
        getLivePosition: () => ({ position: 3, classPosition: 3, isMultiClass: false }),
      }),
    ).toEqual({ car: 2, player: 3 });
    expect(relationPositions(data, { getCarLivePosition: () => 2, getLivePosition: () => null })).toEqual({
      car: 6,
      player: 4,
    });
  });
});

describe("the gap clause", () => {
  const gaps = (side: "ahead" | "behind", carIdx: number, gapSeconds: number | null, lapDelta = 0): LiveGaps =>
    ({ ahead: null, behind: null, [side]: { carIdx, gapSeconds, lapDelta } }) as unknown as LiveGaps;
  const GAP = ["gap/readout-intro", "lap-time-second/1", "lap-time-decimal/2"];

  it("plays for ahead when the live neighbour ahead is the fire's car on the same lap under a minute", () => {
    liveGaps = gaps("ahead", 3, 1.2);
    fire(record({ position: 3, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/ahead", ...TIME, ...GAP]);
  });

  it("plays for behind on the behind side", () => {
    liveGaps = gaps("behind", 3, 1.2);
    fire(record({ position: 5, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/behind", ...TIME, ...GAP]);
  });

  it("is left out, the line still playing, when the neighbour is another car, a lap away or a minute or more away", () => {
    for (const g of [gaps("ahead", 9, 1.2), gaps("ahead", 3, 1.2, 1), gaps("ahead", 3, 61), gaps("behind", 3, 1.2)]) {
      audio.played.length = 0;
      liveGaps = g;
      fire(record({ position: 3, playerPosition: 4 }));

      expect(line()).toEqual(["fastest-lap/ahead", ...TIME]);
    }
  });

  it("never plays for the other keys, even with a matching gap on a side", () => {
    liveGaps = gaps("ahead", 3, 1.2);
    fire(record({ position: 1, playerPosition: 2 }));

    expect(line()).toEqual(["fastest-lap/leader", ...TIME]);
  });

  it("speakableGap is the gap family's rule: the named car, same lap, under a minute", () => {
    expect(speakableGap(gaps("ahead", 3, 1.25), "ahead", 3)).toEqual({ seconds: 1, tenths: 3 });
    expect(speakableGap(gaps("ahead", 3, 1.25), "behind", 3)).toBeNull();
    expect(speakableGap(gaps("ahead", 3, 1.25), "ahead", 4)).toBeNull();
    expect(speakableGap(gaps("ahead", 3, null), "ahead", 3)).toBeNull();
    expect(speakableGap(gaps("ahead", 3, 59.96), "ahead", 3)).toBeNull();
    expect(speakableGap(null, "ahead", 3)).toBeNull();
  });
});

describe("the gates", () => {
  it("stays silent on a car's laps 1 and 2 and speaks from lap 3 (the grace)", () => {
    fire(record({ position: 1, lap: 1 }));
    fire(record({ position: 1, lap: 2 }));
    expect(line()).toEqual([]);

    fire(record({ position: 1, lap: 3 }));
    expect(line()[0]).toBe("fastest-lap/leader");
  });

  it("is refused at arrival under a full-course caution and after the player's finish", () => {
    underCaution = true;
    fire(record({ position: 1 }));
    underCaution = false;
    raceFinished = true;
    fire(record({ position: 1 }));
    expect(line()).toEqual([]);

    raceFinished = false;
    fire(record({ position: 1 }));
    expect(line()[0]).toBe("fastest-lap/leader");
  });

  it("is silent with its opt-in off, and #555 speaks the player's lap instead", () => {
    fastestLapEnabled = false;
    latestLap = bestLap({ isClassFastestLapOfRace: true });
    bus.publishEvent("lap.completed", latestLap);
    bus.publishEvent("fastestLap.set", record({ isPlayer: true, carIdx: 0 }));
    flush();

    expect(line()).toEqual([
      "lap-time-intro/best-lap-yet",
      "lap-time-minute/1",
      "lap-time-second/23",
      "lap-time-decimal/4",
    ]);
  });

  it("with its opt-in on speaks the player's lap alone — no best-lap line (the positive control)", () => {
    latestLap = bestLap({ isClassFastestLapOfRace: true });
    bus.publishEvent("lap.completed", latestLap);
    bus.publishEvent("fastestLap.set", record({ isPlayer: true, carIdx: 0 }));
    flush();

    expect(line()).toEqual(["fastest-lap/yours", ...TIME]);
  });

  it("hands the player's lap in the grace to #555", () => {
    latestLap = bestLap({ lap: 2, isClassFastestLapOfRace: true });
    bus.publishEvent("lap.completed", latestLap);
    bus.publishEvent("fastestLap.set", record({ isPlayer: true, carIdx: 0, lap: 2, playerLapsCompleted: 2 }));
    flush();

    expect(line()[0]).toBe("lap-time-intro/best-lap-yet");
    expect(line()).not.toContain("fastest-lap/yours");
  });
});

describe("waiting for the radio", () => {
  /** Put a best-lap line (NORMAL weight, family lap-time) on the bus, so a fastest-lap fire queues behind it. */
  function busyWithBestLap(lap = 5): void {
    latestLap = bestLap({ lap });
    bus.publishEvent("lap.completed", latestLap);
  }

  it("is dropped at the speak gate when a caution comes out while it waits", () => {
    busyWithBestLap();
    bus.publishEvent("fastestLap.set", record({ position: 1 }));
    underCaution = true;
    flush();

    expect(line()).not.toContain("fastest-lap/leader");
  });

  it("speaks after the line in flight when nothing changed (the positive control)", () => {
    busyWithBestLap();
    bus.publishEvent("fastestLap.set", record({ position: 1 }));
    flush();

    expect(line()[0]).toBe("lap-time-intro/best-lap-yet");
    expect(line()).toContain("fastest-lap/leader");
  });

  it("is dropped once the player completes a lap past playerLapsCompleted", () => {
    busyWithBestLap(5);
    bus.publishEvent("fastestLap.set", record({ position: 1, playerLapsCompleted: 5 }));
    latestLap = bestLap({ lap: 6, isBest: false });
    flush();

    expect(line()).not.toContain("fastest-lap/leader");
  });

  it("is admitted by a lap.completed equal to playerLapsCompleted — the one trailing the crossing", () => {
    // The record fell after the crossing; the lap.completed for that same lap
    // arrives late (the standings wait) and must not drop it.
    busyWithBestLap(4);
    bus.publishEvent("fastestLap.set", record({ position: 1, playerLapsCompleted: 5 }));
    latestLap = bestLap({ lap: 5, isBest: false });
    flush();

    expect(line()).toContain("fastest-lap/leader");
  });

  it("two waiting fires leave only the newer", () => {
    busyWithBestLap();
    bus.publishEvent("fastestLap.set", record({ carIdx: 3, carNumber: "5", position: 6 }));
    bus.publishEvent("fastestLap.set", record({ carIdx: 7, carNumber: "7", position: 8, lapTime: 82.1 }));
    flush();

    expect(line()).toContain("car-number/7");
    expect(line()).not.toContain("car-number/5");
  });

  it("a newer record replaces the line about the old one in flight", () => {
    bus.publishEvent("fastestLap.set", record({ carIdx: 3, carNumber: "5", position: 6 }));
    // The old line has started: its first voice clip is out.
    audio.end(AudioChannel.SFX);
    expect(line()).toEqual(["car-number/5"]);

    bus.publishEvent("fastestLap.set", record({ carIdx: 7, carNumber: "7", position: 8, lapTime: 82.1 }));
    flush();

    expect(line()).toContain("car-number/7");
    expect(line()).toContain("lap-time-compact-second/22");
    expect(line()).not.toContain("lap-time-compact-second/23");
  });
});

describe("the contract", () => {
  const NO_SIM = {
    getRaceFinishedFired: () => false,
    getUnderFullCourseCaution: () => false,
    getLapCompletedSnapshot: () => null,
    getCarLivePosition: () => null,
    getLivePosition: () => null,
    getLiveGaps: () => null,
  };

  it("carries the scheduling decision 8 sets", () => {
    const [c] = buildFastestLap(NO_SIM).contracts;

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.fastest-lap-race");
    expect(c.when?.event).toBe("fastestLap.set");
    expect(c.weight ?? WEIGHT.NORMAL).toBe(WEIGHT.NORMAL);
    expect(c.interrupt).toBe(false);
    expect(c.queueable).toBe(true);
    expect(c.family).toBe("fastest-lap");
    expect(c.supersedeGroup).toBe("fastest-lap");
    expect(c.maxQueueWaitMs).toBe(30_000);
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.speakGate?.description.length ?? 0).toBeGreaterThan(0);
  });

  it("maps its one scenario to the registry's one callout", () => {
    expect(FASTEST_LAP_SCENARIO_IDS).toEqual(["pit-crew.fastest-lap-race"]);
    expect(SCENARIO_ID_TO_FASTEST_LAP_ID).toEqual({ "pit-crew.fastest-lap-race": "fastest-lap" });
    expect(Object.keys(FASTEST_LAP_CALLOUTS.callouts)).toEqual(["fastest-lap"]);
    expect(Object.keys(LAP_TIME_CALLOUTS.callouts)).toEqual(["best-lap", "every-lap"]);
  });

  it("resolveFastestLapHolder ranks the keys yours, taken-from-you, leader, ahead, behind, other", () => {
    const at = (car: number | null, player: number | null) => ({ car, player });

    expect(resolveFastestLapHolder(record({ isPlayer: true }), at(1, 1))).toBe("yours");
    expect(resolveFastestLapHolder(record({ previous: { carIdx: 0, lapTime: 90, isPlayer: true } }), at(1, 2))).toBe(
      "taken-from-you",
    );
    expect(resolveFastestLapHolder(record(), at(1, 2))).toBe("leader");
    expect(resolveFastestLapHolder(record(), at(3, 4))).toBe("ahead");
    expect(resolveFastestLapHolder(record(), at(5, 4))).toBe("behind");
    expect(resolveFastestLapHolder(record(), at(6, 4))).toBe("other");
    expect(resolveFastestLapHolder(record(), at(null, null))).toBe("other");
  });
});

describe("the vocabulary", () => {
  it("publishes every name decision 4 lists, each described, with the holder's keys declared", () => {
    const { vars, conds, cases } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("fastestLap.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "fastestLap.carNumber",
      "fastestLap.decimal",
      "fastestLap.gapDecimal",
      "fastestLap.gapIntro",
      "fastestLap.gapSecond",
      "fastestLap.minute",
      "fastestLap.position",
      "fastestLap.previousCarNumber",
      "fastestLap.second",
    ]);
    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["fastestLap.hasMinuteComponent"]);

    const holder = cases.find((c) => c.name === "fastestLap.holder");

    expect(holder).toBeDefined();
    expect(Object.keys(holder?.keys ?? {})).toEqual(Object.keys(FASTEST_LAP_HOLDER_KEYS));
    expect(Object.keys(FASTEST_LAP_HOLDER_KEYS)).toEqual([
      "yours",
      "taken-from-you",
      "leader",
      "ahead",
      "behind",
      "other",
    ]);

    for (const entry of [...vars, ...conds, ...cases].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("compiles the spec's entry with nothing skipped", () => {
    expect(mockLogger.warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("fastest-lap"))).toEqual([]);
  });

  it("lists as clip sources exactly the fastest-lap bases both voices' entries address", () => {
    const refs = (entry: CalloutScriptEntry) =>
      collectScriptReferences({ ...SCRIPT, scenarios: { id: entry }, fragments: {}, frames: {} }).pools;
    const addressed = [...new Set([...refs(DEFAULT_ENTRY), ...refs(SHORT_CALLS_ENTRY)])].sort();

    expect(FASTEST_LAP_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(addressed);
  });
});
