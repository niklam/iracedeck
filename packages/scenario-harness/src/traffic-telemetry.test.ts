/**
 * The approaching-traffic telemetry (issue #1113) through the real translator
 * on the mock SDK: the rejoin train is heard as every band in turn,
 * and the four pit-exit cases as clear, traffic, traffic, clear at the call
 * point 3 s short of the end of pit road, the −1 s case with the merge warning
 * in the exit lane after it. Every event in the catalog is recorded, so a line the run lets slip
 * from another family cannot hide.
 */
import { TRAFFIC_CONTRACTS } from "@iracedeck/audio-scenarios/pit-crew";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { type SDKController, type SessionInfo, TrkLoc } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  TRAFFIC_PIT_EXIT_CALL_LEAD_S as DETECTOR_CALL_LEAD_S,
  getLatestTelemetry,
  initializeSimEventsIracing,
  type SimEventsIracingOptions,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HARNESS_DEVELOPMENT_FLAGS } from "./development-flags.js";
import { ALL_EVENT_NAMES } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import {
  AT_RACING_SPEED,
  SCENARIO_SHORTCUTS,
  type ScenarioShortcut,
  type TelemetryStep,
} from "./scenario-shortcuts.js";
import {
  TRAFFIC_PIT_EXIT_CALL_LEAD_S,
  TRAFFIC_PIT_EXIT_CASES,
  TRAFFIC_PIT_EXIT_MERGE_ETA_S,
  TRAFFIC_PIT_EXIT_PLAYER_ETA_S,
  TRAFFIC_REJOIN_SEQUENCE,
  TRAFFIC_REJOIN_SEQUENCE_UNLEARNED,
  TRAFFIC_REJOIN_TEARDOWN,
  trafficPitExitLandmarkSection,
  trafficPitExitSequence,
} from "./traffic-telemetry.js";

type Published = { event: string; data: unknown };

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

function readSessionPreset(name: string): SessionInfo {
  return JSON.parse(readFileSync(join(PRESETS_DIR, "session", `${name}.json`), "utf8")) as SessionInfo;
}

type Loader = NonNullable<SimEventsIracingOptions["loadPitLaneLandmarks"]>;

/** The landmark store a plugin would hand the translator, answering the section for any track. */
const LANDMARKS: Loader = () => trafficPitExitLandmarkSection() as unknown as ReturnType<Loader>;

/**
 * A connected mock SDK in the given session preset (from boot telemetry, as a
 * fresh harness), the real translator over it, and every catalog event but
 * `driver.firstOnTrack` (whichever button first puts the car on track emits
 * that one-shot) recorded from the first seeding tick on.
 */
function startTranslator(
  sessionPreset: string,
  options: SimEventsIracingOptions = {},
): { controller: MockSDKController; events: Published[] } {
  const controller = new MockSDKController({ onSubscriberError: "rethrow" });

  controller.setSessionInfo(readSessionPreset(sessionPreset));
  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger, {
    onStepError: "rethrow",
    trafficRejoin: HARNESS_DEVELOPMENT_FLAGS.trafficRejoin,
    ...options,
  });
  controller.tickOnce();

  const events: Published[] = [];

  for (const name of ALL_EVENT_NAMES) {
    if (name === "driver.firstOnTrack") continue;

    getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
  }

  return { controller, events };
}

/** The steps as the UI runs them with the mock's timer going: patch, tick, then tick through the hold. */
function runSequence(controller: MockSDKController, steps: readonly TelemetryStep[]): void {
  const TICK_MS = 14;

  for (const step of steps) {
    controller.mutateTelemetry(step.patch as TelemetryPatch);
    controller.tickOnce();

    for (let elapsed = 0; elapsed < (step.holdMs ?? 0); elapsed += TICK_MS) {
      vi.advanceTimersByTime(TICK_MS);
      controller.tickOnce();
    }
  }
}

/**
 * The steps as the UI runs them with the mock's tick loop paused: the route
 * applies the patch and ticks once for a step marked `tick`, and nothing ticks
 * through the hold, which only lets the wall clock run.
 */
function runSequencePaused(controller: MockSDKController, steps: readonly TelemetryStep[]): void {
  for (const step of steps) {
    controller.mutateTelemetry(step.patch as TelemetryPatch);

    if (step.tick === true) controller.tickOnce();

    vi.advanceTimersByTime(step.holdMs ?? 0);
  }
}

/** A tick loop slowed to 2.5 s (the API takes up to 5 s), past the rejoin detector's one-second evaluation interval. */
const SLOW_TICK_MS = 2500;

/**
 * The steps as the UI runs them with the mock's tick loop slowed to
 * {@link SLOW_TICK_MS}: the route applies the patch and ticks once for a step
 * marked `tick`, and the loop ticks on its own through the holds, its first
 * tick `phaseMs` into the run.
 */
function runSequenceSlowLoop(controller: MockSDKController, steps: readonly TelemetryStep[], phaseMs: number): void {
  controller.start(SLOW_TICK_MS);

  try {
    // Started now, the loop first ticks a whole interval later: run that much
    // short of it.
    vi.advanceTimersByTime(SLOW_TICK_MS - phaseMs);
    runSequencePaused(controller, steps);
  } finally {
    controller.stop();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  initializeEventBus(silentLogger);
});

afterEach(() => {
  _resetSimEventsIracing();
  _resetEventBus();
  vi.useRealTimers();
});

describe("the rejoin train (issue #1113)", () => {
  /** Warnings only (amended 2026-11-20): nothing for a car 10 s or more away, on entry or after the lead car. */
  const BANDS = [
    { verdict: "near", seconds: 8, first: true },
    { verdict: "near", seconds: 5, first: false },
    { verdict: "rightBehind" },
    { verdict: "near", seconds: 6, first: true },
  ].map((data) => ({ event: "traffic.rejoin", data }));

  it.each(["race", "race-oval"])("is heard only for its bands under ten seconds, and nothing else (%s)", (preset) => {
    const { controller, events } = startTranslator(preset);

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual(BANDS);
  });

  it.each(["race", "race-oval"])(
    "is heard only for its bands under ten seconds with the tick loop paused (%s)",
    (preset) => {
      const { controller, events } = startTranslator(preset);

      runSequencePaused(controller, TRAFFIC_REJOIN_SEQUENCE);

      expect(events).toEqual(BANDS);
    },
  );

  // At some phases of a slowed loop a background tick evaluates a snapshot
  // just before the next one lands, throttling that one's own tick; were the
  // run to replace it before the loop ticks again, its band would go unheard.
  // Every phase against the run, in 100 ms steps.
  it.each(Array.from({ length: SLOW_TICK_MS / 100 }, (_, n) => n * 100))(
    "is heard only for its bands under ten seconds with the tick loop slowed to 2.5 s, first ticking %i ms into the run",
    (phaseMs) => {
      const { controller, events } = startTranslator("race");

      runSequenceSlowLoop(controller, TRAFFIC_REJOIN_SEQUENCE, phaseMs);

      expect(events).toEqual(BANDS);
    },
  );

  it("plays the same on a second press", () => {
    const { controller, events } = startTranslator("race");

    // The press as the UI makes it: the run, then the shortcut's teardown.
    runSequence(controller, [...TRAFFIC_REJOIN_SEQUENCE, ...TRAFFIC_REJOIN_TEARDOWN]);
    events.length = 0;
    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual(BANDS);
  });

  it("times the class-B cars by class B's own curve: without the learning lap only the class-A car's close call is heard", () => {
    // Control: the lead and tail cars are class B, and the presets carry no
    // class lap times to scale the player's class by, so with no class-B
    // samples at P both are untimed, and left out: the timed class-A car is
    // heard once it is under ten seconds. The lead car's own near and
    // rightBehind are not heard, being untimed.
    const { controller, events } = startTranslator("race");

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE_UNLEARNED);

    expect(events).toEqual([{ event: "traffic.rejoin", data: { verdict: "near", seconds: 6, first: true } }]);
  });

  it("stays silent with no session preset: no player car, no position", () => {
    const controller = new MockSDKController({ onSubscriberError: "rethrow" });
    const events: Published[] = [];

    controller.setConnected(true);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger, {
      onStepError: "rethrow",
      trafficRejoin: HARNESS_DEVELOPMENT_FLAGS.trafficRejoin,
    });
    getEventBus().subscribe("traffic.rejoin", (ev) => events.push({ event: ev.event, data: ev.data }));

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual([]);
  });
});

describe("the pit-exit cases (issue #1113)", () => {
  it("makes the call 2.46 s short of the end of pit road, inside the 3 s lead, with the player at the blend 6.46 s later", () => {
    expect(TRAFFIC_PIT_EXIT_CALL_LEAD_S).toBeCloseTo(2.46, 6);
    expect(TRAFFIC_PIT_EXIT_CALL_LEAD_S).toBeLessThanOrEqual(DETECTOR_CALL_LEAD_S);
    expect(TRAFFIC_PIT_EXIT_PLAYER_ETA_S).toBeCloseTo(6.46, 6);
  });

  it("checks the merge 10 m into the exit lane, with the player at the blend 3.6 s later", () => {
    expect(TRAFFIC_PIT_EXIT_MERGE_ETA_S).toBeCloseTo(3.6, 6);
  });

  /** The departure, then the call at the call point, still on pit road (amended 2026-11-20, second). */
  const callOf = (verdict: string, relative: number): Published[] => [
    { event: "pitStall.departed", data: {} },
    { event: "traffic.pitExit", data: { verdict, seconds: relative } },
  ];

  /**
   * Over the end of pit road, the pit-lane exit and the limiter switched off,
   * and the merge warning when the car is within the default 1.5 s threshold.
   */
  const intoTheExitLane = (merge: number | null): Published[] => [
    { event: "pitLane.exited", data: {} },
    { event: "carControl.limiterToggled", data: { on: false } },
    ...(merge === null ? [] : [{ event: "traffic.pitExitMerge", data: { seconds: merge } }]),
  ];

  // The window is 2 s before to 4 s after the player's arrival; the merge threshold 1.5 s either side.
  const EXPECTED = [
    { relative: -3, verdict: "clear", merge: null },
    { relative: -1, verdict: "traffic", merge: -1 },
    { relative: 3, verdict: "traffic", merge: null },
    { relative: 5, verdict: "clear", merge: null },
  ] as const;

  it("covers the spec's four cases", () => {
    expect(EXPECTED.map((c) => c.relative)).toEqual([...TRAFFIC_PIT_EXIT_CASES]);
  });

  it.each(EXPECTED)(
    "calls $verdict for a car at the blend $relative s after the player at the call point, and warns at the merge: $merge",
    ({ relative, verdict, merge }) => {
      const { controller, events } = startTranslator("race", { loadPitLaneLandmarks: LANDMARKS });

      runSequence(controller, trafficPitExitSequence(relative));

      expect(events).toEqual([...callOf(verdict, relative), ...intoTheExitLane(merge)]);
    },
  );

  it.each(EXPECTED)(
    "calls $verdict for a car at the blend $relative s with the tick loop paused, and warns at the merge: $merge",
    ({ relative, verdict, merge }) => {
      const { controller, events } = startTranslator("race", { loadPitLaneLandmarks: LANDMARKS });

      runSequencePaused(controller, trafficPitExitSequence(relative));

      expect(events).toEqual([...callOf(verdict, relative), ...intoTheExitLane(merge)]);
    },
  );

  it.each(EXPECTED)(
    "says nothing for the $relative s case on leaving the stall, 6.15 s short of pit road's end",
    ({ relative }) => {
      const { controller, events } = startTranslator("race", { loadPitLaneLandmarks: LANDMARKS });
      const steps = trafficPitExitSequence(relative);
      const departure = steps.findIndex((step) => step.patch.PlayerCarInPitStall === false);

      // Up to and through the whole hold on pit road, past an evaluation.
      runSequence(controller, steps.slice(0, departure + 1));

      expect(departure).toBeGreaterThan(0);
      expect(events).toEqual([{ event: "pitStall.departed", data: {} }]);
    },
  );

  it("gives no merge warning for the -1 s case with the threshold set under it, read from the translator option", () => {
    const { controller, events } = startTranslator("race", {
      loadPitLaneLandmarks: LANDMARKS,
      getTrafficPitExitMergeWarnSeconds: () => 0.5,
    });

    runSequence(controller, trafficPitExitSequence(-1));

    expect(events).toEqual([...callOf("traffic", -1), ...intoTheExitLane(null)]);
  });

  it("plays the four cases one after another, each on its own", () => {
    const { controller, events } = startTranslator("race", { loadPitLaneLandmarks: LANDMARKS });

    for (const relative of TRAFFIC_PIT_EXIT_CASES) runSequence(controller, trafficPitExitSequence(relative));

    expect(events.filter((e) => e.event === "traffic.pitExit").map((e) => e.data)).toEqual(
      EXPECTED.map(({ relative, verdict }) => ({ verdict, seconds: relative })),
    );
    expect(events.filter((e) => e.event === "traffic.pitExitMerge").map((e) => e.data)).toEqual([{ seconds: -1 }]);
  });

  it("is silent without the landmarks: the translator's learner has none for the track", () => {
    // Control, and the state of the running harness: `main.ts` hands the
    // translator no landmark loader, and no session preset carries the
    // `SubSessionID` the learner needs to learn one live.
    const { controller, events } = startTranslator("race");

    runSequence(controller, trafficPitExitSequence(-1));

    expect(events).toEqual([{ event: "pitStall.departed", data: {} }, ...intoTheExitLane(null)]);
  });
});

// The telemetry these buttons leave behind; that each line is then HEARD,
// through the registered contracts and their speak gate, is
// `traffic-pit-exit-heard.test.ts`.
describe("the pit-exit bus-event buttons (issue #1113)", () => {
  /**
   * The pit-exit lines' speak-time gate, as `traffic.ts` in the catalog reads
   * it (`stillLeavingThePits`, not exported): the translator's latest telemetry
   * not on the racing surface. Restated here because the gate itself is built
   * only inside `registerPitCrew`.
   */
  function pitExitGateAdmits(): boolean {
    const surface = getLatestTelemetry()?.PlayerTrackSurface;

    return surface !== TrkLoc.OnTrack && surface !== TrkLoc.OffTrack;
  }

  const shortcutOf = (id: string): ScenarioShortcut => {
    const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === id);

    if (shortcut === undefined) throw new Error(`no shortcut ${id}`);

    return shortcut;
  };

  it.each(["traffic-pit-exit-traffic", "traffic-pit-exit-clear", "traffic-pit-exit-merge"])(
    "%s puts the car on the pit lane after a button left it on track, announcing nothing, and hands it back",
    (id) => {
      const shortcut = shortcutOf(id);
      const { controller, events } = startTranslator("race");

      // An overtake or gap button pressed first: on track at racing speed.
      runSequence(controller, [AT_RACING_SPEED]);
      // Positive control: a publish now would be dropped by the gate.
      expect(pitExitGateAdmits()).toBe(false);
      events.length = 0;

      runSequence(controller, shortcut.telemetrySequence ?? []);

      expect(getLatestTelemetry()).toMatchObject({
        PlayerTrackSurface: TrkLoc.AproachingPits,
        OnPitRoad: true,
        IsReplayPlaying: false,
      });
      expect(pitExitGateAdmits()).toBe(true);
      // Seeded, not announced: no pit entry, no limiter warning over the line.
      expect(events).toEqual([]);

      runSequence(controller, shortcut.teardownSequence ?? []);

      expect(getLatestTelemetry()).toMatchObject({
        PlayerTrackSurface: TrkLoc.OnTrack,
        OnPitRoad: false,
        IsReplayPlaying: false,
      });
      expect(events).toEqual([]);
    },
  );

  it.each([
    // The traffic and merge warnings' 3 s queue wait, and the clear line's engine default of 8 s.
    { id: "traffic-pit-exit-traffic", contract: "pit-crew.traffic-pit-exit-traffic", holdMs: 4000 },
    { id: "traffic-pit-exit-clear", contract: "pit-crew.traffic-pit-exit-clear", holdMs: 9000 },
    { id: "traffic-pit-exit-merge", contract: "pit-crew.traffic-pit-exit-merge", holdMs: 4000 },
  ])("$id listens past its own line's queue wait before handing the car back", ({ id, contract, holdMs }) => {
    const queueWait = TRAFFIC_CONTRACTS.find((c) => c.id === contract)?.maxQueueWaitMs;

    expect(shortcutOf(id).teardownSequence?.[0]).toEqual({ patch: {}, holdMs });
    expect(queueWait).toBeDefined();
    expect(holdMs).toBeGreaterThan(queueWait ?? Number.POSITIVE_INFINITY);
  });
});
