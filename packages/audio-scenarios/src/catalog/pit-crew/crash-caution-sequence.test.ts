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
 * held the bus at the crash is not in the log; the replay puts a `WEIGHT.SAFETY`
 * line there, ending before the caution flag — the log has the caution call
 * playing the moment it was raised, so the bus was free by then. The follow
 * call is switched off because the log has none.
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
          channel === AudioChannel.SFX ? SFX_CLIP_MS : VOICE_CLIP_MS,
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

describe("the #1288 crash replayed through the engine (issues #1211, #1288)", () => {
  it("the incident line is heard; the damage line and two caution calls are displaced from the one pending slot while it plays (#1185)", () => {
    // A SAFETY line holds the bus at the crash and ends 1 s later.
    getScenarioEngine().defineScenario({
      id: "test.safety-line",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.SAFETY,
      sequence: [`voice/${VOICE}/flags/caution-waving-01.mp3`],
    });
    getScenarioEngine().fire("test.safety-line");
    vi.advanceTimersByTime(VOICE_CLIP_MS - 1000);

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

    vi.advanceTimersByTime(30_000);

    // What is heard, in order. The incident line, parked behind the SAFETY
    // line, plays the moment it ends (+1 s) and runs past +4.1 s. The caution
    // flag (+1.8 s) waits in the bus's ONE pending slot. The damage line
    // (+3.9 s, `WEIGHT.NORMAL`) and the lineup change (+4.0 s, one notch
    // below `WEIGHT.SAFETY` since #1286, so it never evicts a waiting caution
    // call) meet it there and are dropped; the pace car (+4.1 s, equal weight)
    // then replaces it. That is #1185's single slot, not something this
    // family can fix by itself.
    //
    // The outcome turns on what held the bus, which the log does not say.
    // Had the SAFETY line still been playing at +1.8 s, the caution flag
    // would have taken the incident line's slot instead (the incident line
    // lost, the other four heard); had it been a `family: "flag"` line, which
    // the caution flag cuts, all five would have been heard.
    expect(heard()).toEqual(["test.safety-line", "pit-crew.incident-collision-car", "pit-crew.caution-pace-car-out"]);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Scenario "pit-crew.damage-repair-needed" dropped — lower weight than queued "pit-crew.flag-caution-waving"',
    );
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Scenario "pit-crew.caution-lineup-changed" dropped — lower weight than queued "pit-crew.flag-caution-waving"',
    );
  });
});
