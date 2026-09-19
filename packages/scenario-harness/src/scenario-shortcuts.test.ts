import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
import { Flags, type SDKController, type SessionInfo, type TelemetryData } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  type CautionLineup,
  getCautionLineup,
  getLivePosition,
  initializeSimEventsIracing,
  YELLOW_CLEARED_HOLD_MS,
} from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import { SCENARIO_SHORTCUTS, type TelemetryStep } from "./scenario-shortcuts.js";

type Published = { event: string; data: unknown };

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

function readPreset(kind: "session" | "telemetry", name: string): unknown {
  return JSON.parse(readFileSync(join(PRESETS_DIR, kind, `${name}.json`), "utf8"));
}

/**
 * Drives the real translator with a telemetry sequence, exactly as the UI's
 * shortcut button does: patch, then tick for `holdMs` of simulated time.
 *
 * The ticking inside the hold is not decoration. The validated clear resolves
 * on whichever TICK first finds the hold window elapsed, so a sequence that
 * only advanced the clock would never let it fire — and the assertion that no
 * cleared event arrives would pass for the wrong reason. The positive control
 * below is what proves it can.
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
 * Starts the translator the way a tester sets the harness up before pressing
 * the button — a session preset and the hot-lap telemetry preset, as the
 * shortcut's description asks — then records every flag, start-light and
 * caution event from that point on. `caution.` and `paceCar.` are included
 * alongside `flag.`/`startLight.` because issue #1127 moved the caution
 * sequence's own reporting onto that namespace — `flag.yellow.raised` and
 * `startLight.start-go.raised` no longer speak for a caution pickup or a
 * restart, `caution.fieldCaught` and `caution.restarted` do, and a recorder
 * that only watched the first two would show a caution running SILENT.
 * Whatever the presets themselves produce on the seeding tick is not the
 * button's doing, so it is not recorded.
 *
 * The session preset is a parameter because the caution lineup's inside/outside
 * lane is answered only on an oval, and `race` is a road course — see the
 * `race-oval` describe block below.
 */
function startTranslator(sessionPreset = "race"): { controller: MockSDKController; events: Published[] } {
  const controller = new MockSDKController();
  controller.setSessionInfo(readPreset("session", sessionPreset) as SessionInfo);
  controller.mutateTelemetry(readPreset("telemetry", "hot-lap") as Partial<TelemetryData>);
  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);

  // Seed the translator's diff state at the presets, with no flag shown.
  controller.tickOnce();

  const events: Published[] = [];

  for (const name of ALL_EVENT_NAMES) {
    if (
      !name.startsWith("flag.") &&
      !name.startsWith("startLight.") &&
      !name.startsWith("caution.") &&
      !name.startsWith("paceCar.")
    ) {
      continue;
    }

    getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
  }

  return { controller, events };
}

describe("SCENARIO_SHORTCUTS", () => {
  it("gives every shortcut a unique id", () => {
    const ids = SCENARIO_SHORTCUTS.map((s) => s.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every shortcut something to drive — a bus event or a telemetry sequence", () => {
    for (const shortcut of SCENARIO_SHORTCUTS) {
      expect(shortcut.event ?? shortcut.telemetrySequence, `shortcut "${shortcut.id}" drives nothing`).toBeDefined();
    }
  });
});

describe('the "Caution → restart" shortcut (issue #1127)', () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "flag-caution-restart");
  const steps = shortcut?.telemetrySequence ?? [];

  it("drives the translator rather than publishing an event", () => {
    // Publishing `flag.yellow.cleared` would speak the line whatever the
    // translator decided, which is the opposite of what this button asks.
    expect(shortcut?.event).toBeUndefined();
    expect(shortcut?.telemetrySequence).toBeDefined();
  });

  it("replays the SessionFlags of the caution and restart captured at an oval, in order", () => {
    // `local/telemetry-watch-20260917-191825-092.jsonl` (Homestead-Miami, AI
    // race, `!yellow`, double-file restart). `>>> 0` reads the patch back as
    // the unsigned value the capture's hex is written in — StartGo is the sign
    // bit, so the restart patch is a negative number on the wire.
    // The checkpoint step moves only the player's lap distance, so it carries
    // no flags and is not a flag state of the capture.
    const flagSteps = steps.filter((s) => s.patch.SessionFlags !== undefined);

    expect(flagSteps).toHaveLength(steps.length - 1);
    expect(flagSteps.map((s) => (s.patch.SessionFlags as number) >>> 0)).toEqual([
      0x10048000, // CautionWaving
      0x10044000, // Caution
      0x10044200, // Caution + OneLapToGreen
      0x10044600, // Caution + OneLapToGreen + GreenHeld
      0x80040004, // Green + StartGo — the restart
      0x10040004, // Green
      0x10040000, // no flag shown
    ]);
  });

  it("patches only the fields the caution sequence is documented to drive", () => {
    // Grown from a bare `SessionFlags` replay (issue #1127): the first step
    // also carries the pace lineup and pace mode so the follow-car lines have
    // something to read, and the one-to-go step the per-car lap progress the
    // race position is ranked from — nothing here permits another,
    // undocumented key to creep in unnoticed.
    const ALLOWED_PATCH_KEYS = new Set([
      "SessionFlags",
      "CarIdxPaceLine",
      "CarIdxPaceRow",
      "PaceMode",
      "LapDistPct",
      "CarIdxLapCompleted",
      "CarIdxLapDistPct",
    ]);

    expect(steps.every((s) => Object.keys(s.patch).every((key) => ALLOWED_PATCH_KEYS.has(key)))).toBe(true);
  });

  it("gives the canonical order the per-car lap progress it ranks by at one to go, and takes it away at the end", () => {
    // The position line speaks the RACE position (`getLivePosition()`), which
    // the hot-lap preset alone cannot answer — it carries no per-car arrays.
    // Patched at the one-to-go step, not the throw, so the crossing count
    // before it still sees no canonical order ("Caution → extra lap" rests on
    // that), and deleted at the end so the next press starts from the preset.
    const oneToGo = steps.findIndex((s) => ((s.patch.SessionFlags as number) & Flags.OneLapToGreen) !== 0);
    const last = steps.at(-1);

    expect(oneToGo).toBeGreaterThan(0);
    expect(steps.slice(0, oneToGo).some((s) => "CarIdxLapDistPct" in s.patch)).toBe(false);
    expect(Array.isArray(steps[oneToGo].patch.CarIdxLapCompleted)).toBe(true);
    expect(Array.isArray(steps[oneToGo].patch.CarIdxLapDistPct)).toBe(true);
    expect(last?.patch).toMatchObject({ CarIdxLapCompleted: null, CarIdxLapDistPct: null });
  });

  it("stays under half a minute, and listens past the validated-clear window after the restart", () => {
    const holdOf = (list: readonly TelemetryStep[]): number => list.reduce((sum, s) => sum + (s.holdMs ?? 0), 0);
    const restartAt = steps.findIndex((s) => ((s.patch.SessionFlags as number) & Flags.StartGo) !== 0);

    expect(restartAt).toBeGreaterThan(0);
    expect(holdOf(steps)).toBeLessThanOrEqual(30_000);
    // The cleared line this button exists to NOT hear would land this long
    // after the restart tick, so the button has to still be listening then.
    expect(holdOf(steps.slice(restartAt))).toBeGreaterThan(YELLOW_CLEARED_HOLD_MS);
  });

  it("reports the caution-waving, the pickup, one-to-go, green-held and the restart — never the yellow scope or the start-go line", () => {
    const { controller, events } = startTranslator();

    runSequence(controller, steps);
    // Well past the validated-clear window with the sequence finished — a
    // cleared line arriving late is the same bug a beat later.
    runSequence(controller, [{ patch: {}, holdMs: 10_000 }]);

    // `flag.yellow.raised {scope:"full"}` does NOT fire for the pickup: the
    // static caution rising here is the pace car catching the field it
    // already waved at, not a fresh yellow — `caution.fieldCaught` is what
    // reports it (`diff/flags.ts`'s `episodeAlreadyFullCourse` gate).
    // `startLight.start-go.raised` does NOT fire at the restart either: the
    // tick carries `StartGo` same as a race start would, but
    // `state.cautionPhase` is still an active caution phase when
    // `diffStartLights` reads it (it runs before `diffCaution` ends the
    // episode on the very same tick), so the gantry line stands down and
    // `caution.restarted` speaks for the restart instead. No
    // `flag.green.raised` either: a green that ends a caution episode is the
    // restart's to announce, start signal or not.
    expect(events).toEqual([
      { event: "flag.caution-waving.raised", data: {} },
      { event: "caution.fieldCaught", data: {} },
      { event: "caution.oneLapToGreen", data: {} },
      { event: "caution.lastLapCheckpoint", data: {} },
      { event: "flag.green-held.raised", data: {} },
      { event: "caution.restarted", data: {} },
    ]);
  });

  it("drives the player's lap distance through the last lap's checkpoint, so the position line has its moment", () => {
    // The hot-lap preset parks the car at 0.42 — past the 35% checkpoint — so
    // the button has to take it back below and carry it through after one to
    // go. The control run strips those patches: the same flags, no distance,
    // and the checkpoint must then NOT fire, or this test would pass against
    // a translator that fired it on the flag alone.
    const withDistance = startTranslator();

    runSequence(withDistance.controller, steps);

    expect(withDistance.events.filter((e) => e.event === "caution.lastLapCheckpoint")).toEqual([
      { event: "caution.lastLapCheckpoint", data: {} },
    ]);

    _resetSimEventsIracing();
    _resetEventBus();
    initializeEventBus(silentLogger);

    const flagsOnly = startTranslator();
    const stripped = steps.map((s) => {
      const { LapDistPct: _dropped, ...patch } = s.patch;

      return { ...s, patch };
    });

    expect(stripped.some((s, i) => Object.keys(s.patch).length !== Object.keys(steps[i].patch).length)).toBe(true);
    runSequence(flagsOnly.controller, stripped);

    expect(flagsOnly.events.filter((e) => e.event === "caution.lastLapCheckpoint")).toEqual([]);
  });

  it("ranks the player 7th in the RACE by the time the position line fires — what it now speaks — and nobody before one to go", () => {
    // `caution.racePosition` reads `getLivePosition()`, so this is the number
    // the description promises ("We're currently seven"). The control half:
    // before the one-to-go step the canonical order ranks nobody, which is the
    // premise "Caution → extra lap" counts its crossings on.
    const { controller } = startTranslator();
    const oneToGo = steps.findIndex((s) => ((s.patch.SessionFlags as number) & Flags.OneLapToGreen) !== 0);

    runSequence(controller, steps.slice(0, oneToGo));

    expect(getLivePosition()).toBeNull();

    runSequence(controller, steps.slice(oneToGo, oneToGo + 2));

    expect(getLivePosition()).toMatchObject({ position: 7, isMultiClass: false });

    runSequence(controller, steps.slice(oneToGo + 2));

    expect(getLivePosition()).toBeNull();
  });

  it("ends with no flag shown, so a second press plays the same sequence again", () => {
    const { controller, events } = startTranslator();

    runSequence(controller, steps);
    const firstPress = events.splice(0);

    runSequence(controller, steps);

    expect(events).toEqual(firstPress);
    expect(firstPress).not.toEqual([]);
  });

  it("positive control: a LOCAL yellow driven the same way still reports its clear", () => {
    // Without this the assertion above would be satisfied by a rig that can
    // never observe `flag.yellow.cleared` at all — a broken harness and a
    // fixed translator look identical from the negative test alone.
    const { controller, events } = startTranslator();

    runSequence(controller, [
      { patch: { SessionFlags: Flags.Yellow }, holdMs: 1000 },
      { patch: { SessionFlags: 0 }, holdMs: 10_000 },
    ]);

    expect(events).toEqual([
      { event: "flag.yellow.raised", data: { scope: "local" } },
      { event: "flag.yellow.cleared", data: {} },
    ]);
  });
});

describe('the "race-oval" session preset (issue #1127)', () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "flag-caution-restart");

  /**
   * The step that lines the field up: the only one carrying `CarIdxPaceLine` /
   * `CarIdxPaceRow` / `PaceMode`, which is everything `getCautionLineup()`
   * needs. Taken from the shortcut rather than written out, so a lineup the
   * button stops driving can never keep passing here.
   */
  const lineupStep = shortcut?.telemetrySequence?.slice(0, 1) ?? [];

  /**
   * The caution lineup the harness's own button produces, read at the same
   * moment a callout would read it. Everything but the lane is a property of
   * the roster and the pace arrays, which both presets share — `race-oval`
   * changes only `WeekendInfo`.
   */
  function lineupAfterFirstStep(sessionPreset: string): CautionLineup | null {
    // Self-contained, so one test can read BOTH presets: the translator is a
    // singleton that throws on a second `initializeSimEventsIracing`.
    _resetSimEventsIracing();
    _resetEventBus();
    initializeEventBus(silentLogger);

    const { controller } = startTranslator(sessionPreset);

    expect(lineupStep, '"flag-caution-restart" has no first step to drive').toHaveLength(1);
    runSequence(controller, lineupStep);

    return getCautionLineup();
  }

  it("names the lane the double-file restart forms up in", () => {
    // The whole reason this preset exists: `resolveCautionLineup` answers
    // `line` only when the field is double file AND `isOvalTrack(sessionInfo)`
    // is true, which reads `WeekendInfo.Category` first — so on a road-course
    // preset the "take the inside/outside line" wording cannot be auditioned
    // at all, whatever the pace arrays say. Flip this preset's `Category` back
    // to "Road" and this assertion goes from "inside" to null.
    const lineup = lineupAfterFirstStep("race-oval");

    expect(lineup?.line).toBe("inside");
  });

  it("changes nothing about the lineup except the lane the road preset leaves unnamed", () => {
    // The contrast is the point. Both presets carry the same 18-car roster and
    // the same player index, and the button patches the same pace arrays into
    // both, so a lineup that differed anywhere else would mean the new preset
    // had drifted from `race.json` — and an assertion on the lane alone would
    // not catch it.
    const onOval = lineupAfterFirstStep("race-oval");
    const onRoad = lineupAfterFirstStep("race");

    expect(onRoad).toEqual({ ...onOval, line: null });
    // `line` is named here as well as in the test above, so this one also goes
    // red if the preset stops reading as an oval — without it, "the same except
    // the lane" is satisfied by two lineups that both name no lane at all.
    expect(onOval).toMatchObject({ line: "inside", followCarNumber: "8", restartPosition: 7, doubleFile: true });
  });
});

describe("the two follow-on caution shortcuts (issue #1127)", () => {
  // Pinned after the code review asked whether "Caution → extra lap" could
  // fire at all: its fixture gives every car lap 5, and had the canonical order
  // ranked some car other than the leader first, the baseline would have come
  // from that car and the leader's advance gone unseen. Driven through the
  // real translator with the presets the buttons ask for, the way the UI does
  // it — so the answer is observed rather than argued.
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  function stepsOf(id: string): readonly TelemetryStep[] {
    const steps = SCENARIO_SHORTCUTS.find((s) => s.id === id)?.telemetrySequence;

    expect(steps, `"${id}" drives no telemetry`).toBeDefined();

    return steps ?? [];
  }

  it('"Caution → extra lap" reports the extra lap — the leader\'s crossing is seen through the lineup fallback', () => {
    // The hot-lap preset carries no per-car lap progress, so the canonical
    // order ranks nobody and `diff/caution.ts` counts crossings in the front of
    // the pace lineup — line 0 row 1, which the fixture makes index 1. The
    // shortcut's JSDoc says exactly that; this is what holds it to it. Give
    // the telemetry preset a `CarIdxLapDistPct` one day and this goes red,
    // because the canonical order would then pick the leader instead.
    const { controller, events } = startTranslator();

    runSequence(controller, stepsOf("flag-caution-extra-lap"));

    expect(events.map((e) => e.event)).toEqual([
      "flag.caution-waving.raised",
      "caution.fieldCaught",
      "caution.extraLap",
      "caution.oneLapToGreen",
      "caution.lastLapCheckpoint",
      "caution.restarted",
    ]);
  });

  it('"Caution → extra lap" reports the extra lap on a SECOND press too — its fixed lap values sit below the first run\'s (R8)', () => {
    // The translator's crossing baseline used to be a high-water mark carried
    // across episodes: after the first press it sat at 7, the second press's
    // pickup clamped to it, and the leader's 5 → 7 was never a crossing. The
    // reviewer reproduced the lost extra lap against the built dist.
    const { controller, events } = startTranslator();

    runSequence(controller, stepsOf("flag-caution-extra-lap"));
    runSequence(controller, stepsOf("flag-caution-extra-lap"));

    expect(events.filter((e) => e.event === "caution.extraLap")).toHaveLength(2);
    expect(events.filter((e) => e.event === "caution.restarted")).toHaveLength(2);
  });

  it('"Caution → lineup change" reports the car ahead changing, once, naming the new car', () => {
    const { controller, events } = startTranslator();

    runSequence(controller, stepsOf("flag-caution-lineup-change"));

    expect(events.map((e) => e.event)).toEqual([
      "flag.caution-waving.raised",
      "caution.fieldCaught",
      "caution.lineup.changed",
      "caution.oneLapToGreen",
      "caution.lastLapCheckpoint",
      "caution.restarted",
    ]);
    // Index 6 (car 11) and index 9 (car 7) swap rows, so the player at row 7
    // is now behind car 7 — the description promises "...behind car seven".
    expect(events.find((e) => e.event === "caution.lineup.changed")?.data).toMatchObject({
      followCarIdx: 9,
      followCarNumber: "7",
    });
  });
});

describe("the two Tire Wear shortcuts (issue #1108)", () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const report = SCENARIO_SHORTCUTS.find((s) => s.id === "tire-wear-report");
  const stop = SCENARIO_SHORTCUTS.find((s) => s.id === "tire-wear-stop");
  const steps = stop?.telemetrySequence ?? [];

  /** The pit-lane chain the stop drives, plus the report — everything the translator says about a stop. */
  const STOP_EVENTS = new Set([
    "pitLane.approaching",
    "pitLane.entered",
    "pitStall.entered",
    "pitStall.departed",
    "pitLane.exited",
    "pitService.readbackRequested",
    "tireWear.reported",
  ]);

  /**
   * The translator as a tester's harness has it at boot — the mock's own
   * default telemetry, in the garage, with no preset applied — so the button
   * is shown to set up everything the report needs itself.
   */
  function startAtBoot(): { controller: MockSDKController; events: Published[] } {
    const controller = new MockSDKController();
    controller.setConnected(true);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
    controller.tickOnce();

    const events: Published[] = [];

    for (const name of ALL_EVENT_NAMES) {
      if (!STOP_EVENTS.has(name)) continue;

      getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
    }

    return { controller, events };
  }

  /** The report the captured stop's readings make: the sim's L/M/R as inside/middle/outside, mirrored across the car. */
  const CAPTURED_REPORT = {
    corners: {
      lf: { inside: 98.3, middle: 98.4, outside: 99.1, zone: "inside" },
      rf: { inside: 98.6, middle: 98.8, outside: 99.6, zone: "inside" },
      lr: { inside: 98.6, middle: 98.6, outside: 99.0, zone: "inside" },
      rr: { inside: 98.9, middle: 98.9, outside: 99.7, zone: "inside" },
    },
    heaviest: { corner: "lf", zone: "inside" },
  };

  it('"Report after a stop" publishes a well-formed report — each tread its lowest zone, the heaviest the lowest of all', () => {
    // The bundled script's `test` line names this button, so its label is pinned.
    expect(report?.label).toBe("Report after a stop");
    expect(report?.category).toBe("Tire Wear");
    expect(report?.event).toBe("tireWear.reported");

    const data = report?.data as {
      corners: Record<string, { inside: number; middle: number; outside: number; tread: number; zone: string }>;
      heaviest: { corner: string; zone: string };
    };
    let lowest = { corner: "", tread: Infinity };

    for (const [corner, wear] of Object.entries(data.corners)) {
      const zones = { inside: wear.inside, middle: wear.middle, outside: wear.outside };

      expect(wear.tread, corner).toBe(Math.min(...Object.values(zones)));
      expect(zones[wear.zone as keyof typeof zones], corner).toBe(wear.tread);

      if (wear.tread < lowest.tread) lowest = { corner, tread: wear.tread };
    }

    expect(Object.keys(data.corners)).toEqual(["lf", "rf", "lr", "rr"]);
    expect(data.heaviest).toEqual({ corner: lowest.corner, zone: data.corners[lowest.corner].zone });
    // Not the tie-break's first pick, so the closing sentence is audibly the payload's.
    expect(data.heaviest).not.toEqual({ corner: "lf", zone: "inside" });
  });

  it('"Stop replayed from a capture" drives the translator rather than publishing an event', () => {
    expect(stop?.label).toBe("Stop replayed from a capture");
    expect(stop?.category).toBe("Tire Wear");
    expect(stop?.event).toBeUndefined();
    expect(steps.length).toBeGreaterThan(0);
  });

  it("replays the captured stop's transitions in order, refreshing the readings on the stall surface before the car is in its box", () => {
    const surfaceAt = steps.map((s) => s.patch.PlayerTrackSurface);
    const index = (key: string, value: unknown): number => steps.findIndex((s) => s.patch[key] === value);
    const approach = index("PlayerTrackSurface", 2);
    const onPitRoad = index("OnPitRoad", true);
    const stallSurface = index("PlayerTrackSurface", 1);
    const inStall = index("PlayerCarInPitStall", true);
    const outOfStall = steps.findIndex((s, i) => i > inStall && s.patch.PlayerCarInPitStall === false);
    const offPitRoad = steps.findIndex((s, i) => i > onPitRoad && s.patch.OnPitRoad === false);

    expect(surfaceAt[0]).toBe(3);
    expect(0 < approach && approach < onPitRoad && onPitRoad < stallSurface && stallSurface < inStall).toBe(true);
    expect(inStall < outOfStall && outOfStall < offPitRoad).toBe(true);
    // The capture's refresh tick: the stall surface, with PlayerCarInPitStall still false.
    expect(steps[stallSurface].patch).toMatchObject({
      LFwearL: 0.991,
      LFwearM: 0.984,
      LFwearR: 0.983,
      RFwearL: 0.986,
      RFwearM: 0.988,
      RFwearR: 0.996,
      LRwearL: 0.99,
      LRwearM: 0.986,
      LRwearR: 0.986,
      RRwearL: 0.989,
      RRwearM: 0.989,
      RRwearR: 0.997,
    });
    // Before the stop the readings are the unrefreshed ones, so a second press refreshes them again.
    expect(steps[0].patch).toMatchObject({ LFwearL: 1, RRwearR: 1 });
  });

  it("listens past the exit readback's settle window after leaving pit road, and ends on the circuit", () => {
    const onPitRoad = steps.findIndex((s) => s.patch.OnPitRoad === true);
    const offPitRoad = steps.findIndex((s, i) => i > onPitRoad && s.patch.OnPitRoad === false);
    const after = steps.slice(offPitRoad).reduce((sum, s) => sum + (s.holdMs ?? 0), 0);
    const end = Object.assign({}, ...steps.map((s) => s.patch)) as Record<string, unknown>;

    expect(offPitRoad).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(4500);
    expect(steps.reduce((sum, s) => sum + (s.holdMs ?? 0), 0)).toBeLessThanOrEqual(30_000);
    expect(end).toMatchObject({
      IsOnTrack: true,
      PlayerTrackSurface: 3,
      OnPitRoad: false,
      PlayerCarInPitStall: false,
      PlayerCarPitSvStatus: 0,
      EngineWarnings: 0,
      dcPitSpeedLimiterToggle: false,
    });
  });

  it("the translator reports the stop's tire wear right behind the exit readback", () => {
    const { controller, events } = startAtBoot();

    runSequence(controller, steps);

    expect(events.map((e) => e.event)).toEqual([
      "pitLane.approaching",
      "pitService.readbackRequested",
      "pitLane.entered",
      "pitStall.entered",
      "pitStall.departed",
      "pitLane.exited",
      "pitService.readbackRequested",
      "tireWear.reported",
    ]);
    expect(events[6].data).toEqual({ reason: "exit" });

    const reported = events[7].data as { corners: Record<string, Record<string, number | string>> };

    // Percent from fractions, so compare with a tolerance rather than exactly.
    for (const [corner, expected] of Object.entries(CAPTURED_REPORT.corners)) {
      for (const zone of ["inside", "middle", "outside"] as const) {
        expect(reported.corners[corner][zone] as number, `${corner} ${zone}`).toBeCloseTo(expected[zone], 6);
      }

      expect(reported.corners[corner].zone, corner).toBe(expected.zone);
    }

    expect(events[7].data).toMatchObject({ heaviest: CAPTURED_REPORT.heaviest });
  });

  it("reports again on a second press, as a second stop would", () => {
    const { controller, events } = startAtBoot();

    runSequence(controller, steps);
    runSequence(controller, steps);

    expect(events.filter((e) => e.event === "tireWear.reported")).toHaveLength(2);
  });
});
