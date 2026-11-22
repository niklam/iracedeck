/**
 * The Fuel buttons once the countdown is every session's (issue #1702).
 *
 * The translator emits `fuel.lapsLeft.crossed` in every live session, and the
 * Race Engineer speaks it in the session kinds the Speak in toggles leave on,
 * reading the kind from the translator's `getSessionClass()`. The mock SDK
 * boots with no session info, so that read is `null` and every Fuel button
 * would be silent for a reason nobody could see (the #1167 trap). So each
 * button requires a session the Race Engineer can classify and a connected
 * mock SDK, "Enough fuel to finish" a race, and "Countdown through the
 * translator" drives the countdown the translator itself decides.
 *
 * What the buttons are HEARD to do is `fuel-countdown-heard.test.ts`'s.
 */
import { createFakeAudio } from "@iracedeck/audio-service/testing";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { Flags, type SDKController, type SessionInfo, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  classifySession,
  FUEL_LAPS_LEFT_MAX_COUNT,
  getLatestTelemetry,
  getSessionClass,
  initializeSimEventsIracing,
  isPlayerFinalLapStarted,
} from "@iracedeck/sim-events-iracing";
import type { FastifyInstance } from "fastify";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES, EVENT_TEMPLATES, FUEL_SESSION_GATE_NOTE } from "./event-names.js";
import type { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import {
  FUEL_RUN_LAPS,
  SCENARIO_SHORTCUTS,
  type ScenarioShortcut,
  servedShortcut,
  type TelemetryStep,
} from "./scenario-shortcuts.js";
import { createServer } from "./server.js";
import { checkShortcutPreconditions, type HarnessPreconditionState } from "./shortcut-preconditions.js";

// A pass-through spy on the translator's classifier: the precondition must ASK
// it rather than restate it, and only a spy can tell the two apart.
vi.mock("@iracedeck/sim-events-iracing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/sim-events-iracing")>();

  return { ...actual, classifySession: vi.fn(actual.classifySession) };
});

type Published = { event: string; data: unknown };

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

function readPreset(kind: "session" | "telemetry", name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PRESETS_DIR, kind, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function presetNames(kind: "session" | "telemetry"): string[] {
  return readdirSync(join(PRESETS_DIR, kind))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
}

/** Every session preset the harness ships, read from the folder, so a new one is judged too. */
const SESSION_PRESETS = presetNames("session");

/** The two race presets: the only sessions "Enough fuel to finish" is heard in. */
const RACE_PRESETS = ["race", "race-oval"];

const RUN_ID = "fuel-countdown-run";
const RACE_COVERED_ID = "fuel-race-covered";

/** The per-count buttons: 10 down to 1, then "Box this lap" (count 0). */
const COUNT_IDS = [...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `fuel-laps-left-${n}`), "fuel-laps-left-box"];

/** The mock SDK's boot telemetry: session 0. */
const BOOT_TELEMETRY = new MockSDKController().getState().telemetry;

function requiresOf(id: string): ScenarioShortcut["requires"] {
  return SCENARIO_SHORTCUTS.find((s) => s.id === id)?.requires;
}

function stateWith(
  sessionInfo: Record<string, unknown> | null,
  options: {
    isConnected?: boolean;
    sessionNum?: number;
    translatorSessionNum?: number | null;
    playerFinalLapStarted?: boolean | null;
  } = {},
): HarnessPreconditionState {
  const isConnected = options.isConnected ?? true;
  const sessionNum = options.sessionNum ?? 0;
  // The translator's latest tick: by default the same session as the mock's,
  // none while disconnected.
  const translatorSessionNum = options.translatorSessionNum === undefined ? sessionNum : options.translatorSessionNum;

  return {
    sessionInfo,
    isConnected,
    telemetry: { ...BOOT_TELEMETRY, SessionNum: sessionNum } as TelemetryData,
    translatorTelemetry:
      !isConnected || translatorSessionNum === null
        ? null
        : ({ ...BOOT_TELEMETRY, SessionNum: translatorSessionNum } as TelemetryData),
    playerFinalLapStarted: options.playerFinalLapStarted ?? (isConnected ? false : null),
  };
}

/**
 * Drives the real translator with a telemetry sequence as the UI does with the
 * mock's timer running: patch, tick, then tick through the hold.
 */
function runSequence(controller: MockSDKController, steps: readonly TelemetryStep[]): void {
  const TICK_MS = 100;

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
 * The harness as a tester sets it up: a session preset (or none), the mock SDK
 * connected, optionally a telemetry preset, and the real translator over it,
 * seeded on one tick. Every event in the catalog is recorded from then on.
 */
function startTranslator(
  sessionPreset: string | null,
  telemetryPreset?: string,
): { controller: MockSDKController; events: Published[] } {
  const controller = new MockSDKController({ onSubscriberError: "rethrow" });

  if (sessionPreset !== null) controller.setSessionInfo(readPreset("session", sessionPreset) as unknown as SessionInfo);

  if (telemetryPreset !== undefined) {
    controller.mutateTelemetry(readPreset("telemetry", telemetryPreset) as TelemetryPatch);
  }

  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger, {
    onStepError: "rethrow",
  });
  controller.tickOnce();

  const events: Published[] = [];

  for (const name of ALL_EVENT_NAMES) {
    getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
  }

  return { controller, events };
}

function runSteps(): readonly TelemetryStep[] {
  const steps = SCENARIO_SHORTCUTS.find((s) => s.id === RUN_ID)?.telemetrySequence;

  if (steps === undefined) throw new Error(`no telemetry sequence on "${RUN_ID}"`);

  return steps;
}

/** The counts the run publishes, in order: one a lap after its first, the ceiling down to "box this lap". */
const EXPECTED_COUNTS = Array.from({ length: FUEL_LAPS_LEFT_MAX_COUNT + 1 }, (_, i) => FUEL_LAPS_LEFT_MAX_COUNT - i);

function fuelEvents(events: readonly Published[]): Published[] {
  return events.filter((e) => e.event.startsWith("fuel."));
}

function countsOf(events: readonly Published[]): unknown[] {
  return fuelEvents(events).map((e) => (e.event === "fuel.lapsLeft.crossed" ? (e.data as { count: number }).count : e));
}

beforeEach(() => {
  initializeEventBus(silentLogger);
  vi.useFakeTimers();
});

afterEach(() => {
  _resetSimEventsIracing();
  _resetEventBus();
  vi.useRealTimers();
});

describe("the Fuel buttons' preconditions (issue #1702)", () => {
  it("covers every Fuel button: the counts and the translator run need a classified session, the reassurance a race", () => {
    const fuel = SCENARIO_SHORTCUTS.filter((s) => s.category === "Fuel").map((s) => s.id);

    expect(fuel.sort()).toEqual([...COUNT_IDS, RACE_COVERED_ID, RUN_ID].sort());

    for (const id of [...COUNT_IDS, RUN_ID]) {
      expect(requiresOf(id), id).toEqual([
        "session-classified",
        "sdk-connected",
        "translator-session-current",
        "before-final-lap",
      ]);
    }

    expect(requiresOf(RACE_COVERED_ID)).toEqual([
      "race-session",
      "sdk-connected",
      "translator-session-current",
      "before-final-lap",
    ]);
  });

  it("refuses every Fuel button on the final lap, the countdown run included", () => {
    const onFinalLap = stateWith(readPreset("session", "race"), { playerFinalLapStarted: true });

    for (const id of [...COUNT_IDS, RACE_COVERED_ID, RUN_ID]) {
      const refusal = checkShortcutPreconditions(requiresOf(id), onFinalLap);

      expect(refusal, id).toEqual(expect.stringContaining("final lap"));
      expect(refusal).toContain("hot-lap");
    }

    // The speak gate's own test: only a definite "on the final lap" refuses.
    for (const answer of [false, null]) {
      expect(
        checkShortcutPreconditions(
          ["before-final-lap"],
          stateWith(readPreset("session", "race"), { playerFinalLapStarted: answer }),
        ),
        String(answer),
      ).toBeNull();
    }
  });

  it("refuses them while the translator's latest tick is in another session than the mock, asking for a tick", () => {
    // A session number changed by hand with the tick loop paused: the mock is
    // in session 0, the translator last read session 5, which the preset does
    // not list, so the fuel gate would classify nothing.
    const stale = stateWith(readPreset("session", "race"), { sessionNum: 0, translatorSessionNum: 5 });

    for (const id of [...COUNT_IDS, RUN_ID, RACE_COVERED_ID]) {
      const refusal = checkShortcutPreconditions(SCENARIO_SHORTCUTS.find((s) => s.id === id)?.requires, stale);

      expect(refusal, id).toEqual(expect.stringContaining("Tick once"));
    }

    // The same session on both sides runs; a translator with no tick at all does not.
    expect(
      checkShortcutPreconditions(["translator-session-current"], stateWith(readPreset("session", "race"))),
    ).toBeNull();
    expect(
      checkShortcutPreconditions(
        ["translator-session-current"],
        stateWith(readPreset("session", "race"), { translatorSessionNum: null }),
      ),
    ).not.toBeNull();
  });

  it("refuses every Fuel button as the harness boots, asking for a session preset and naming the toggles", () => {
    // No session info, disconnected: the session is asked for first.
    for (const id of [...COUNT_IDS, RUN_ID]) {
      const refusal = checkShortcutPreconditions(
        SCENARIO_SHORTCUTS.find((s) => s.id === id)?.requires,
        stateWith(null, { isConnected: false }),
      );

      expect(refusal, id).toEqual(expect.stringContaining("Apply a session preset first"));
      expect(refusal).toContain("Speak in");
      expect(refusal).toContain('"testing"');
    }

    const raceCovered = checkShortcutPreconditions(
      SCENARIO_SHORTCUTS.find((s) => s.id === RACE_COVERED_ID)?.requires,
      stateWith(null, { isConnected: false }),
    );

    expect(raceCovered).toEqual(expect.stringContaining('"race" or "race-oval" session preset'));
  });

  it("refuses them on a classified session while the mock SDK is disconnected", () => {
    // `getSessionClass()` is null until the translator has a tick to read the
    // session number from, which a disconnected mock never delivers.
    for (const id of [...COUNT_IDS, RUN_ID, RACE_COVERED_ID]) {
      const refusal = checkShortcutPreconditions(
        SCENARIO_SHORTCUTS.find((s) => s.id === id)?.requires,
        stateWith(readPreset("session", "race"), { isConnected: false }),
      );

      expect(refusal, id).toEqual(expect.stringContaining("Connect the mock SDK"));
    }
  });

  it.each(SESSION_PRESETS)(
    "permits the counts on every session preset, the reassurance on a race alone (%s)",
    (preset) => {
      for (const id of [...COUNT_IDS, RUN_ID]) {
        expect(
          checkShortcutPreconditions(
            SCENARIO_SHORTCUTS.find((s) => s.id === id)?.requires,
            stateWith(readPreset("session", preset)),
          ),
          `${id} on ${preset}`,
        ).toBeNull();
      }

      const refusal = checkShortcutPreconditions(
        SCENARIO_SHORTCUTS.find((s) => s.id === RACE_COVERED_ID)?.requires,
        stateWith(readPreset("session", preset)),
      );

      expect(refusal === null, `on ${preset}: ${refusal}`).toBe(RACE_PRESETS.includes(preset));
    },
  );

  it("asks the translator's own classifier — never a restated one", () => {
    const sessionInfo = readPreset("session", "testing");

    vi.mocked(classifySession).mockClear();
    expect(checkShortcutPreconditions(["session-classified"], stateWith(sessionInfo))).toBeNull();
    expect(vi.mocked(classifySession)).toHaveBeenCalledWith("Offline Testing");

    // Its verdict is the rule, whatever the session holds.
    vi.mocked(classifySession).mockReturnValueOnce(null);
    expect(checkShortcutPreconditions(["session-classified"], stateWith(sessionInfo))).not.toBeNull();

    vi.mocked(classifySession).mockReturnValueOnce({ category: "race", soloQualifying: false, testing: false });
    expect(checkShortcutPreconditions(["race-session"], stateWith(sessionInfo))).toBeNull();
  });

  /**
   * The wet version: each session the precondition could be asked about,
   * handed to the running translator, whose `getSessionClass()` is what the
   * fuel gate reads. The precondition calls the translator's own
   * `resolveSessionType` and `classifySession`; this checks the two answers
   * agree on every preset, no session at all, a weekend read in either of its
   * sessions, and a session number past the end of the list.
   */
  const weekend = (): Record<string, unknown> => ({
    ...readPreset("session", "race"),
    SessionInfo: {
      Sessions: [
        { SessionNum: 0, SessionType: "Offline Testing" },
        { SessionNum: 1, SessionType: "Race" },
      ],
    },
  });
  const cases: [string, Record<string, unknown> | null, number][] = [
    ...SESSION_PRESETS.map((preset): [string, Record<string, unknown>, number] => [
      preset,
      readPreset("session", preset),
      0,
    ]),
    ["no session info", null, 0],
    ["a weekend, in its first session", weekend(), 0],
    ["a weekend, in its second session", weekend(), 1],
    ["a session number past the list", readPreset("session", "practice"), 3],
  ];

  it.each(cases)("agrees with the running translator's classification (%s)", (_, sessionInfo, sessionNum) => {
    const controller = new MockSDKController({ onSubscriberError: "rethrow" });

    if (sessionInfo !== null) controller.setSessionInfo(sessionInfo as unknown as SessionInfo);

    controller.mutateTelemetry({ SessionNum: sessionNum });
    controller.setConnected(true);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger, {
      onStepError: "rethrow",
    });
    controller.tickOnce();

    const translator = getSessionClass();
    const state = stateWith(sessionInfo, { sessionNum });

    expect(checkShortcutPreconditions(["session-classified"], state) === null).toBe(translator !== null);
    expect(checkShortcutPreconditions(["race-session"], state) === null).toBe(translator?.category === "race");
  });

  it("covers both answers of both rules, so neither agreement above is a constant", () => {
    const verdicts = cases.map(([, sessionInfo, sessionNum]) => ({
      classified: checkShortcutPreconditions(["session-classified"], stateWith(sessionInfo, { sessionNum })) === null,
      race: checkShortcutPreconditions(["race-session"], stateWith(sessionInfo, { sessionNum })) === null,
    }));

    expect(new Set(verdicts.map((v) => v.classified))).toEqual(new Set([true, false]));
    expect(new Set(verdicts.map((v) => v.race))).toEqual(new Set([true, false]));
  });
});

describe("the fuel events' injector templates (issue #1702)", () => {
  it("say the two fuel events are heard only in a classified session, and no other template does", () => {
    // The injector publishes exactly what it is given and arranges no session.
    const noted = EVENT_TEMPLATES.filter((t) => t.description.includes(FUEL_SESSION_GATE_NOTE)).map((t) => t.name);

    expect(noted.sort()).toEqual(["fuel.lapsLeft.crossed", "fuel.lapsLeft.raceCovered"]);
    expect(FUEL_SESSION_GATE_NOTE).toContain("session preset");
  });
});

describe("the testing session preset (issue #1702)", () => {
  it("is a test session to the Race Engineer, and the practice preset is not", () => {
    startTranslator("testing");
    expect(getSessionClass()).toEqual({ category: "practice", soloQualifying: false, testing: true });

    _resetSimEventsIracing();
    startTranslator("practice");
    expect(getSessionClass()).toEqual({ category: "practice", soloQualifying: false, testing: false });
  });

  it("has a track id of its own, since the translator caches track geometry by it", () => {
    const trackIdOf = (preset: string): unknown =>
      (readPreset("session", preset).WeekendInfo as Record<string, unknown> | undefined)?.TrackID;
    const others = SESSION_PRESETS.filter((preset) => preset !== "testing").map(trackIdOf);

    expect(typeof trackIdOf("testing")).toBe("number");
    expect(others).not.toContain(trackIdOf("testing"));
  });
});

describe("the final-lap precondition against the running translator (issue #1702)", () => {
  /** What `/api/shortcut/start` hands the rules: the mock's state and the translator's answers. */
  function routeState(controller: MockSDKController): HarnessPreconditionState {
    const { sessionInfo, isConnected, telemetry } = controller.getState();

    return {
      sessionInfo: sessionInfo as Record<string, unknown> | null,
      isConnected,
      telemetry,
      translatorTelemetry: getLatestTelemetry(),
      playerFinalLapStarted: isPlayerFinalLapStarted(),
    };
  }

  function tick(controller: MockSDKController, patch: TelemetryPatch): void {
    controller.mutateTelemetry(patch);
    controller.tickOnce();
  }

  it("refuses the per-count buttons under a chequered flag, and runs them on a racing lap again", () => {
    const { controller } = startTranslator("practice", "hot-lap");

    tick(controller, { SessionState: SessionState.Checkered });

    expect(isPlayerFinalLapStarted()).toBe(true);
    expect(checkShortcutPreconditions(requiresOf("fuel-laps-left-3"), routeState(controller))).toContain("final lap");

    tick(controller, readPreset("telemetry", "hot-lap") as TelemetryPatch);

    expect(isPlayerFinalLapStarted()).toBe(false);
    expect(checkShortcutPreconditions(requiresOf("fuel-laps-left-3"), routeState(controller))).toBeNull();
  });

  it("in a race keeps refusing once the last lap is marked, until a green flag, as its reason says", () => {
    const { controller } = startTranslator("race", "hot-lap");

    // The white shown, then the player's own crossing past the heads-up gap:
    // the translator marks the race's last lap.
    tick(controller, { LapCompleted: 4 });
    tick(controller, { SessionFlags: Flags.White });
    vi.advanceTimersByTime(10_000);
    tick(controller, { LapCompleted: 5 });

    expect(isPlayerFinalLapStarted()).toBe(true);

    tick(controller, readPreset("telemetry", "hot-lap") as TelemetryPatch);

    expect(isPlayerFinalLapStarted()).toBe(true);
    expect(checkShortcutPreconditions(requiresOf(RACE_COVERED_ID), routeState(controller))).toContain("final lap");

    tick(controller, { SessionFlags: Flags.Green });

    expect(isPlayerFinalLapStarted()).toBe(false);
    expect(checkShortcutPreconditions(requiresOf(RACE_COVERED_ID), routeState(controller))).toBeNull();
  });

  it("refuses the countdown run under a chequered flag, and runs it after the hot-lap preset and a tick", () => {
    const { controller, events } = startTranslator("practice");

    tick(controller, { SessionState: SessionState.Checkered });

    expect(checkShortcutPreconditions(requiresOf(RUN_ID), routeState(controller))).toContain("final lap");

    tick(controller, readPreset("telemetry", "hot-lap") as TelemetryPatch);

    expect(checkShortcutPreconditions(requiresOf(RUN_ID), routeState(controller))).toBeNull();

    runSequence(controller, runSteps());

    expect(countsOf(events)).toEqual(EXPECTED_COUNTS);
  });

  it("refuses the countdown run in a race whose last lap is marked, which it could not count, until a green", () => {
    const { controller, events } = startTranslator("race", "hot-lap");

    tick(controller, { LapCompleted: 4 });
    tick(controller, { SessionFlags: Flags.White });
    vi.advanceTimersByTime(10_000);
    tick(controller, { LapCompleted: 5 });
    tick(controller, readPreset("telemetry", "hot-lap") as TelemetryPatch);

    expect(checkShortcutPreconditions(requiresOf(RUN_ID), routeState(controller))).toContain("final lap");

    // Why: the run shows no green, so the marked last lap survives it and the
    // translator counts nothing.
    runSequence(controller, runSteps());

    expect(countsOf(events)).toEqual([]);

    tick(controller, { SessionFlags: Flags.Green });

    expect(checkShortcutPreconditions(requiresOf(RUN_ID), routeState(controller))).toBeNull();

    runSequence(controller, runSteps());

    expect(countsOf(events)).toEqual(EXPECTED_COUNTS);
  });
});

describe("Fuel → Countdown through the translator (issue #1702)", () => {
  const steps = runSteps();

  it("drives the translator rather than publishing an event, in the Fuel category", () => {
    const run = SCENARIO_SHORTCUTS.find((s) => s.id === RUN_ID);

    expect(run?.event).toBeUndefined();
    expect(run?.category).toBe("Fuel");
    expect(run?.label).toBe("Countdown through the translator");
    expect(FUEL_RUN_LAPS).toBe(FUEL_LAPS_LEFT_MAX_COUNT + 2);
  });

  it.each(["practice", "testing"])(
    "publishes the countdown one lap at a time, %s, and nothing else a callout speaks for",
    (preset) => {
      const { controller, events } = startTranslator(preset);

      runSequence(controller, steps);

      expect(countsOf(events)).toEqual(EXPECTED_COUNTS);
      // Each count on its own lap, in the order the laps were driven.
      expect(events.filter((e) => e.event !== "driver.firstOnTrack")).toEqual(
        Array.from({ length: FUEL_RUN_LAPS + 1 }, (_, i) => [
          ...(i >= 2
            ? [
                {
                  event: "fuel.lapsLeft.crossed",
                  data: expect.objectContaining({ count: FUEL_LAPS_LEFT_MAX_COUNT + 2 - i }),
                },
              ]
            : []),
          { event: "lap.started", data: { lap: i + 2 } },
        ]).flat(),
      );
    },
  );

  it("never publishes the race reassurance outside a race, and no session brief on a first press", () => {
    for (const preset of ["practice", "testing", "qualifying", "lone-qualifying"]) {
      _resetSimEventsIracing();

      const { controller, events } = startTranslator(preset);

      runSequence(controller, steps);

      expect(
        events.map((e) => e.event),
        preset,
      ).not.toContain("fuel.lapsLeft.raceCovered");
      expect(
        events.map((e) => e.event),
        preset,
      ).not.toContain("session.changed");
    }
  });

  it.each(SESSION_PRESETS)("publishes the same counts on any session preset (%s)", (preset) => {
    const { controller, events } = startTranslator(preset);

    runSequence(controller, steps);

    expect(countsOf(events)).toEqual(EXPECTED_COUNTS);
  });

  it.each(presetNames("telemetry"))("publishes the same counts from any telemetry preset (%s)", (preset) => {
    // The bracket puts the car where the run needs it whatever it was doing:
    // in the garage, in the pit stall, on pit road, off track.
    const { controller, events } = startTranslator("practice", preset);

    runSequence(controller, steps);

    expect(countsOf(events)).toEqual(EXPECTED_COUNTS);
  });

  it("publishes the same again on a second and a third press, the lap history from the first notwithstanding", () => {
    const { controller, events } = startTranslator("testing");

    runSequence(controller, steps);
    runSequence(controller, steps);
    runSequence(controller, steps);

    expect(countsOf(events)).toEqual([...EXPECTED_COUNTS, ...EXPECTED_COUNTS, ...EXPECTED_COUNTS]);
  });

  it("control: a run starting a lap of fuel lower announces the ceiling on a second press and not on the first", () => {
    // Why the run starts one count above the ceiling: the tracker's average
    // survives the bracket, so the first sample has one to read on a repeat
    // press and none on the first. A lap of fuel less puts that sample at the
    // ceiling, and the two presses differ.
    const lapFuel = (steps.at(-4)?.patch.FuelLevel as number) - (steps.at(-1)?.patch.FuelLevel as number);
    const lower = steps.map((step) =>
      typeof step.patch.FuelLevel === "number"
        ? { ...step, patch: { ...step.patch, FuelLevel: step.patch.FuelLevel - lapFuel } }
        : step,
    );
    const { controller, events } = startTranslator("testing");

    expect(lapFuel).toBeGreaterThan(0);

    runSequence(controller, lower);

    const first = countsOf(events);

    events.length = 0;
    runSequence(controller, lower);

    expect(first[0]).toBe(FUEL_LAPS_LEFT_MAX_COUNT - 1);
    expect(countsOf(events)[0]).toBe(FUEL_LAPS_LEFT_MAX_COUNT);
  });

  describe("its teardown", () => {
    const served = servedShortcut(SCENARIO_SHORTCUTS.find((s) => s.id === RUN_ID) as ScenarioShortcut);

    /** As the route applies a step with the tick loop paused: one tick if it asks, then only the clock. */
    function post(controller: MockSDKController, posted: readonly TelemetryStep[]): void {
      for (const step of posted) {
        controller.mutateTelemetry(step.patch as TelemetryPatch);

        if (step.tick === true) controller.tickOnce();

        vi.advanceTimersByTime(step.holdMs ?? 0);
      }
    }

    /** The next button's first step: a caution thrown, which a live translator announces. */
    const CAUTION: TelemetryStep = {
      patch: { SessionFlags: Flags.Servicible | Flags.StartHidden | Flags.CautionWaving },
      tick: true,
    };

    it.each(Array.from({ length: steps.length - 1 }, (_, i) => i + 1))(
      "hands the next button a live translator after a run that failed after step %i",
      (prefix) => {
        // The run's first step opens a replay-mode bracket and its third closes
        // it; a POST failing in between leaves the mock in replay, where the
        // translator publishes nothing for any button, unless the UI's failure
        // path has a teardown to apply — the served copy, as the page reads it.
        const { controller, events } = startTranslator("practice");

        post(controller, steps.slice(0, prefix));
        post(controller, served.failedRunTeardownSequence ?? []);
        events.length = 0;
        post(controller, [CAUTION]);

        expect(controller.getState().telemetry.IsReplayPlaying).toBe(false);
        expect(events.map((e) => e.event)).toContain("flag.caution-waving.raised");
      },
    );

    it("control: with no teardown, a run that failed inside its bracket leaves the next button silent", () => {
      const { controller, events } = startTranslator("practice");

      post(controller, steps.slice(0, 1));
      events.length = 0;
      post(controller, [CAUTION]);

      expect(controller.getState().telemetry.IsReplayPlaying).toBe(true);
      expect(events.map((e) => e.event)).not.toContain("flag.caution-waving.raised");
    });

    it("after a run that went through, publishes nothing, and the next press counts the same", () => {
      const { controller, events } = startTranslator("testing");

      runSequence(controller, steps);

      const countdown = events.length;

      runSequence(controller, served.teardownSequence ?? []);

      expect(events.slice(countdown)).toEqual([]);

      runSequence(controller, steps);

      expect(countsOf(events)).toEqual([...EXPECTED_COUNTS, ...EXPECTED_COUNTS]);
    });
  });

  it("control: opened on a tick of Racing instead, its first press in practice publishes the session brief's trigger", () => {
    const racing = steps.map((step, i) =>
      i === 0 ? { ...step, patch: { ...step.patch, SessionState: SessionState.Racing } } : step,
    );

    expect(steps[0].patch.SessionState).toBe(SessionState.CoolDown);

    const { controller, events } = startTranslator("practice");

    runSequence(controller, racing);

    expect(events.map((e) => e.event)).toContain("session.changed");
  });
});

describe("POST /api/shortcut/start for the Fuel buttons (issue #1702)", () => {
  let app: FastifyInstance;
  let controller: MockSDKController;

  beforeEach(async () => {
    // Fastify's request handling runs on real timers; nothing here ticks.
    vi.useRealTimers();
    controller = new MockSDKController({ onSubscriberError: "rethrow" });
    // The translator the route asks for its latest tick, as `main.ts` runs it.
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger, {
      onStepError: "rethrow",
    });
    app = await createServer({
      controller,
      adapter: {} as unknown as MockPlatformAdapter,
      bus: getEventBus(),
      audio: createFakeAudio(),
      packageRoot: join(PRESETS_DIR, ".."),
      logger: silentLogger,
      refreshAudioAssets: async () => {},
      wipeAudioCache: async () => {},
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function start(id: string): Promise<{ statusCode: number; error?: string }> {
    const res = await app.inject({ method: "POST", url: "/api/shortcut/start", payload: { id } });

    return {
      statusCode: res.statusCode,
      error: res.statusCode === 204 ? undefined : (res.json() as { error?: string }).error,
    };
  }

  it("refuses them as the harness boots, then disconnected, then lets them run on a test session", async () => {
    // Asserted at the ROUTE: it is the one call that means "a shortcut is
    // starting", so a check it forgot to make would leave the button silent.
    for (const id of [...COUNT_IDS, RUN_ID]) {
      const res = await start(id);

      expect(res.statusCode, id).toBe(409);
      expect(res.error).toContain("Apply a session preset first");
    }

    controller.setSessionInfo(readPreset("session", "testing") as unknown as SessionInfo);

    for (const id of [...COUNT_IDS, RUN_ID]) {
      const res = await start(id);

      expect(res.statusCode, id).toBe(409);
      expect(res.error).toContain("Connect the mock SDK");
    }

    controller.setConnected(true);

    for (const id of [...COUNT_IDS, RUN_ID]) expect((await start(id)).statusCode, id).toBe(204);
  });

  it("refuses them while the translator has not ticked on a session number changed by hand, and runs them once it has", async () => {
    // Connecting delivers a tick and session info is read live, so applying a
    // preset opens no window; a SessionNum written with the loop paused does.
    controller.setSessionInfo(readPreset("session", "testing") as unknown as SessionInfo);
    controller.setConnected(true);
    controller.mutateTelemetry({ SessionNum: 5 });
    controller.tickOnce();
    controller.mutateTelemetry({ SessionNum: 0 });

    // The window is real: the mock is in the test session, the gate reads none.
    expect(getSessionClass()).toBeNull();

    for (const id of [...COUNT_IDS, RUN_ID]) {
      const res = await start(id);

      expect(res.statusCode, id).toBe(409);
      expect(res.error).toContain("Tick once");
    }

    controller.tickOnce();

    expect(getSessionClass()).toEqual({ category: "practice", soloQualifying: false, testing: true });

    for (const id of [...COUNT_IDS, RUN_ID]) expect((await start(id)).statusCode, id).toBe(204);
  });

  it("refuses every Fuel button under a chequered flag, and runs them all once racing", async () => {
    controller.setSessionInfo(readPreset("session", "race") as unknown as SessionInfo);
    controller.setConnected(true);
    controller.mutateTelemetry({ SessionState: SessionState.Checkered });
    controller.tickOnce();

    for (const id of [...COUNT_IDS, RACE_COVERED_ID, RUN_ID]) {
      const res = await start(id);

      expect(res.statusCode, id).toBe(409);
      expect(res.error).toContain("final lap");
    }

    controller.mutateTelemetry(readPreset("telemetry", "hot-lap") as TelemetryPatch);
    controller.tickOnce();

    for (const id of [...COUNT_IDS, RACE_COVERED_ID, RUN_ID]) expect((await start(id)).statusCode, id).toBe(204);
  });

  it("control: right after connecting with a preset applied, the translator already reads the session", async () => {
    controller.setSessionInfo(readPreset("session", "practice") as unknown as SessionInfo);
    controller.setConnected(true);

    expect(getSessionClass()).not.toBeNull();
    expect((await start(RUN_ID)).statusCode).toBe(204);
  });

  it("refuses Enough fuel to finish outside a race, naming the two presets, and lets it run in one", async () => {
    controller.setConnected(true);
    controller.setSessionInfo(readPreset("session", "practice") as unknown as SessionInfo);

    const refused = await start(RACE_COVERED_ID);

    expect(refused.statusCode).toBe(409);
    expect(refused.error).toContain('"race" or "race-oval" session preset');

    controller.setSessionInfo(readPreset("session", "race") as unknown as SessionInfo);

    expect((await start(RACE_COVERED_ID)).statusCode).toBe(204);
  });
});
