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
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import {
  buildFastestLap,
  FASTEST_LAP_CLIP_SOURCES,
  FASTEST_LAP_HOLDER_KEYS,
  FASTEST_LAP_LINE_VARS,
  FASTEST_LAP_SCENARIO_IDS,
  type FastestLapData,
  type FastestLapHolder,
  type FastestLapTimedHolder,
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

/** The onset classes each line is cut for: the time's first word. */
const LEAD_CLASSES = ["w", "t", "th", "f", "s", "ei", "n", "e", "z"];

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

/**
 * The default voice's entry, in the shape of revision 5 of the clip contract:
 * each line that leads into the time a var by the time's onset class (#1163),
 * `taken-from-you` one take ending in a pause, then the clock and the tenths
 * as whole phrases.
 */
const DEFAULT_ENTRY: CalloutScriptEntry = {
  comment: "A new fastest lap of the race in our class.",
  test: "Harness → Fastest Lap → Yours.",
  sequence: [
    {
      case: "fastestLap.holder",
      of: {
        yours: ["{{fastestLap.yoursLine}}"],
        "taken-from-you": ["{{fastestLap.carNumber}}", "pool:fastest-lap/taken-from-you", "pause:150"],
        leader: ["{{fastestLap.leaderLine}}"],
        ahead: ["{{fastestLap.aheadLine}}"],
        behind: ["{{fastestLap.behindLine}}"],
        other: [
          "{{fastestLap.carNumber}}",
          "pool:fastest-lap/in",
          "{{fastestLap.position}}",
          "{{fastestLap.otherLine}}",
        ],
      },
    },
    "{{fastestLap.clock}}",
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
        yours: ["{{fastestLap.yoursLine}}"],
        "taken-from-you": ["pool:fastest-lap/lost-to", "{{fastestLap.carNumber}}"],
        leader: ["{{fastestLap.leaderLine}}"],
        ahead: ["{{fastestLap.aheadLine}}"],
        behind: ["{{fastestLap.behindLine}}"],
        other: ["pool:fastest-lap/for", "{{fastestLap.carNumber}}"],
      },
    },
    "{{fastestLap.clock}}",
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
    // Each line by the onset class of the time's first word (#1163), and `in`.
    ...Object.keys(FASTEST_LAP_LINE_VARS).flatMap((line) =>
      LEAD_CLASSES.map((c) => `voice/${VOICE}/fastest-lap/${line}-${c}-01.mp3`),
    ),
    `voice/${VOICE}/fastest-lap/in-01.mp3`,
    `voice/${VOICE}/fastest-lap/taken-from-you-01.mp3`,
    ...["5", "7", "42"].map((n) => `voice/${VOICE}/car-number/${n}.mp3`),
    ...["1", "2", "3", "4", "6", "8"].map((n) => `voice/${VOICE}/position-number/${n}.mp3`),
    // The compact form to the tenth: every clock phrase 1m00–10m59, #555's
    // plain seconds (the gap clause's too), and the tenths in both takes.
    ...Array.from({ length: 10 }, (_, m) => m + 1).flatMap((m) =>
      Array.from({ length: 60 }, (_, ss) => `voice/${VOICE}/lap-time-clock/${m}m${String(ss).padStart(2, "0")}.mp3`),
    ),
    ...Array.from({ length: 60 }, (_, s) => `voice/${VOICE}/lap-time-second/${s}.mp3`),
    ...Array.from({ length: 10 }, (_, d) => `voice/${VOICE}/lap-time-tenths/${d}.mp3`),
    ...Array.from({ length: 10 }, (_, d) => `voice/${VOICE}/lap-time-tenths/${d}-gap.mp3`),
    // The gap clause.
    `voice/${VOICE}/gap/readout-intro-01.mp3`,
    `voice/${VOICE}/lap-time-decimal/2.mp3`,
    // The best-lap readout the precedence and the queue tests use.
    `voice/${VOICE}/lap-time-intro/best-lap-yet.mp3`,
    `voice/${VOICE}/lap-time-minute/1.mp3`,
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

const TIME = ["lap-time-clock/1m23", "lap-time-tenths/4"];

describe("the holder case, from payloads built for each key (live reads unknown)", () => {
  it("yours: the player set it", () => {
    fire(record({ isPlayer: true, carIdx: 0, position: 4, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/yours-w", ...TIME]);
  });

  it("taken-from-you: another car beat the player's record, named by its number, in the one take", () => {
    fire(record({ previous: { carIdx: 0, lapTime: 83.9, isPlayer: true } }));

    expect(line()).toEqual(["car-number/5", "fastest-lap/taken-from-you", ...TIME]);
  });

  it("leader: the car leads", () => {
    fire(record({ position: 1 }));

    expect(line()).toEqual(["fastest-lap/leader-w", ...TIME]);
  });

  it("ahead: the car one place ahead of the player", () => {
    fire(record({ position: 3, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/ahead-w", ...TIME]);
  });

  it("behind: the car one place behind the player", () => {
    fire(record({ position: 5, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/behind-w", ...TIME]);
  });

  it("other: any other car, by number and position", () => {
    fire(record({ position: 6, playerPosition: 4 }));

    expect(line()).toEqual(["car-number/5", "fastest-lap/in", "position-number/6", "fastest-lap/other-w", ...TIME]);
  });

  it("aborts a line that needs the car number when the payload has none — never a half line", () => {
    fire(record({ carNumber: undefined }));

    expect(line()).toEqual([]);
  });

  it("speaks a sub-minute record without a minute (58.1)", () => {
    fire(record({ position: 1, lapTime: 58.1 }));

    expect(line()).toEqual(["fastest-lap/leader-f", "lap-time-second/58", "lap-time-tenths/1"]);
  });
});

describe("the line before the time (#1163)", () => {
  /** A payload that lands on each key, live reads unknown. */
  const FOR: Readonly<Record<FastestLapHolder, Partial<FastestLapData>>> = {
    yours: { isPlayer: true, carIdx: 0, position: 4, playerPosition: 4 },
    "taken-from-you": { previous: { carIdx: 0, lapTime: 999, isPlayer: true } },
    leader: { position: 1 },
    ahead: { position: 3, playerPosition: 4 },
    behind: { position: 5, playerPosition: 4 },
    other: { position: 6, playerPosition: 4 },
  };

  /** The class each time opens with: the minute word from a minute up, the plain seconds word below it. */
  const TIMES: ReadonlyArray<[number, string]> = [
    [83.4, "w"],
    [125.0, "t"],
    [58.0, "f"],
    [245.0, "f"],
    [120.0, "t"],
    [15.2, "f"],
    [0.9, "z"],
    [5.0, "f"],
    [9.9, "n"],
  ];

  it("takes each line's take by the onset class of the time's first word, for every key", () => {
    let checked = 0;

    for (const holder of Object.keys(FASTEST_LAP_LINE_VARS) as FastestLapTimedHolder[]) {
      for (const [lapTime, cls] of TIMES) {
        audio.played.length = 0;
        fire(record({ ...FOR[holder], lapTime }));

        expect(line(), `${holder} ${lapTime}`).toContain(`fastest-lap/${holder}-${cls}`);
        // Only the one take of the line plays (the positive control on the class).
        expect(
          line().filter((c) => c.startsWith(`fastest-lap/${holder}-`)),
          `${holder} ${lapTime}`,
        ).toEqual([`fastest-lap/${holder}-${cls}`]);
        checked++;
      }
    }

    expect(checked).toBe(45);
  });

  it("speaks taken-from-you in its one take whatever the time opens with — the line ends in a pause", () => {
    for (const [lapTime] of TIMES) {
      audio.played.length = 0;
      fire(record({ ...FOR["taken-from-you"], lapTime }));

      expect(
        line().filter((c) => c.startsWith("fastest-lap/")),
        String(lapTime),
      ).toEqual(["fastest-lap/taken-from-you"]);
    }
  });

  it("reads 4:05.0 and 2:00.0 as the clock phrases 4m05 and 2m00", () => {
    fire(record({ position: 1, lapTime: 245.0 }));
    expect(line()).toEqual(["fastest-lap/leader-f", "lap-time-clock/4m05", "lap-time-tenths/0"]);

    audio.played.length = 0;
    fire(record({ position: 1, lapTime: 120.0 }));
    expect(line()).toEqual(["fastest-lap/leader-t", "lap-time-clock/2m00", "lap-time-tenths/0"]);
  });

  it("reads 1:23.44 as 1m23 and point four", () => {
    fire(record({ position: 1, lapTime: 83.44 }));

    expect(line()).toEqual(["fastest-lap/leader-w", "lap-time-clock/1m23", "lap-time-tenths/4"]);
  });

  it("reads 59.96 as the minute it rounds into: 1m00 and point oh, with the w take — 59.94 stays fifty nine", () => {
    fire(record({ position: 1, lapTime: 59.96 }));
    expect(line()).toEqual(["fastest-lap/leader-w", "lap-time-clock/1m00", "lap-time-tenths/0"]);

    audio.played.length = 0;
    fire(record({ position: 1, lapTime: 59.94 }));
    expect(line()).toEqual(["fastest-lap/leader-f", "lap-time-second/59", "lap-time-tenths/9"]);
  });

  it("aborts 10:59.96, which rounds into an eleventh minute no clip covers — 10:59.94 still speaks", () => {
    fire(record({ position: 1, lapTime: 659.96 }));
    expect(line()).toEqual([]);

    fire(record({ position: 1, lapTime: 659.94 }));
    expect(line()).toEqual(["fastest-lap/leader-t", "lap-time-clock/10m59", "lap-time-tenths/9"]);
  });

  it("reads a record under a second as zero point N, leading in with the z take", () => {
    fire(record({ position: 1, lapTime: 0.9 }));

    expect(line()).toEqual(["fastest-lap/leader-z", "lap-time-second/0", "lap-time-tenths/9"]);
  });
});

describe("the precedence of the keys", () => {
  it("the player who is also the leader hears yours", () => {
    fire(record({ isPlayer: true, carIdx: 0, position: 1, playerPosition: 1 }));

    expect(line()[0]).toBe("fastest-lap/yours-w");
  });

  it("a record the leader takes from the player is taken-from-you", () => {
    fire(record({ position: 1, playerPosition: 2, previous: { carIdx: 0, lapTime: 83.9, isPlayer: true } }));

    expect(line().slice(0, 2)).toEqual(["car-number/5", "fastest-lap/taken-from-you"]);
  });

  it("the car ahead that leads is the leader", () => {
    fire(record({ position: 1, playerPosition: 2 }));

    expect(line()[0]).toBe("fastest-lap/leader-w");
  });
});

describe("positions: live wins, the payload's pair is the fallback", () => {
  it("live positions win over the payload's", () => {
    // The payload says other (P6 vs P4); live says the car is right ahead.
    liveCar.set(3, { position: 3, classPosition: 3 });
    livePlayer = { position: 4, classPosition: 4, isMultiClass: false };
    fire(record({ position: 6, playerPosition: 4 }));

    expect(line()[0]).toBe("fastest-lap/ahead-w");
  });

  it("the payload's pair is used when a live read is unknown", () => {
    liveCar.set(3, { position: 3, classPosition: 3 });
    livePlayer = null;
    fire(record({ position: 5, playerPosition: 4 }));

    expect(line()[0]).toBe("fastest-lap/behind-w");
  });

  it("reads class positions in a multi-class payload", () => {
    liveCar.set(3, { position: 8, classPosition: 3 });
    livePlayer = { position: 20, classPosition: 4, isMultiClass: true };
    fire(record({ position: 9, playerPosition: 9, isMultiClass: true }));

    expect(line()[0]).toBe("fastest-lap/ahead-w");
  });

  it("reads overall positions in a single-class payload (the positive control)", () => {
    liveCar.set(3, { position: 8, classPosition: 3 });
    livePlayer = { position: 20, classPosition: 4, isMultiClass: true };
    fire(record({ position: 9, playerPosition: 9 }));

    expect(line().slice(0, 4)).toEqual(["car-number/5", "fastest-lap/in", "position-number/8", "fastest-lap/other-w"]);
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
  /** The time when the gap clause follows it: the tenths in the take that leads into "Gap is". */
  const TIME_INTO_GAP = ["lap-time-clock/1m23", "lap-time-tenths/4-gap"];

  it("plays for ahead when the live neighbour ahead is the fire's car on the same lap under a minute, the tenths in the -gap take", () => {
    liveGaps = gaps("ahead", 3, 1.2);
    fire(record({ position: 3, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/ahead-w", ...TIME_INTO_GAP, ...GAP]);
  });

  it("plays for behind on the behind side, the tenths in the -gap take", () => {
    liveGaps = gaps("behind", 3, 1.2);
    fire(record({ position: 5, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/behind-w", ...TIME_INTO_GAP, ...GAP]);
  });

  it("is left out, the line ending on the plain tenths take, when the neighbour is another car, a lap away, a minute or more away or on the other side", () => {
    const cases: ReadonlyArray<[string, LiveGaps]> = [
      ["wrong car", gaps("ahead", 9, 1.2)],
      ["a lap away", gaps("ahead", 3, 1.2, 1)],
      ["over a minute", gaps("ahead", 3, 61)],
      ["other side", gaps("behind", 3, 1.2)],
    ];

    for (const [label, g] of cases) {
      audio.played.length = 0;
      liveGaps = g;
      fire(record({ position: 3, playerPosition: 4 }));

      expect(line(), label).toEqual(["fastest-lap/ahead-w", ...TIME]);
    }
  });

  it("is left out for behind too when the neighbour behind is another car or a lap away", () => {
    for (const g of [gaps("behind", 9, 1.2), gaps("behind", 3, 1.2, -1)]) {
      audio.played.length = 0;
      liveGaps = g;
      fire(record({ position: 5, playerPosition: 4 }));

      expect(line()).toEqual(["fastest-lap/behind-w", ...TIME]);
    }
  });

  it("is left out, the plain tenths take, with no live gaps at all", () => {
    liveGaps = null;
    fire(record({ position: 3, playerPosition: 4 }));

    expect(line()).toEqual(["fastest-lap/ahead-w", ...TIME]);
  });

  it("never plays for the other keys, even with a matching gap on a side — and the tenths stay the plain take", () => {
    liveGaps = gaps("ahead", 3, 1.2);
    fire(record({ position: 1, playerPosition: 2 }));

    expect(line()).toEqual(["fastest-lap/leader-w", ...TIME]);
  });

  it("takes the -gap tenths exactly when the gap clause resolves, over every gap shape and holder", () => {
    const shapes: ReadonlyArray<LiveGaps | null> = [
      null,
      gaps("ahead", 3, 1.2),
      gaps("behind", 3, 1.2),
      gaps("ahead", 9, 1.2),
      gaps("ahead", 3, 1.2, 1),
      gaps("ahead", 3, 61),
      gaps("behind", 3, 61),
    ];
    const holders: ReadonlyArray<Partial<FastestLapData>> = [
      { position: 3, playerPosition: 4 },
      { position: 5, playerPosition: 4 },
      { position: 1, playerPosition: 2 },
      { position: 6, playerPosition: 4 },
      { isPlayer: true, carIdx: 0, position: 4, playerPosition: 4 },
    ];
    let withGap = 0;
    let withoutGap = 0;

    for (const g of shapes) {
      for (const h of holders) {
        audio.played.length = 0;
        liveGaps = g;
        fire(record(h));

        const label = JSON.stringify({ g, h });
        const clauseSpoke = line().includes("gap/readout-intro");
        const tenths = line().filter((c) => c.startsWith("lap-time-tenths/"));

        expect(tenths, label).toEqual([clauseSpoke ? "lap-time-tenths/4-gap" : "lap-time-tenths/4"]);

        if (clauseSpoke) withGap++;
        else withoutGap++;
      }
    }

    // Both outcomes were reached (the positive control on the sweep).
    expect(withGap).toBe(2);
    expect(withoutGap).toBe(33);
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
    expect(line()[0]).toBe("fastest-lap/leader-w");
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
    expect(line()[0]).toBe("fastest-lap/leader-w");
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

    expect(line()).toEqual(["fastest-lap/yours-w", ...TIME]);
  });

  it("hands the player's lap in the grace to #555", () => {
    latestLap = bestLap({ lap: 2, isClassFastestLapOfRace: true });
    bus.publishEvent("lap.completed", latestLap);
    bus.publishEvent("fastestLap.set", record({ isPlayer: true, carIdx: 0, lap: 2, playerLapsCompleted: 2 }));
    flush();

    expect(line()[0]).toBe("lap-time-intro/best-lap-yet");
    expect(line()).not.toContain("fastest-lap/yours-w");
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

    expect(line()).not.toContain("fastest-lap/leader-w");
  });

  it("speaks after the line in flight when nothing changed (the positive control)", () => {
    busyWithBestLap();
    bus.publishEvent("fastestLap.set", record({ position: 1 }));
    flush();

    expect(line()[0]).toBe("lap-time-intro/best-lap-yet");
    expect(line()).toContain("fastest-lap/leader-w");
  });

  it("is dropped once the player completes a lap past playerLapsCompleted", () => {
    busyWithBestLap(5);
    bus.publishEvent("fastestLap.set", record({ position: 1, playerLapsCompleted: 5 }));
    latestLap = bestLap({ lap: 6, isBest: false });
    flush();

    expect(line()).not.toContain("fastest-lap/leader-w");
  });

  it("is admitted by a lap.completed equal to playerLapsCompleted — the one trailing the crossing", () => {
    // The record fell after the crossing; the lap.completed for that same lap
    // arrives late (the standings wait) and must not drop it.
    busyWithBestLap(4);
    bus.publishEvent("fastestLap.set", record({ position: 1, playerLapsCompleted: 5 }));
    latestLap = bestLap({ lap: 5, isBest: false });
    flush();

    expect(line()).toContain("fastest-lap/leader-w");
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
    expect(line()).toContain("lap-time-clock/1m22");
    expect(line()).not.toContain("lap-time-clock/1m23");
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
      "fastestLap.aheadLine",
      "fastestLap.behindLine",
      "fastestLap.carNumber",
      "fastestLap.clock",
      "fastestLap.decimal",
      "fastestLap.gapDecimal",
      "fastestLap.gapIntro",
      "fastestLap.gapSecond",
      "fastestLap.leaderLine",
      "fastestLap.otherLine",
      "fastestLap.position",
      "fastestLap.previousCarNumber",
      "fastestLap.yoursLine",
    ]);
    expect(Object.values(FASTEST_LAP_LINE_VARS)).toEqual([
      "fastestLap.yoursLine",
      "fastestLap.leaderLine",
      "fastestLap.aheadLine",
      "fastestLap.behindLine",
      "fastestLap.otherLine",
    ]);
    expect(Object.keys(FASTEST_LAP_LINE_VARS)).toEqual(
      Object.keys(FASTEST_LAP_HOLDER_KEYS).filter((k) => k !== "taken-from-you"),
    );

    for (const name of Object.values(FASTEST_LAP_LINE_VARS)) {
      expect(vars.find((v) => v.name === name)?.description, name).toContain("fastest-lap clip group");
    }

    // Each time var names the groups it draws from, which the coverage tooling attributes clips by.
    const description = (name: string) => vars.find((v) => v.name === name)?.description ?? "";

    expect(descriptionNamesGroup(description("fastestLap.clock"), "lap-time-clock")).toBe(true);
    expect(descriptionNamesGroup(description("fastestLap.clock"), "lap-time-second")).toBe(true);
    expect(descriptionNamesGroup(description("fastestLap.decimal"), "lap-time-tenths")).toBe(true);
    // The positive control: a group a var does not draw from is not named.
    expect(descriptionNamesGroup(description("fastestLap.decimal"), "lap-time-clock")).toBe(false);

    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual([]);

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
    expect(addressed).toEqual([
      "fastest-lap/for",
      "fastest-lap/in",
      "fastest-lap/lost-to",
      "fastest-lap/taken-from-you",
    ]);
  });
});
