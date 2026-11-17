/**
 * One lap, one lap time (issues #1163, #1571, #1688): over the real
 * `registerPitCrew` and both first-party scripts, a lap and its
 * `fastestLap.set` make exactly the owner's lap-time contract speak — at
 * most one of the three — for every combination of the lap, the three
 * opt-ins and whether the voice scripts each contract, and whichever speaks
 * reads the lap to the thousandth, rounded the same way.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import shawnScript from "@iracedeck/audio-assets/voice/shawn/callouts.json" with { type: "json" };
import { AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio } from "@iracedeck/audio-service/testing";
import type { CalloutScript, CalloutScriptEntry } from "@iracedeck/callout-script";
import { calloutKey, FASTEST_LAP_CALLOUTS, LAP_TIME_CALLOUTS } from "@iracedeck/callout-settings";
import type { CountedLapCompleted, IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { classifySession } from "@iracedeck/sim-events-iracing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { type LapOwnerFlags, playerLapOwner } from "./lap-announcement.js";
import type { LapCompletedSnapshot } from "./lap-time.js";
import { _resetLimiterCueEngine } from "./limiter-cue-engine.js";
import { _resetPitExitCueEngine } from "./pit-exit-cue-engine.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

/** Every lap below is a 1:23.456, the time all three calls must read alike. */
function lap(overrides: Partial<CountedLapCompleted> = {}): LapCompletedSnapshot {
  return { lap: 5, lapTime: 83.456, isBest: false, isFirstValid: false, sessionType: "race", ...overrides };
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

const LAP_TIME_IDS = ["pit-crew.fastest-lap-race", "pit-crew.lap-time-best", "pit-crew.lap-time-last"] as const;

/**
 * The clips the 1:23.456 lap needs in the three lines, per voice, beside the
 * bundled manifest (which carries them too; staged here so the test does not
 * lean on what the bundled manifest happens to hold): the player's fastest-lap
 * line, the two intros, the clock phrase 1m23 and the thousandths 456.
 */
function extraClips(voice: string): string[] {
  return [
    "fastest-lap/yours-01",
    "lap-time-intro/best-lap-yet",
    "lap-time-last/intro-01",
    "lap-time-clock/1m23",
    "lap-time-thousandths/456",
  ].map((c) => `voice/${voice}/${c}.mp3`);
}

/** The time each line ends on, one rounding for all three (#1688). */
const TIME = ["lap-time-clock/1m23", "lap-time-thousandths/456"];

/** What each owner's line plays for the lap, as `<group>/<base>`, take suffix dropped. */
const EXPANSION: Readonly<Record<(typeof LAP_TIME_IDS)[number], readonly string[]>> = {
  "pit-crew.fastest-lap-race": ["fastest-lap/yours", ...TIME],
  "pit-crew.lap-time-best": ["lap-time-intro/best-lap-yet", ...TIME],
  "pit-crew.lap-time-last": ["lap-time-last/intro", ...TIME],
};

const BUNDLED = manifestJson as AudioAssetsManifest;

const VOICES: ReadonlyArray<{ voice: string; script: CalloutScript }> = [
  { voice: "default", script: defaultScript as CalloutScript },
  { voice: "shawn", script: shawnScript as CalloutScript },
];

/** The voice's script minus the ids `unscripted` names. */
function scriptFor(base: CalloutScript, unscripted: ReadonlySet<string>): CalloutScript {
  const scenarios: Record<string, CalloutScriptEntry> = { ...base.scenarios };

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
          getSessionClass: () => classifySession("Race"),
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
        _resetPitExitCueEngine();
        _resetLimiterCueEngine();
        vi.useRealTimers();
      });

      /** Which of the three lap-time contracts started playing since the last clear. */
      function played(): string[] {
        return mockLogger.info.mock.calls
          .map(([m]) => String(m))
          .map((m) => /^Playing scenario "([^"]+)"$/.exec(m)?.[1])
          .filter((id): id is string => id !== undefined && (LAP_TIME_IDS as readonly string[]).includes(id));
      }

      /**
       * The voice clips the lap-time lines played since the last clear, as
       * `<group>/<base>` with a take suffix dropped — only the groups the
       * three lines draw from, so another callout on the same lap stays out.
       */
      function lapTimeClips(): string[] {
        return audio._played
          .filter((p) => p.channel === AudioChannel.Voice)
          .map((p) =>
            p.path
              .split(`voice/${voice}/`)[1]
              .replace(/\.mp3$/, "")
              .replace(/-\d\d$/, ""),
          )
          .filter((c) => /^(fastest-lap|lap-time-[a-z]+)\//.test(c));
      }

      function flush(): void {
        for (let i = 0; i < 80; i++) {
          audio._triggerChannelEnd(AudioChannel.Voice);
          audio._triggerChannelEnd(AudioChannel.SFX);
          audio._triggerChannelEnd(AudioChannel.Ambient);
          vi.advanceTimersByTime(1000);
        }
      }

      it("scripts all three lap-time contracts, so every combination below runs the bundled entries", () => {
        for (const id of LAP_TIME_IDS) expect(script.scenarios[id], id).toBeDefined();
      });

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
              audio._played.length = 0;
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
              const expected: Array<(typeof LAP_TIME_IDS)[number]> =
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
              // …and the line it spoke reads the lap to the thousandth (#1688).
              expect(lapTimeClips(), label).toEqual(expected.length === 0 ? [] : EXPANSION[expected[0]]);
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
