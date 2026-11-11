/**
 * The approaching-traffic telemetry (issue #1113) through the real translator
 * on the mock SDK: the rejoin train is heard as clear → notice → hold → go,
 * and the four pit-exit cases as clear, traffic, traffic, clear at the default
 * window. Every event in the catalog is recorded, so a line the run lets slip
 * from another family cannot hide.
 */
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import type { SDKController, SessionInfo } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  initializeSimEventsIracing,
  type SimEventsIracingOptions,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import type { TelemetryStep } from "./scenario-shortcuts.js";
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
  it.each(["race", "race-oval"])("is heard as clear, notice 12, hold 4, then go, and nothing else (%s)", (preset) => {
    const { controller, events } = startTranslator(preset);

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events).toEqual([
      { event: "traffic.rejoin", data: { verdict: "clear", windowSeconds: 20 } },
      { event: "traffic.rejoin", data: { verdict: "notice", seconds: 12 } },
      { event: "traffic.rejoin", data: { verdict: "hold", seconds: 4 } },
      { event: "traffic.rejoin", data: { verdict: "go" } },
    ]);
  });

  it("plays the same on a second press", () => {
    const { controller, events } = startTranslator("race");

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);
    events.length = 0;
    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE);

    expect(events.map((e) => (e.data as { verdict: string }).verdict)).toEqual(["clear", "notice", "hold", "go"]);
  });

  it("times the class-B cars by class B's own curve: without the learning lap only the class-A car is heard", () => {
    // Control: the lead and tail cars are class B, and the presets carry no
    // class lap times to scale the player's class by, so with no class-B
    // samples at P both are untimed. They withhold every clear (and the go),
    // and the class-A car, nine seconds behind the lead, is the only arrival:
    // heard at 13 s, and again at 9 s, four seconds closer.
    const { controller, events } = startTranslator("race");

    runSequence(controller, TRAFFIC_REJOIN_SEQUENCE_UNLEARNED);

    expect(events).toEqual([
      { event: "traffic.rejoin", data: { verdict: "notice", seconds: 13 } },
      { event: "traffic.rejoin", data: { verdict: "notice", seconds: 9 } },
    ]);
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

  // At the default window, 2 s before to 4 s after the player's arrival.
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
