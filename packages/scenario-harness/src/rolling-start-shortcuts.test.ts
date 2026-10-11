/**
 * The rolling-start shortcuts against the real translator (issue #1167).
 *
 * Four buttons: the whole formation, and its three calls on their own. Each
 * formation callout speaks only while the TRANSLATOR holds a formation, so
 * what is pinned here is what each button makes the translator publish and
 * where it leaves the formation state the callouts' gates read — step by
 * step, recording every event in the catalog rather than a chosen few, so a
 * line a button's own bookkeeping let slip cannot hide.
 *
 * What the buttons are then HEARD to say is `rolling-start-heard.test.ts`.
 */
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import { ROLLING_START_LINEUP_CHANGE_DELAY_MS } from "@iracedeck/audio-scenarios/pit-crew";
import type { CalloutScript } from "@iracedeck/callout-script";
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import {
  Flags,
  REPLAY_EXIT_GRACE_MS,
  type SDKController,
  type SessionInfo,
  SessionState,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  getPaceLineup,
  getRollingStartFormation,
  initializeSimEventsIracing,
  type PaceLineup,
  type RollingStartFormation,
} from "@iracedeck/sim-events-iracing";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES, EVENT_TEMPLATES, FORMATION_GATE_NOTE } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import {
  FORMATION_FOLLOW_CAR_IDX,
  FORMATION_NEXT_FOLLOW_CAR_IDX,
  FORMATION_PACE_CAR_IDX,
} from "./rolling-start-grid.js";
import { SCENARIO_SHORTCUTS, type ScenarioShortcut, type TelemetryStep } from "./scenario-shortcuts.js";
import { checkShortcutPreconditions } from "./shortcut-preconditions.js";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

/** The presets of one kind the harness ships, by name. */
function presetNames(kind: "session" | "telemetry"): string[] {
  return readdirSync(join(PRESETS_DIR, kind))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
}

/** Every telemetry preset: a formation button must play the same from each. */
const TELEMETRY_PRESETS = presetNames("telemetry");

/** Every session preset: the precondition and the translator must agree on each. */
const SESSION_PRESETS = presetNames("session");

const FORMATION = "rolling-start-formation";
const PACE_CAR = "rolling-start-pace-car-moving";
const LINEUP_CHANGED = "rolling-start-lineup-changed";
const ONE_LAP = "flag-one-lap-to-green";

/** `SessionFlags` as racing with no flag shown: pit service open, start lights hidden. */
const RACING_NO_FLAG = Flags.Servicible | Flags.StartHidden;

function readPreset(kind: "session" | "telemetry", name: string): unknown {
  return JSON.parse(readFileSync(join(PRESETS_DIR, kind, `${name}.json`), "utf8"));
}

function shortcutOf(id: string): ScenarioShortcut {
  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === id);

  if (shortcut === undefined) throw new Error(`no shortcut "${id}"`);

  return shortcut;
}

function stepsOf(id: string): readonly TelemetryStep[] {
  return shortcutOf(id).telemetrySequence ?? [];
}

/** What one step did: the events the translator published during it, and its formation and lineup once it had run. */
type StepTrace = {
  events: string[];
  formation: RollingStartFormation | null;
  lineup: PaceLineup | null;
  /** The fake clock when the step's patch landed. */
  at: number;
};

type Rig = { controller: MockSDKController; trace: StepTrace[]; events: string[] };

/**
 * The translator over the mock SDK, set up as a tester would before pressing:
 * a session preset (or none), a telemetry preset (or the mock's boot
 * telemetry), connected, and seeded. Every event in the catalog is recorded
 * from then on, bar `driver.firstOnTrack` — the one-shot "first time in the
 * car" event no callout consumes, which whichever button first puts the
 * driver in the car emits.
 */
function startRig(sessionPreset: string | null = "race-oval", telemetryPreset: string | null = "hot-lap"): Rig {
  const controller = new MockSDKController();

  if (sessionPreset !== null) controller.setSessionInfo(readPreset("session", sessionPreset) as SessionInfo);

  if (telemetryPreset !== null) {
    controller.mutateTelemetry(readPreset("telemetry", telemetryPreset) as Partial<TelemetryData>);
  }

  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
  controller.tickOnce();

  const rig: Rig = { controller, trace: [], events: [] };

  for (const name of ALL_EVENT_NAMES) {
    if (name === "driver.firstOnTrack") continue;

    getEventBus().subscribe(name, (ev) => rig.events.push(ev.event));
  }

  return rig;
}

/**
 * Drives the translator through `steps` the way the UI's button does with the
 * mock's timer running: the patch, then ticks at the mock's own 14 ms for the
 * step's hold. One trace entry per step is appended to the rig.
 */
function drive(rig: Rig, steps: readonly TelemetryStep[]): void {
  const TICK_MS = 14;

  for (const step of steps) {
    const before = rig.events.length;
    const at = Date.now();

    rig.controller.mutateTelemetry(step.patch as TelemetryPatch);
    rig.controller.tickOnce();

    for (let elapsed = 0; elapsed < (step.holdMs ?? 0); elapsed += TICK_MS) {
      vi.advanceTimersByTime(TICK_MS);
      rig.controller.tickOnce();
    }

    rig.trace.push({
      events: rig.events.slice(before),
      formation: getRollingStartFormation(),
      lineup: getPaceLineup(),
      at,
    });
  }
}

/** The index of the one step whose patch `matches` — failing loudly when there is none, or more than one. */
function stepWhere(steps: readonly TelemetryStep[], what: string, matches: (step: TelemetryStep) => boolean): number {
  const found = steps.flatMap((step, index) => (matches(step) ? [index] : []));

  expect(found, `steps that are "${what}"`).toHaveLength(1);

  return found[0] ?? -1;
}

/** Where the pace car is on the lap in a step's patch, or `undefined` when the step does not move it. */
function paceCarPct(step: TelemetryStep): number | undefined {
  const perCar = step.patch.CarIdxLapDistPct;

  return Array.isArray(perCar) ? (perCar[FORMATION_PACE_CAR_IDX] as number) : undefined;
}

/** Whether a step carries a replay-mode flag, either way — the bracket's two steps. */
function isBracketStep(step: TelemetryStep): boolean {
  return "IsReplayPlaying" in step.patch;
}

beforeEach(() => {
  initializeEventBus(silentLogger);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetSimEventsIracing();
  _resetEventBus();
});

describe("the rolling-start shortcuts (issue #1167)", () => {
  it("are grouped and labelled as the reference voice's script names them", () => {
    // A script entry's `test` line is what a pack author follows to hear the
    // entry, so the group and label it names have to be a button that exists.
    const named = [FORMATION, PACE_CAR, LINEUP_CHANGED, ONE_LAP].map((id) => {
      const { category, label } = shortcutOf(id);

      return `${category} → ${label}`;
    });

    expect(named).toEqual([
      "Rolling Start → Formation (oval, two laps)",
      "Rolling Start → Pace car moving",
      "Rolling Start → Car ahead changed",
      "Flags → One Lap to Green",
    ]);

    const script = defaultScript as CalloutScript;
    const testOf = (scenarioId: string): string => script.scenarios[scenarioId]?.test ?? "";

    expect(testOf("pit-crew.rolling-start-pace-car")).toContain(`Harness → Scenario Shortcuts → ${named[0]}`);
    expect(testOf("pit-crew.rolling-start-pace-car")).toContain(named[1]);
    expect(testOf("pit-crew.rolling-start-lineup-changed")).toContain(`Harness → Scenario Shortcuts → ${named[0]}`);
    expect(testOf("pit-crew.rolling-start-lineup-changed")).toContain(named[2]);
    expect(testOf("pit-crew.flag-one-pace-lap-to-go")).toContain(`Harness → Scenario Shortcuts → ${named[0]}`);
    expect(testOf("pit-crew.flag-one-pace-lap-to-go")).toContain(`Harness → ${named[3]}`);
  });

  it("keeps the whole formation first in its group, and no button under the old label", () => {
    const rollingStart = SCENARIO_SHORTCUTS.filter((s) => s.category === "Rolling Start").map((s) => s.id);

    expect(rollingStart).toEqual([FORMATION, PACE_CAR, LINEUP_CHANGED]);
    expect(SCENARIO_SHORTCUTS.some((s) => s.label === "One Pace Lap to Go")).toBe(false);
  });

  it("drive the translator for three of the four, and publish only where its decision cannot be had alone", () => {
    for (const id of [FORMATION, PACE_CAR, LINEUP_CHANGED]) {
      expect(shortcutOf(id).event, id).toBeUndefined();
      expect(stepsOf(id).length, id).toBeGreaterThan(0);
    }

    // The pace-lap decision needs the `ParadeLaps` entry, which is the
    // pace-car cue: "One lap to green" alone has to be published.
    expect(shortcutOf(ONE_LAP)).toMatchObject({ event: "flag.one-pace-lap-to-go.raised", data: {} });
  });

  it("warn in the raw injector that each of their three events is silent when published with no formation running", () => {
    // The injector publishes what it is given and arranges nothing, so its
    // description is the only place a tester learns why the event they fired
    // showed in the log and played no line.
    const noted = EVENT_TEMPLATES.filter((t) => t.description.includes(FORMATION_GATE_NOTE)).map((t) => t.name);

    expect(noted.sort()).toEqual([
      "flag.one-pace-lap-to-go.raised",
      "rollingStart.lineup.changed",
      "rollingStart.pace-car-moving.raised",
    ]);
    expect(FORMATION_GATE_NOTE).toContain("Rolling Start → Formation (oval, two laps)");
    expect(FORMATION_GATE_NOTE).toContain("Flags → One Lap to Green");
  });

  it("refuse to run without a session the grid reads in, or with the mock SDK disconnected", () => {
    expect(shortcutOf(FORMATION).requires).toEqual(["rolling-start-oval-grid", "sdk-connected"]);

    for (const id of [PACE_CAR, LINEUP_CHANGED, ONE_LAP]) {
      expect(shortcutOf(id).requires, id).toEqual(["rolling-start-grid", "sdk-connected"]);
    }
  });

  it.each(SESSION_PRESETS)(
    "are permitted exactly where the running translator reads their grid as the precondition foresaw (%s)",
    (preset) => {
      // The precondition is a dry run: it asks the lineup reader about the
      // grid before a step is posted. This is the wet one — the button's own
      // bracket, through the translator, on the same session — and the two
      // must agree on every preset, or a refusal (or a pass) is about a grid
      // the button does not form.
      const rig = startRig(preset, null);
      const state = {
        sessionInfo: readPreset("session", preset) as Record<string, unknown>,
        isConnected: true,
        telemetry: rig.controller.getState().telemetry,
      };
      const foresawGrid = checkShortcutPreconditions(["rolling-start-grid"], state) === null;
      const foresawLane = checkShortcutPreconditions(["rolling-start-oval-grid"], state) === null;

      drive(rig, stepsOf(FORMATION).filter(isBracketStep));

      const lineup = getPaceLineup();

      expect(lineup?.anchor === "grid").toBe(foresawGrid);
      expect(lineup?.anchor === "grid" && lineup.line !== null).toBe(foresawLane);
      // Both answers occur across the presets, so neither side is a constant.
      expect([foresawGrid, foresawLane]).toEqual(
        { "race-oval": [true, true], race: [true, false] }[preset] ?? [false, false],
      );
    },
  );

  it("open inside a replay-mode bracket that puts the driver in the car on the grid, and tick it through", () => {
    // Everything a button has to ARRANGE is set while `IsReplayPlaying` is
    // true, where the translator publishes nothing; the ticks make the
    // translator see the bracket open and close whatever the mock's tick rate.
    for (const id of [FORMATION, PACE_CAR, LINEUP_CHANGED, ONE_LAP]) {
      const [settle, open, close] = stepsOf(id);

      // A race already under way, shown first: it settles the translator's
      // fresh-connect check without the race-start brief (see the control in
      // the last block).
      expect(settle, id).toEqual({ patch: { IsReplayPlaying: true, SessionState: SessionState.Racing }, tick: true });
      expect(open.patch, id).toMatchObject({
        IsReplayPlaying: true,
        IsOnTrack: true,
        OnPitRoad: false,
        PlayerCarInPitStall: false,
        PlayerTrackSurface: TrkLoc.OnTrack,
        CarIdxLapCompleted: null,
      });
      expect(Object.keys(open.patch), id).toEqual(
        expect.arrayContaining([
          "SessionState",
          "SessionFlags",
          "Speed",
          "PaceMode",
          "CarIdxPaceLine",
          "CarIdxPaceRow",
          "CarIdxLapDistPct",
          "CarIdxTrackSurface",
        ]),
      );
      expect(open.tick, id).toBe(true);
      expect(close, id).toEqual({ patch: { IsReplayPlaying: false }, holdMs: expect.any(Number), tick: true });
      expect(close.holdMs ?? 0, id).toBeGreaterThan(REPLAY_EXIT_GRACE_MS);
      expect(stepsOf(id).filter(isBracketStep), id).toHaveLength(3);
    }
  });
});

describe('"Rolling Start → Formation (oval, two laps)"', () => {
  const steps = stepsOf(FORMATION);

  const warmup = stepWhere(steps, "Warmup", (s) => s.patch.SessionState === SessionState.Warmup);
  const parade = stepWhere(steps, "the ParadeLaps entry", (s) => s.patch.SessionState === SessionState.ParadeLaps);
  const paceCarOut = stepWhere(
    steps,
    "the pace car reaching the road",
    (s) =>
      !isBracketStep(s) &&
      Array.isArray(s.patch.CarIdxTrackSurface) &&
      s.patch.CarIdxTrackSurface[FORMATION_PACE_CAR_IDX] === TrkLoc.OnTrack &&
      s.patch.CarIdxTrackSurface[FORMATION_FOLLOW_CAR_IDX] === TrkLoc.OnTrack,
  );
  const ghost = stepWhere(
    steps,
    "the car ahead leaving the world with its row",
    (s) =>
      Array.isArray(s.patch.CarIdxTrackSurface) &&
      s.patch.CarIdxTrackSurface[FORMATION_FOLLOW_CAR_IDX] === TrkLoc.NotInWorld &&
      s.patch.CarIdxTrackSurface[FORMATION_PACE_CAR_IDX] === TrkLoc.OnTrack,
  );
  const closeUp = ghost + 1;
  const greenHeld = stepWhere(
    steps,
    "green held",
    (s) =>
      typeof s.patch.SessionFlags === "number" &&
      (s.patch.SessionFlags & Flags.GreenHeld) !== 0 &&
      (s.patch.SessionFlags & Flags.Green) === 0,
  );
  const paceCarOff = stepWhere(
    steps,
    "the pace car leaving",
    (s) =>
      !isBracketStep(s) &&
      Array.isArray(s.patch.CarIdxTrackSurface) &&
      s.patch.CarIdxTrackSurface[FORMATION_PACE_CAR_IDX] === TrkLoc.AproachingPits,
  );
  const go = stepWhere(steps, "the green", (s) => !isBracketStep(s) && s.patch.SessionState === SessionState.Racing);

  /** The pace car's lap: where the bracket stages it, then every step that moves it, in order. */
  const paceLap = steps.flatMap((step, index) => {
    const pct = paceCarPct(step);

    return pct !== undefined ? [{ index, pct }] : [];
  });
  /** Its two start/finish crossings: the grid release, and the end of its first full lap. */
  const crossings = paceLap.filter((leg, i) => i > 0 && leg.pct < paceLap[i - 1].pct).map((leg) => leg.index);

  it("replays the captured session states and SessionFlags, in order", () => {
    // `sim-events-iracing`'s `rolling-start-formation-20260917.json`, cut from
    // `local/telemetry-watch-20260917-191825-092.jsonl`. `>>> 0` reads a patch
    // back as the unsigned value the capture's hex is written in: StartGo is
    // the sign bit.
    // From the second step: the first is the bracket's own, a race already
    // under way shown to the translator before the grid.
    const states = steps.slice(1).flatMap((s) => (s.patch.SessionState === undefined ? [] : [s.patch.SessionState]));
    const flags = steps.flatMap((s) => (typeof s.patch.SessionFlags === "number" ? [s.patch.SessionFlags >>> 0] : []));

    expect(states).toEqual([
      SessionState.GetInCar,
      SessionState.Warmup,
      SessionState.ParadeLaps,
      SessionState.Racing,
    ]);
    expect(flags).toEqual([
      0x10040200, // GetInCar — OneLapToGreen | Servicible | StartHidden
      0x20040200, // Warmup, and all of ParadeLaps — StartReady
      0x20040600, // + GreenHeld
      0x80040604, // the green tick — Green | StartGo, the formation's bits still up
      0x80040004, // a tick later
      0x10040004, // the gantry hides
      0x10040000, // no flag shown
    ]);
  });

  it("runs its beats in the capture's order, with the two it adds between the pace car moving and the green being held", () => {
    expect([warmup, parade, paceCarOut, ...crossings, ghost, closeUp, greenHeld, paceCarOff, go]).toEqual(
      [warmup, parade, paceCarOut, ...crossings, ghost, closeUp, greenHeld, paceCarOff, go].sort((a, b) => a - b),
    );
    expect(crossings).toHaveLength(2);
    expect(steps[closeUp].patch).toHaveProperty("CarIdxPaceRow");
  });

  it("has the lineup formed up from the first step, on the grid frame — seventh, on the inside, behind car 8", () => {
    const rig = startRig();

    drive(rig, steps.slice(0, parade));

    // `GetInCar`, then `Warmup`: no formation yet, and the whole lineup there
    // from the step that forms the grid up (the second; see the bracket).
    expect(rig.trace.length).toBeGreaterThanOrEqual(4);
    expect(rig.trace[0].formation).toBeNull();

    for (const step of rig.trace.slice(1)) {
      expect(step.formation).toBeNull();
      expect(step.lineup).toMatchObject({
        anchor: "grid",
        lineupPosition: 7,
        line: "inside",
        doubleFile: true,
        followCarIdx: FORMATION_FOLLOW_CAR_IDX,
        followCarNumber: "8",
        isLeader: false,
        followsPaceCar: false,
      });
    }

    expect(rig.events).toEqual([]);
  });

  it("makes the translator publish the formation's seven events, each on the step that causes it, and nothing else", () => {
    const rig = startRig();

    drive(rig, steps);

    const published = rig.trace.flatMap((step, index) => step.events.map((event) => ({ event, index })));

    expect(published).toEqual([
      { event: "rollingStart.pace-car-moving.raised", index: parade },
      { event: "paceCar.deployed", index: paceCarOut },
      // The pace-lap diff's own decision (#773), on the pace car's SECOND crossing.
      { event: "flag.one-pace-lap-to-go.raised", index: crossings[1] },
      { event: "rollingStart.lineup.changed", index: ghost },
      { event: "flag.green-held.raised", index: greenHeld },
      { event: "paceCar.off", index: paceCarOff },
      { event: "startLight.start-go.raised", index: go },
    ]);
  });

  it("holds ONE formation from the ParadeLaps entry until the green is held, and none on either side", () => {
    // What all three formation callouts ask at speak time. It has to be up
    // for every step a formation call can speak in — the pace-car call, the
    // one-lap-to-green call, the change — and down from the green-held step
    // on, where a formation call still waiting must be refused.
    const rig = startRig();

    drive(rig, steps);

    const running = rig.trace.map((step) => step.formation !== null);

    expect(running).toEqual(steps.map((_step, index) => index >= parade && index < greenHeld));

    const ids = new Set(rig.trace.flatMap((step) => (step.formation === null ? [] : [step.formation.id])));

    expect(ids.size).toBe(1);

    // The first follow car is the grid's, read on the entry tick, and a change
    // does not move it: it is what a change is judged against before anything
    // has been named.
    for (const step of rig.trace.slice(parade, greenHeld)) {
      expect(step.formation?.firstFollowCarIdx).toBe(FORMATION_FOLLOW_CAR_IDX);
    }
  });

  it("takes the pace car across the line twice, and only the crossing that ends a full lap is one pace lap to go", () => {
    // The release crossing sits at next to nothing accrued; the diff's guard
    // is half a lap. The values are the button's own.
    const [release, completion] = crossings;
    const accruedBefore = (crossing: number): number => {
      let accrued = 0;

      for (let i = 1; i < paceLap.length && paceLap[i].index < crossing; i++) {
        const delta = paceLap[i].pct - paceLap[i - 1].pct;

        accrued += delta >= 0 ? delta : delta + 1;
      }

      return accrued;
    };

    expect(accruedBefore(release)).toBeLessThan(0.1);
    expect(accruedBefore(completion)).toBeGreaterThan(0.5);
    expect(completion).toBeGreaterThan(release);
    // On the road for both: a pace car on the pit-approach surface is not tracked.
    expect(paceCarOut).toBeLessThan(release);
    expect(completion).toBeLessThan(paceCarOff);
  });

  it("control: with the pace car's lap taken out, the same run never reports one pace lap to go", () => {
    // Without this the event above could be coming from the `ParadeLaps`
    // entry, a flag, or the player's own lap distance — anything but the
    // crossing the button is built to drive.
    const rig = startRig();
    const parked = steps.map((step) => {
      if (isBracketStep(step) || paceCarPct(step) === undefined) return step;

      const perCar = [...(step.patch.CarIdxLapDistPct as number[])];

      perCar[FORMATION_PACE_CAR_IDX] = 0.99;

      return { ...step, patch: { ...step.patch, CarIdxLapDistPct: perCar } };
    });

    drive(rig, parked);

    expect(rig.events).toEqual([
      "rollingStart.pace-car-moving.raised",
      "paceCar.deployed",
      "rollingStart.lineup.changed",
      "flag.green-held.raised",
      "paceCar.off",
      "startLight.start-go.raised",
    ]);
  });

  it("drops the car ahead out as the capture showed a car leaving — its row held for a tick, then closed up — and that is ONE change", () => {
    const rig = startRig();

    drive(rig, steps.slice(0, closeUp + 1));

    // Before: behind car 8. On the ghost tick the walk steps over a car that
    // is not in the world, so car 19 is ahead although car 8 still holds its
    // row; the rows closing up changes the player's row, not who is ahead.
    expect(rig.trace[ghost - 1].lineup).toMatchObject({ followCarNumber: "8", line: "inside" });
    expect(steps[ghost].patch).not.toHaveProperty("CarIdxPaceRow");
    expect(rig.trace[ghost].lineup).toMatchObject({
      followCarIdx: FORMATION_NEXT_FOLLOW_CAR_IDX,
      followCarNumber: "19",
      line: "inside",
    });
    expect(rig.trace[closeUp].lineup).toMatchObject({
      followCarIdx: FORMATION_NEXT_FOLLOW_CAR_IDX,
      followCarNumber: "19",
      line: "inside",
    });
    expect(rig.trace[ghost].events).toEqual(["rollingStart.lineup.changed"]);
    expect(rig.trace[closeUp].events).toEqual([]);
    // The change call's own gate: a formation, a pace row, and a car ahead
    // that is not the one the two earlier calls named.
    expect(rig.trace[closeUp].formation).not.toBeNull();
  });

  it("gives every call the time to play before the next trigger, and the change the time to speak before the formation ends", () => {
    // Simulated times on the fake clock. A line and its radio frame run to
    // about four seconds in the reference voice; the green-held line to five.
    const LINE_ALLOWANCE_MS = 3500;
    const rig = startRig();

    drive(rig, steps);

    const at = (index: number): number => rig.trace[index].at;

    // The pace-car call, then the one-lap-to-green call, then the change.
    expect(at(crossings[1]) - at(parade)).toBeGreaterThanOrEqual(LINE_ALLOWANCE_MS);
    expect(at(ghost) - at(crossings[1])).toBeGreaterThanOrEqual(LINE_ALLOWANCE_MS);
    // The change holds before it decides, and must have SPOKEN before the
    // green is held: that step closes the formation, and its gate with it.
    expect(at(greenHeld) - at(ghost)).toBeGreaterThanOrEqual(ROLLING_START_LINEUP_CHANGE_DELAY_MS + LINE_ALLOWANCE_MS);
    expect(at(paceCarOff) - at(greenHeld)).toBeGreaterThanOrEqual(5000);
    expect(at(go) - at(paceCarOff)).toBeGreaterThanOrEqual(2000);

    const total = steps.reduce((sum, step) => sum + (step.holdMs ?? 0), 0);

    expect(total).toBeLessThanOrEqual(45_000);
  });

  it("says nothing as the lineup unwinds under green, where the rows have the formation's own shape", () => {
    // The grid's third car heads line 0 beside the outside front car — read
    // by shape alone it would be told it leads. The translator ended the
    // formation when the green was held and withholds the position from the
    // green tick, so nothing is published and nothing could be said.
    const rig = startRig();

    drive(rig, steps);

    const afterGo = rig.trace.slice(go + 1);

    expect(afterGo.length).toBeGreaterThan(2);
    expect(afterGo.flatMap((step) => step.events)).toEqual([]);
    expect(afterGo.every((step) => step.formation === null)).toBe(true);
    expect(rig.trace[go].lineup).toMatchObject({ lineupPosition: null, anchor: null, isLeader: false });
    expect(
      steps.slice(go + 1).some((s) => Array.isArray(s.patch.CarIdxPaceRow) && s.patch.CarIdxPaceRow.includes(0)),
    ).toBe(true);
  });

  it("ends racing with no flag shown, nobody lined up and its per-car arrays gone, so a second press plays the same run", () => {
    const rig = startRig();

    drive(rig, steps);

    const left = rig.controller.getState().telemetry as Record<string, unknown>;

    expect((left.SessionFlags as number) >>> 0).toBe(RACING_NO_FLAG >>> 0);
    expect(left.SessionState).toBe(SessionState.Racing);
    expect(getPaceLineup()).toBeNull();
    expect(getRollingStartFormation()).toBeNull();
    // The caution buttons count on the telemetry preset carrying no per-car
    // lap progress ("Caution → extra lap" above all).
    expect(left).not.toHaveProperty("CarIdxLapDistPct");
    expect(left).not.toHaveProperty("CarIdxLapCompleted");
    expect(left).not.toHaveProperty("CarIdxTrackSurface");

    const firstPress = rig.events.splice(0);

    drive(rig, steps);

    expect(rig.events).toEqual(firstPress);
    expect(firstPress).toHaveLength(7);
  });

  it.each(TELEMETRY_PRESETS)("plays the same seven events from the %s telemetry preset", (preset) => {
    // The bracket arranges the car and the grid inside replay mode, so
    // nothing of the tester's own telemetry — parked on pit road, in the
    // garage, on the grid — is announced or leaks into the run.
    const rig = startRig("race-oval", preset);

    drive(rig, steps);

    // Entering replay mode closes any active loop the preset left running (a
    // speeding cue, from the pit-road preset's car parked over the limit):
    // the translator's own teardown, and no part of the formation.
    expect(rig.events.filter((event) => event !== "pitSpeeding.ended")).toEqual([
      "rollingStart.pace-car-moving.raised",
      "paceCar.deployed",
      "flag.one-pace-lap-to-go.raised",
      "rollingStart.lineup.changed",
      "flag.green-held.raised",
      "paceCar.off",
      "startLight.start-go.raised",
    ]);
  });
});

describe("the formation's calls on their own", () => {
  /** What the formation looks like to the callouts' gates on the step a call would speak in. */
  function expectFormationBehindCar(step: StepTrace, followCarNumber: string, line: "inside" | null): void {
    expect(step.formation).toMatchObject({ firstFollowCarIdx: FORMATION_FOLLOW_CAR_IDX });
    expect(step.lineup).toMatchObject({ anchor: "grid", followCarNumber, line });
  }

  it.each([
    { preset: "race-oval", line: "inside" as const },
    { preset: "race", line: null },
  ])(
    '"Pace car moving" makes the translator open a formation and fire the cue itself — that event alone ($preset)',
    ({ preset, line }) => {
      const steps = stepsOf(PACE_CAR);
      const parade = stepWhere(steps, "the ParadeLaps entry", (s) => s.patch.SessionState === SessionState.ParadeLaps);
      const rig = startRig(preset);

      drive(rig, steps);

      expect(rig.trace.flatMap((step, index) => step.events.map((event) => ({ event, index })))).toEqual([
        { event: "rollingStart.pace-car-moving.raised", index: parade },
      ]);
      // Seeded in Warmup: no formation until the entry, then one for as long
      // as the line is listened to, and none once the button stands down.
      expect(rig.trace.slice(0, parade).every((step) => step.formation === null)).toBe(true);
      expectFormationBehindCar(rig.trace[parade], "8", line);
      expect(steps[parade].holdMs ?? 0).toBeGreaterThanOrEqual(5000);
      expect(rig.trace.at(-1)?.formation).toBeNull();
    },
  );

  it.each([
    { preset: "race-oval", line: "inside" as const },
    { preset: "race", line: null },
  ])(
    '"Car ahead changed" adopts a formation silently, then makes the translator report ONE change ($preset)',
    ({ preset, line }) => {
      const steps = stepsOf(LINEUP_CHANGED);
      const rig = startRig(preset);

      drive(rig, steps);

      const [, , adopted, ghost, closeUp, standDown] = rig.trace;

      expect(steps).toHaveLength(6);
      expect(rig.events).toEqual(["rollingStart.lineup.changed"]);
      expect(ghost.events).toEqual(["rollingStart.lineup.changed"]);
      // Adopted, not opened: the state without the pace-car cue, behind car 8.
      expectFormationBehindCar(adopted, "8", line);
      // The three things the change call's gate asks, on the step it speaks
      // in: a formation, a pace row, and a car ahead that is not the one last
      // named — nothing has been, so the formation's first follow car.
      expectFormationBehindCar(closeUp, "19", line);
      expect(closeUp.lineup?.followCarIdx).not.toBe(closeUp.formation?.firstFollowCarIdx);
      expect(closeUp.formation?.id).toBe(adopted.formation?.id);
      expect(steps[4].holdMs ?? 0).toBeGreaterThanOrEqual(ROLLING_START_LINEUP_CHANGE_DELAY_MS + 3500);
      expect(standDown.formation).toBeNull();
    },
  );

  it('"One Lap to Green" puts an adopted formation in front of its publish, and the translator publishes nothing of its own', () => {
    const shortcut = shortcutOf(ONE_LAP);
    const rig = startRig();

    drive(rig, shortcut.telemetrySequence ?? []);

    // The state the published event's callout will find: a formation, behind
    // car 8 on the inside — and the pace-lap diff seeded without arming, so
    // the published event is the only one.
    expectFormationBehindCar(rig.trace.at(-1) as StepTrace, "8", "inside");

    drive(rig, shortcut.teardownSequence ?? []);

    expect(rig.events).toEqual([]);
    expect(shortcut.teardownSequence?.[0]).toEqual({ patch: {}, holdMs: expect.any(Number) });
    expect(shortcut.teardownSequence?.[0].holdMs ?? 0).toBeGreaterThanOrEqual(5000);
    expect(rig.trace.at(-1)?.formation).toBeNull();
  });

  it('"One Lap to Green" has the formation adopted before its publish with the tick loop paused', () => {
    // Only the ticks the steps ask for, as `/api/telemetry` gives them: the
    // replay-mode tick, the tick inside the exit grace, and the bare tick
    // after it, on which the translator re-seeds and adopts the formation.
    const rig = startRig();

    for (const step of stepsOf(ONE_LAP)) {
      rig.controller.mutateTelemetry(step.patch as TelemetryPatch);

      if (step.tick === true) rig.controller.tickOnce();

      vi.advanceTimersByTime(step.holdMs ?? 0);
    }

    expect(getRollingStartFormation()).toMatchObject({ firstFollowCarIdx: FORMATION_FOLLOW_CAR_IDX });
    expect(stepsOf(ONE_LAP).at(-1)).toEqual({ patch: {}, tick: true });
    expect(rig.events).toEqual([]);
  });

  it.each([PACE_CAR, LINEUP_CHANGED, ONE_LAP])(
    "%s ends racing with no flag shown and nobody lined up, and plays the same again",
    (id) => {
      const shortcut = shortcutOf(id);
      const press = [...(shortcut.telemetrySequence ?? []), ...(shortcut.teardownSequence ?? [])];
      const rig = startRig();

      drive(rig, press);

      const left = rig.controller.getState().telemetry as Record<string, unknown>;

      // Not a grid before its green: the overtake, gap and position callouts
      // all stand down there, and the next button would inherit that.
      expect(left.SessionState).toBe(SessionState.Racing);
      expect((left.SessionFlags as number) >>> 0).toBe(RACING_NO_FLAG >>> 0);
      expect(getPaceLineup()).toBeNull();
      expect(getRollingStartFormation()).toBeNull();
      expect(left).not.toHaveProperty("CarIdxLapDistPct");
      expect(left).not.toHaveProperty("CarIdxTrackSurface");

      const firstPress = rig.events.splice(0);

      drive(rig, press);

      expect(rig.events).toEqual(firstPress);
    },
  );

  it.each([PACE_CAR, LINEUP_CHANGED, ONE_LAP].flatMap((id) => TELEMETRY_PRESETS.map((preset) => ({ id, preset }))))(
    "$id publishes the same from the $preset telemetry preset",
    ({ id, preset }) => {
      const shortcut = shortcutOf(id);
      const press = [...(shortcut.telemetrySequence ?? []), ...(shortcut.teardownSequence ?? [])];
      const expected: Record<string, SimEventName[]> = {
        [PACE_CAR]: ["rollingStart.pace-car-moving.raised"],
        [LINEUP_CHANGED]: ["rollingStart.lineup.changed"],
        [ONE_LAP]: [],
      };
      const rig = startRig("race-oval", preset);

      drive(rig, press);

      expect(rig.events.filter((event) => event !== "pitSpeeding.ended")).toEqual(expected[id]);
    },
  );

  it("control: without the bracket's first step, a first press on telemetry that names no session state also publishes the race-start brief's trigger", () => {
    // The translator briefs a driver who connects to a race before its green,
    // once, ahead of the replay guard: `session.changed { from: -1 }`. The
    // mock's boot telemetry names no session state, so the grid would be the
    // first one the translator sees — the brief's trigger would ride on the
    // first press of a formation button and on no later one. The bracket's
    // first step, a race already under way, settles that check silently.
    const withoutSettle = stepsOf(PACE_CAR).slice(1);
    const bare = startRig("race-oval", null);

    drive(bare, withoutSettle);

    expect(bare.events).toEqual(["session.changed", "rollingStart.pace-car-moving.raised"]);

    _resetSimEventsIracing();
    _resetEventBus();
    initializeEventBus(silentLogger);

    const settled = startRig("race-oval", null);

    drive(settled, stepsOf(PACE_CAR));

    expect(settled.events).toEqual(["rollingStart.pace-car-moving.raised"]);
  });
});
