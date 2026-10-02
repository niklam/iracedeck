/**
 * The #1288 log replayed through the engine (issues #1211, #1288): a crash
 * whose incident and damage lines meet the caution calls it brings out.
 *
 * ```text
 * 01:24:55.227Z Incident flush: type=collision-car points=4 delta=4 chain=4
 * 01:24:55.229Z Scenario "pit-crew.incident-collision-car" dropped (bus busy)
 * 01:24:57.006Z Playing scenario "pit-crew.flag-caution-waving"
 * 01:24:58.774Z Playing scenario "pit-crew.caution-lineup-changed"
 * 01:24:59.101Z Scenario "pit-crew.damage-repair-needed" dropped (bus busy)
 * 01:24:59.290Z Playing scenario "pit-crew.caution-pace-car-out"
 * ```
 *
 * Every pit-crew contract is registered as a plugin registers them, against
 * the bundled voice's real script and manifest, and the clips end on a timer
 * rather than by hand, so the lines overlap as they would on the radio. What
 * held the bus at the crash is not in the log, so the replay runs the three
 * holders measured during #1211: a `WEIGHT.SAFETY` line ending before the
 * caution flag (the log has the caution call playing the moment it was
 * raised, so the bus was free by then), the same line still playing when the
 * flag comes, and a `family: "flag"` line the caution flag cuts. The follow
 * call is switched off because the log has none.
 *
 * Under the engine's one pending slot each of these lost something: the
 * caution calls replaced each other in the slot and pushed out the damage
 * line, and with the holder still playing the incident line too. Under the
 * bus's queue (issue #1185) nothing is replaced or crowded out: all five
 * lines are heard in all three variants.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { SessionState } from "@iracedeck/iracing-sdk";
import type { CautionLineup } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { _resetLastIncidentPoints } from "./incidents.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { resetQualifyingInvalidationLatch } from "./qualifying-invalidation.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

// The translator's live readers are stubbed: a race, a rolling start, no
// latest tick, and a repair still needed when the damage line comes to speak.
vi.mock("@iracedeck/sim-events-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/sim-events-iracing")>()),
  getSessionType: () => "Race",
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
  isDamageRepairNeeded: () => true,
}));

const VOICE = "default";
const SCRIPT = defaultScript as CalloutScript;
const MANIFEST = manifestJson as AudioAssetsManifest;

/** Live in the car, racing — what the caution contracts' shared gate needs. */
const IN_CAR = { IsOnTrack: true, IsReplayPlaying: false, SessionState: SessionState.Racing };

const LINEUP: CautionLineup = {
  followCarIdx: 7,
  followCarNumber: "9",
  line: "inside",
  isLeader: false,
  followsPaceCar: false,
  doubleFile: true,
  restartPosition: 14,
};

/**
 * Clip lengths, near the bundled voice's: its lines run 1.1 s to 4.4 s (the
 * collision-car line 1.4–1.9 s, "four points" 1.75 s, the caution call
 * 2.1–3.2 s), its radio ticks 0.29 s. One length per channel keeps a pool
 * draw from changing the timeline.
 */
const VOICE_CLIP_MS = 2000;
const SFX_CLIP_MS = 290;

/** The Voice clip length the timed audio uses; one test lengthens it. */
let voiceClipMs = VOICE_CLIP_MS;

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

/** An audio service whose clips end on the (fake) clock, after their length. */
function createTimedAudio(): IAudioService {
  const callbacks = new Map<AudioChannel, () => void>();
  const timers = new Map<AudioChannel, ReturnType<typeof setTimeout>>();

  const stop = (channel: AudioChannel): void => {
    clearTimeout(timers.get(channel));
    timers.delete(channel);
    callbacks.delete(channel);
  };

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, _path: string) => {
      clearTimeout(timers.get(channel));
      timers.set(
        channel,
        setTimeout(
          () => {
            const cb = callbacks.get(channel);

            timers.delete(channel);
            callbacks.delete(channel);
            cb?.();
          },
          channel === AudioChannel.SFX ? SFX_CLIP_MS : voiceClipMs,
        ),
      );

      return true;
    }),
    stopChannel: vi.fn(stop),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks.set(channel, cb);
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
  } as unknown as IAudioService;
}

let bus: IEventBus;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  voiceClipMs = VOICE_CLIP_MS;
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _resetLastIncidentPoints();
  resetQualifyingInvalidationLatch();
  bus = createMockBus();
  initializeAudioScenarios(bus, createTimedAudio(), MANIFEST, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getCautionPhase: () => "waving",
    getCautionLineup: () => LINEUP,
    getUnderFullCourseCaution: () => true,
    getCautionCalloutEnabled: (id) => id !== "follow",
  });
  getScenarioEngine().setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetLastIncidentPoints();
  vi.useRealTimers();
});

function publish(event: SimEventName, data: Record<string, unknown>): void {
  bus.publish({ event, timestamp: Date.now(), telemetry: IN_CAR, data } as unknown as SimEventOf<SimEventName>);
}

/** The scenarios that started playing, in order — what the driver heard begin. */
function heard(): string[] {
  return mockLogger.info.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.startsWith("Playing scenario"))
    .map((message) => message.slice('Playing scenario "'.length, -1));
}

/** What held the Voice bus when the crash was reported — the log does not say. */
type Holder = {
  what: string;
  /** How long before the crash the holder started. */
  leadMs: number;
  family?: string;
};

/**
 * Replay the log from the crash: the holder, the flush tick, the caution flag
 * at +1.8 s, the damage edge at +3.9 s, the lineup change deciding at +4.0 s
 * and the pace car at +4.1 s, then let everything play out.
 */
function replayCrash(holder: Holder): void {
  getScenarioEngine().defineScenario({
    id: "test.holder",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    weight: WEIGHT.SAFETY,
    family: holder.family,
    sequence: [`voice/${VOICE}/flags/caution-waving-01.mp3`],
  });
  getScenarioEngine().fire("test.holder");
  vi.advanceTimersByTime(holder.leadMs);

  // 01:24:55.227 — the flush tick: both events share one timestamp.
  publish("incident.scored", { delta: 4 });
  publish("incident.occurred", { delta: 4, points: 4, type: "collision-car" });

  // +1.8 s — the caution flag.
  vi.advanceTimersByTime(1800);
  publish("flag.caution-waving.raised", {});

  // The lineup change decides 2 s after its event, so it fires at +4.0 s.
  vi.advanceTimersByTime(200);
  publish("caution.lineup.changed", {});

  // +3.9 s — the damage edge.
  vi.advanceTimersByTime(1900);
  publish("damage.repairNeeded.raised", {});

  // +4.1 s — the pace car.
  vi.advanceTimersByTime(200);
  publish("paceCar.deployed", {});

  vi.advanceTimersByTime(60_000);
}

/** Every drop the queue logged — superseded, full, expired, cleared. */
function queueDrops(): string[] {
  return mockLogger.debug.mock.calls
    .map(([message]) => String(message))
    .filter((message) => / dropped — /.test(message));
}

const INCIDENT = "pit-crew.incident-collision-car";
const DAMAGE = "pit-crew.damage-repair-needed";
const CAUTION_WAVING = "pit-crew.flag-caution-waving";
const LINEUP_CHANGED = "pit-crew.caution-lineup-changed";
const PACE_CAR_OUT = "pit-crew.caution-pace-car-out";

describe("the #1288 crash replayed through the engine (issues #1211, #1288, #1185)", () => {
  it("holder ends before the caution flag: the incident line plays at once, then the three caution calls, then the damage line", () => {
    replayCrash({ what: "a SAFETY line ending before the caution flag", leadMs: VOICE_CLIP_MS - 1000 });

    // The incident line, parked behind the holder, takes the bus the moment
    // it ends and is playing — two clips — when the caution calls arrive.
    // They wait in the bus's queue in arrival order (one weight), the damage
    // line (NORMAL) behind them, and nothing replaces anything. The pace-car
    // call, queued at +4.1 s, starts only after the incident line, the
    // caution flag and the two-clip lineup line — past the engine's 8 s
    // default, inside the caution calls' 20 s (`CAUTION_MAX_QUEUE_WAIT_MS`).
    expect(heard()).toEqual(["test.holder", INCIDENT, CAUTION_WAVING, LINEUP_CHANGED, PACE_CAR_OUT, DAMAGE]);
    expect(queueDrops()).toEqual([]);
  });

  it("holder still playing at the caution flag: the SAFETY calls first, then the incident line, then the damage line behind it", () => {
    replayCrash({ what: "a SAFETY line still playing at +1.8 s", leadMs: 0 });

    // The incident line is still waiting when the caution calls arrive. The
    // caution flag takes the bus when the holder ends; the lineup change and
    // the pace car each cut the call before them as they arrive (one
    // `family: "flag"`, which acts on the PLAYING line), so the three start
    // in turn and the burst is short. Then the incident line, about seven
    // seconds after the crash — inside even the engine's 8 s default — and
    // the damage line right behind it (`queueBehind`).
    expect(heard()).toEqual(["test.holder", CAUTION_WAVING, LINEUP_CHANGED, PACE_CAR_OUT, INCIDENT, DAMAGE]);
    expect(queueDrops()).toEqual([]);
  });

  it("holder a flag-family line the caution flag cuts: the caution calls first, then the incident line, then the damage line", () => {
    replayCrash({ what: 'a family: "flag" line cut by the caution flag', leadMs: 0, family: "flag" });

    // The caution flag replaces the playing flag-family holder outright and
    // takes the bus; the lineup change and the pace car cut in turn as in
    // the variant above, and the incident line, waiting since the crash,
    // plays after them with the damage line behind it.
    expect(heard()).toEqual(["test.holder", CAUTION_WAVING, LINEUP_CHANGED, PACE_CAR_OUT, INCIDENT, DAMAGE]);
    expect(queueDrops()).toEqual([]);
  });

  it("with clips long enough to hold the incident line past 10 s, it expires and the damage line still plays — the pacing working, not a loss", () => {
    voiceClipMs = 3000;
    replayCrash({ what: "a SAFETY line still playing at +1.8 s", leadMs: 0 });

    // The incident line would now start about 14 s after the crash: past its
    // max wait, so the queue drops it rather than describe a moment long
    // gone. The damage line, which stays true until the repair settles,
    // waits up to 30 s and is heard. (With the longer clips the pace car
    // arrives while the caution flag plays and cuts it by family, so it
    // starts before the lineup change waiting in the queue.)
    expect(heard()).toEqual(["test.holder", CAUTION_WAVING, PACE_CAR_OUT, LINEUP_CHANGED, DAMAGE]);
    expect(queueDrops()).toEqual([
      expect.stringMatching(/^Scenario "pit-crew\.incident-collision-car" dropped — waited \d+ ms \(max 10000 ms\)$/),
    ]);
  });
});
