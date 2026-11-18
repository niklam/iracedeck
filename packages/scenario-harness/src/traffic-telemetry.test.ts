/**
 * The approaching-traffic telemetry (issue #1113) through the real translator
 * on the mock SDK: the rejoin train is heard as every band in turn,
 * and the four pit-exit cases as clear, traffic, traffic, clear. Every event in the catalog is recorded, so a line the run lets slip
 * from another family cannot hide.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { type SDKController, type SessionInfo, TrkLoc } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  getLatestTelemetry,
  initializeSimEventsIracing,
  type SimEventsIracingOptions,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import {
  AT_RACING_SPEED,
  SCENARIO_SHORTCUTS,
  type ScenarioShortcut,
  type TelemetryStep,
} from "./scenario-shortcuts.js";
import {
  TRAFFIC_PIT_EXIT_CASES,
  TRAFFIC_PIT_EXIT_PLAYER_ETA_S,
  TRAFFIC_REJOIN_SEQUENCE,
  TRAFFIC_REJOIN_SEQUENCE_UNLEARNED,
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
  const BANDS = [
    { verdict: "clear" },
    { verdict: "overTen" },
    { verdict: "near", seconds: 8, first: true },
    { verdict: "near", seconds: 5, first: false },
    { verdict: "rightBehind" },
    { verdict: "overTen" },
    { verdict: "near", seconds: 6, first: true },
  ].map((data) => ({ event: "traffic.rejoin", data }));

  it.each(["race", "race-oval"])("is heard as every band in turn, and nothing else (%s)", (preset) => {
    const { controller, events } = startTranslator(preset);

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual(BANDS);
  });

  it("plays the same on a second press", () => {
    const { controller, events } = startTranslator("race");

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);
    events.length = 0;
    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual(BANDS);
  });

  it("times the class-B cars by class B's own curve: without the learning lap only the class-A car's close call is heard", () => {
    // Control: the lead and tail cars are class B, and the presets carry no
    // class lap times to scale the player's class by, so with no class-B
    // samples at P both are untimed. They withhold overTen and clear, not a
    // close call: the timed class-A car is heard once it is under ten seconds.
    // The lead car's own near and rightBehind are not heard, being untimed.
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
    });
    getEventBus().subscribe("traffic.rejoin", (ev) => events.push({ event: ev.event, data: ev.data }));

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual([]);
  });
});

describe("the pit-exit cases (issue #1113)", () => {
  it("puts the player at the blend 4.86 s after leaving the stall", () => {
    expect(TRAFFIC_PIT_EXIT_PLAYER_ETA_S).toBeCloseTo(4.86, 6);
  });

  // The window is 2 s before to 4 s after the player's arrival; the call is made on the departure tick.
  const EXPECTED = [
    { relative: -3, verdict: "clear" },
    { relative: -1, verdict: "traffic" },
    { relative: 3, verdict: "traffic" },
    { relative: 5, verdict: "clear" },
  ] as const;

  it("covers the spec's four cases", () => {
    expect(EXPECTED.map((c) => c.relative)).toEqual([...TRAFFIC_PIT_EXIT_CASES]);
  });

  it.each(EXPECTED)(
    "calls $verdict for a car at the blend $relative s after the player, behind pitStall.departed",
    ({ relative, verdict }) => {
      const { controller, events } = startTranslator("race", { loadPitLaneLandmarks: LANDMARKS });

      runSequence(controller, trafficPitExitSequence(relative));

      expect(events).toEqual([
        { event: "pitStall.departed", data: {} },
        { event: "traffic.pitExit", data: { verdict, seconds: relative } },
      ]);
    },
  );

  it("plays the four cases one after another, each on its own", () => {
    const { controller, events } = startTranslator("race", { loadPitLaneLandmarks: LANDMARKS });

    for (const relative of TRAFFIC_PIT_EXIT_CASES) runSequence(controller, trafficPitExitSequence(relative));

    expect(events.filter((e) => e.event === "traffic.pitExit").map((e) => e.data)).toEqual(
      EXPECTED.map(({ relative, verdict }) => ({ verdict, seconds: relative })),
    );
  });

  it("is silent without the landmarks: the translator's learner has none for the track", () => {
    // Control, and the state of the running harness: `main.ts` hands the
    // translator no landmark loader, and no session preset carries the
    // `SubSessionID` the learner needs to learn one live.
    const { controller, events } = startTranslator("race");

    runSequence(controller, trafficPitExitSequence(-1));

    expect(events).toEqual([{ event: "pitStall.departed", data: {} }]);
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

  it.each(["traffic-pit-exit-traffic", "traffic-pit-exit-clear"])(
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

  it("listens past the traffic lines' queue wait before handing the car back", () => {
    for (const id of ["traffic-pit-exit-traffic", "traffic-pit-exit-clear"]) {
      expect(shortcutOf(id).teardownSequence?.[0]).toEqual({ patch: {}, holdMs: 4000 });
    }
  });
});
