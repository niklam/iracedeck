/**
 * One lap, one lap time (issues #1163, #1571): over the real
 * `registerPitCrew` and both first-party scripts, a lap and its
 * `fastestLap.set` make exactly the owner's lap-time contract speak — at
 * most one of the three — for every combination of the lap, the three
 * opt-ins and whether the voice scripts each contract.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import shawnScript from "@iracedeck/audio-assets/voice/shawn/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript, CalloutScriptEntry } from "@iracedeck/callout-script";
import { calloutKey, FASTEST_LAP_CALLOUTS, LAP_TIME_CALLOUTS } from "@iracedeck/callout-settings";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { type LapOwnerFlags, playerLapOwner } from "./lap-announcement.js";
import type { LapCompletedSnapshot } from "./lap-time.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

function lap(overrides: Partial<LapCompletedSnapshot> = {}): LapCompletedSnapshot {
  return { lap: 5, lapTime: 83.4, isBest: false, isFirstValid: false, sessionType: "race", ...overrides };
}

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

function createFakeAudio(): IAudioService & { end: (channel: AudioChannel) => void } {
  const callbacks = new Map<AudioChannel, () => void>();

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn(() => true),
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
  } as unknown as IAudioService & { end: (channel: AudioChannel) => void };
}

const LAP_TIME_IDS = ["pit-crew.fastest-lap-race", "pit-crew.lap-time-best", "pit-crew.lap-time-last"] as const;

/**
 * Entries for the two new contracts, used only where a first-party script
 * does not carry its own yet (their bundled entries are authored with their
 * clips). A bundled entry, once there, is what runs.
 */
const FALLBACK_ENTRIES: Record<string, CalloutScriptEntry> = {
  "pit-crew.fastest-lap-race": {
    comment: "Fastest lap.",
    test: "Harness → Fastest Lap → Yours.",
    sequence: [
      { case: "fastestLap.holder", of: { yours: ["pool:fastest-lap/yours"], default: ["pool:fastest-lap/other"] } },
      { if: "fastestLap.hasMinuteComponent", then: ["{{fastestLap.minute}}"] },
      "{{fastestLap.second}}",
      "{{fastestLap.decimal}}",
    ],
  },
  "pit-crew.lap-time-last": {
    comment: "Every lap.",
    test: "Harness → Lap Time → Every lap.",
    sequence: [
      "pool:lap-time-last/intro",
      { if: "lapTime.compactHasMinute", then: ["{{lapTime.compactMinute}}"] },
      "{{lapTime.compactSecond}}",
      "{{lapTime.compactThousandthFirst}}",
      "{{lapTime.compactThousandthMiddle}}",
      "{{lapTime.compactThousandthLast}}",
    ],
  },
};

/** The clips the 1:23.4 lap needs in both readouts, per voice, beside the bundled manifest. */
function extraClips(voice: string): string[] {
  return [
    "fastest-lap/yours-01",
    "fastest-lap/other-01",
    "lap-time-last/intro-01",
    "lap-time-compact-minute/1-twenty",
    "lap-time-compact-second/23",
    "lap-time-compact-tenth/4",
    "lap-time-compact-thousandth-first/4",
    "lap-time-compact-thousandth-middle/0",
    "lap-time-compact-thousandth-last/0",
  ].map((c) => `voice/${voice}/${c}.mp3`);
}

const BUNDLED = manifestJson as AudioAssetsManifest;

const VOICES: ReadonlyArray<{ voice: string; script: CalloutScript }> = [
  { voice: "default", script: defaultScript as CalloutScript },
  { voice: "shawn", script: shawnScript as CalloutScript },
];

/** The voice's script with the two new entries filled in where absent, minus the ids `unscripted` names. */
function scriptFor(base: CalloutScript, unscripted: ReadonlySet<string>): CalloutScript {
  const scenarios: Record<string, CalloutScriptEntry> = { ...base.scenarios };

  for (const [id, entry] of Object.entries(FALLBACK_ENTRIES)) scenarios[id] ??= entry;

  for (const id of unscripted) delete scenarios[id];

  return { ...base, scenarios };
}

describe("one lap, one lap time — the real registerPitCrew over both first-party scripts (#1163, #1571)", () => {
  for (const { voice, script } of VOICES) {
    describe(`voice "${voice}"`, () => {
      let bus: ReturnType<typeof createMockBus>;
      let audio: ReturnType<typeof createFakeAudio>;
      let latest: LapCompletedSnapshot | null = null;
      const enabled = new Map<string, boolean>();

      beforeAll(() => {
        vi.useFakeTimers();
        bus = createMockBus();
        audio = createFakeAudio();
        initializeAudioScenarios(
          bus,
          audio,
          { ...BUNDLED, clips: [...BUNDLED.clips, ...extraClips(voice)] },
          mockLogger as never,
          () => voice,
        );
        registerPitCrew(bus, {
          logger: mockLogger as never,
          getSessionType: () => "Race",
          isCalloutEnabled: (key) => enabled.get(key) ?? true,
          getLapCompletedSnapshot: () => latest,
        });
      });

      afterEach(() => {
        mockLogger.info.mockClear();
      });

      afterAll(() => {
        _resetAudioScenarios();
        _resetRadarEngine();
        _resetSpotterEngine();
        _resetPitSpeedingEngine();
        vi.useRealTimers();
      });

      /** Which of the three lap-time contracts started playing since the last clear. */
      function played(): string[] {
        return mockLogger.info.mock.calls
          .map(([m]) => String(m))
          .map((m) => /^Playing scenario "([^"]+)"$/.exec(m)?.[1])
          .filter((id): id is string => id !== undefined && (LAP_TIME_IDS as readonly string[]).includes(id));
      }

      function flush(): void {
        for (let i = 0; i < 80; i++) {
          audio.end(AudioChannel.Voice);
          audio.end(AudioChannel.SFX);
          audio.end(AudioChannel.Ambient);
          vi.advanceTimersByTime(1000);
        }
      }

      it("speaks exactly the owner's line for every combination of the lap, the three opt-ins and the three script entries — and nothing only when no tier can speak", () => {
        const shapes: ReadonlyArray<{ name: string; data: LapCompletedSnapshot; fastest: boolean }> = [
          {
            name: "fastest past the grace",
            data: lap({ lap: 5, isBest: true, isClassFastestLapOfRace: true }),
            fastest: true,
          },
          {
            name: "fastest in the grace",
            data: lap({ lap: 2, isBest: true, isClassFastestLapOfRace: true }),
            fastest: true,
          },
          { name: "best past the grace", data: lap({ lap: 5, isBest: true }), fastest: false },
          { name: "best in the grace", data: lap({ lap: 2, isBest: true }), fastest: false },
          { name: "plain past the grace", data: lap({ lap: 5 }), fastest: false },
          { name: "plain in the grace", data: lap({ lap: 2 }), fastest: false },
        ];
        let checked = 0;

        for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
          const unscripted = new Set(LAP_TIME_IDS.filter((_, i) => (mask & (1 << i)) !== 0));

          getScenarioEngine().setScripts(new Map([[voice, scriptFor(script, unscripted)]]));

          for (const onMask of [0, 1, 2, 3, 4, 5, 6, 7]) {
            const on = { fastestLap: (onMask & 1) !== 0, bestLap: (onMask & 2) !== 0, everyLap: (onMask & 4) !== 0 };

            enabled.set(calloutKey(FASTEST_LAP_CALLOUTS, "fastest-lap"), on.fastestLap);
            enabled.set(calloutKey(LAP_TIME_CALLOUTS, "best-lap"), on.bestLap);
            enabled.set(calloutKey(LAP_TIME_CALLOUTS, "every-lap"), on.everyLap);

            const tiers: LapOwnerFlags = {
              fastestLap: on.fastestLap && !unscripted.has("pit-crew.fastest-lap-race"),
              bestLap: on.bestLap && !unscripted.has("pit-crew.lap-time-best"),
              everyLap: on.everyLap && !unscripted.has("pit-crew.lap-time-last"),
            };

            for (const shape of shapes) {
              mockLogger.info.mockClear();
              latest = shape.data;
              bus.publishEvent("lap.completed", shape.data);

              if (shape.fastest) {
                bus.publishEvent("fastestLap.set", {
                  carIdx: 0,
                  isPlayer: true,
                  lap: shape.data.lap,
                  lapTime: shape.data.lapTime,
                  playerLapsCompleted: shape.data.lap,
                  position: 1,
                  playerPosition: 1,
                });
              }

              flush();

              const owner = playerLapOwner(shape.data, tiers);
              const expected =
                owner === "fastest-lap"
                  ? ["pit-crew.fastest-lap-race"]
                  : owner === "best-lap"
                    ? ["pit-crew.lap-time-best"]
                    : owner === "every-lap"
                      ? ["pit-crew.lap-time-last"]
                      : [];
              const label = JSON.stringify({ voice, shape: shape.name, on, unscripted: [...unscripted] });

              expect(played(), label).toEqual(expected);
              expect(played().length, label).toBeLessThanOrEqual(1);
              checked++;
            }
          }
        }

        // 8 script masks × 8 opt-in masks × 6 laps.
        expect(checked).toBe(384);
      });
    });
  }
});
