import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import { CAUTION_FOLLOW_DELAY_MS, CAUTION_LINEUP_CHANGE_DELAY_MS } from "@iracedeck/audio-scenarios/pit-crew";
import type { CalloutScript } from "@iracedeck/callout-script";
import { _resetEventBus, getEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import {
  Flags,
  PitSvFlags,
  PitSvStatus,
  type SDKController,
  type SessionInfo,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetSimEventsIracing,
  type CautionLineup,
  DAMAGE_DEBOUNCE_MS,
  DAMAGE_INCIDENT_GRACE_MS,
  DAMAGE_REPAIR_MASK,
  getCautionLineup,
  getLatestTelemetry,
  getLivePosition,
  initializeSimEventsIracing,
  isDamageRepairNeeded,
  PIT_APPROACH_COOLDOWN_MS,
  PIT_STATUS_EMPTY_STOP_MAX_MS,
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

  it("leads every counted incident.occurred with incident.scored carrying the same delta, as the translator does (issue #1122)", () => {
    // The pair is the mechanism the qualifying lap-invalidation line wins the
    // Voice bus by, so a shortcut standing for a counted incident publishes
    // both in the translator's order; a 0x report the count never moved for
    // publishes `incident.occurred` alone, since the translator would publish
    // neither and the shortcut only auditions the clip.
    const incidents = SCENARIO_SHORTCUTS.filter((s) => s.event === "incident.occurred");

    expect(incidents.length).toBeGreaterThan(0);

    for (const shortcut of incidents) {
      const delta = (shortcut.data as { delta: number }).delta;

      if (delta > 0) {
        expect(shortcut.precedingEvents, `shortcut "${shortcut.id}"`).toEqual([
          { event: "incident.scored", data: { delta } },
        ]);
      } else {
        expect(shortcut.precedingEvents, `shortcut "${shortcut.id}"`).toBeUndefined();
      }
    }
  });

  it("publishes incident.scored on its own only for a burst the translator could not type (issue #1122)", () => {
    for (const shortcut of SCENARIO_SHORTCUTS) {
      if (shortcut.event !== "incident.scored") continue;

      expect(shortcut.precedingEvents, `shortcut "${shortcut.id}"`).toBeUndefined();
      expect((shortcut.data as { delta: number }).delta, `shortcut "${shortcut.id}"`).toBeGreaterThan(0);
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

  it('"Caution → lineup change" swaps the rows only after two calls have named the first car, and listens past the change hold (#1286)', () => {
    // Since #1286 a change is judged against the car last NAMED, and with the
    // follow callout on it is silent until a call has named one — so a swap
    // that landed before the follow call (its hold, behind the caution
    // announcement) or the two-to-green line could play would leave this
    // button silent by design. The allowance is a generous line plus its
    // radio frame; the clock is the fake one, so these are simulated times.
    const LINE_ALLOWANCE_MS = 3000;
    const { controller, events } = startTranslator();
    const at = new Map<SimEventName, number>();
    const timed: readonly SimEventName[] = [
      "flag.caution-waving.raised",
      "caution.fieldCaught",
      "caution.lineup.changed",
      "caution.oneLapToGreen",
    ];

    for (const name of timed) {
      getEventBus().subscribe(name, () => at.set(name, Date.now()));
    }

    runSequence(controller, stepsOf("flag-caution-lineup-change"));

    /** When the button reported `name` — failing loudly if it never did, rather than comparing against NaN. */
    const timeOf = (name: SimEventName): number => {
      const t = at.get(name);

      expect(t, `"${name}" was never reported`).toBeDefined();

      return t ?? Number.NaN;
    };

    const flag = timeOf("flag.caution-waving.raised");
    const pickup = timeOf("caution.fieldCaught");
    const change = timeOf("caution.lineup.changed");
    const oneToGo = timeOf("caution.oneLapToGreen");

    expect(events.filter((e) => e.event === "caution.lineup.changed")).toHaveLength(1);
    expect(change - flag).toBeGreaterThanOrEqual(CAUTION_FOLLOW_DELAY_MS + LINE_ALLOWANCE_MS);
    expect(change - pickup).toBeGreaterThanOrEqual(LINE_ALLOWANCE_MS);
    expect(oneToGo - change).toBeGreaterThanOrEqual(CAUTION_LINEUP_CHANGE_DELAY_MS + LINE_ALLOWANCE_MS);
  });
});

describe('the "Autofuel takeover (replay)" shortcut (issue #474)', () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "auto-fuel-takeover");
  const steps = shortcut?.telemetrySequence ?? [];

  /**
   * `startTranslator`'s setup (race session, hot-lap telemetry, one seeding
   * tick), recording EVERY event in the catalog rather than a chosen few. The
   * button brackets its own bookkeeping off track so the harness's setup and
   * teardown are seeded rather than spoken; a narrower recorder would not show
   * an autofuel switch, a pit-lane event or a readback the bracket let slip.
   */
  function startRecording(telemetryPreset?: string): { controller: MockSDKController; events: Published[] } {
    const { controller } = startTranslator();

    if (telemetryPreset !== undefined) {
      controller.mutateTelemetry(readPreset("telemetry", telemetryPreset) as TelemetryPatch);
      controller.tickOnce();
    }

    const events: Published[] = [];

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
    }

    return { controller, events };
  }

  const pressAt = steps.findIndex((s) => s.patch.PitSvFlags === PitSvFlags.FuelFill);
  const approachAt = steps.findIndex((s) => s.patch.PlayerTrackSurface === TrkLoc.AproachingPits);
  const takeoverAt = steps.findIndex((s) => s.patch.dpFuelAutoFillActive === 1);
  /** The two replay-mode bookkeeping steps that bracket the run. */
  const seedSteps = steps.filter((s) => s.patch.IsReplayPlaying === true);

  it("drives the translator rather than publishing an event, in the Pit Service category", () => {
    expect(shortcut?.event).toBeUndefined();
    expect(shortcut?.telemetrySequence).toBeDefined();
    expect(shortcut?.category).toBe("Pit Service");
  });

  it("replays the capture's values in its order: the press with autofuel off, the approach alone, then the arming in one step", () => {
    // `local/telemetry-watch-20260919-193233-855.jsonl`, 557.97 → 567.73.
    expect(pressAt).toBeGreaterThan(0);
    expect(approachAt).toBeGreaterThan(pressAt);
    expect(takeoverAt).toBe(approachAt + 1);

    expect(steps[pressAt].patch).toEqual({ PitSvFlags: PitSvFlags.FuelFill, dpFuelFill: 1 });
    expect(steps.slice(0, approachAt).every((s) => s.patch.dpFuelAutoFillActive !== 1)).toBe(true);
    expect(steps[approachAt].patch).toEqual({ PlayerTrackSurface: TrkLoc.AproachingPits });
    expect(steps[takeoverAt].patch).toEqual({
      PitSvFlags: 0,
      dpFuelAutoFillActive: 1,
      dpFuelFill: 0,
      dpFuelAddKg: 0,
      PitSvFuel: 0,
    });
  });

  it("sets the whole world it needs in the opening bracket, and keeps `dpFuelAutoFillEnabled` at 1 throughout, as the capture had it", () => {
    expect(steps[0].patch).toMatchObject({
      IsReplayPlaying: true,
      IsOnTrack: true,
      OnPitRoad: false,
      PlayerCarInPitStall: false,
      PlayerTrackSurface: TrkLoc.OnTrack,
      PitSvFlags: 0,
      dpFuelAutoFillEnabled: 1,
      dpFuelAutoFillActive: 0,
    });
    expect(steps[1].patch).toEqual({ IsReplayPlaying: false });
    expect(steps.slice(1).some((s) => "dpFuelAutoFillEnabled" in s.patch)).toBe(false);
  });

  it("does its own bookkeeping inside a replay-mode bracket, where the translator seeds instead of announcing", () => {
    // Every run has to reset the car and autofuel, and each reset is an edge
    // some diff would announce — `OnPitRoad` going false is `pitLane.exited`,
    // disarming autofuel is an autofuel switch. Replay mode suppresses events
    // and re-seeds every diff on the way out, so both bookkeeping steps carry
    // `IsReplayPlaying: true`, and both disarm rather than arm.
    expect(seedSteps).toHaveLength(2);

    for (const step of seedSteps) expect(step.patch.dpFuelAutoFillActive).toBe(0);

    // The run is live for everything between them, and leaves replay mode last.
    expect(steps.indexOf(seedSteps[0])).toBe(0);
    expect(steps.indexOf(seedSteps[1])).toBe(steps.length - 2);
    expect(steps.at(-1)?.patch).toEqual({ IsReplayPlaying: false });
  });

  it("holds the takeover past the translator's 300 ms fuel debounce, and the approach alone for less than one debounce", () => {
    expect(steps[takeoverAt].holdMs ?? 0).toBeGreaterThan(300);
    expect(steps[approachAt].holdMs ?? 0).toBeGreaterThan(0);
    expect(steps[approachAt].holdMs ?? 0).toBeLessThan(300);
  });

  it("reports the press as the driver's, then the approach readback, then ONE autofuel switch — never a second fuel toggle", () => {
    const { controller, events } = startRecording();

    runSequence(controller, steps);

    expect(events).toEqual([
      { event: "pitService.toggled", data: { service: "fuel", on: true } },
      { event: "pitLane.approaching", data: {} },
      { event: "pitService.readbackRequested", data: { reason: "entry" } },
      { event: "pitService.autoFuelSwitched", data: { on: true, refuel: false } },
    ]);
  });

  /**
   * The four events the button itself produces, in order — what every preset
   * has to end up playing.
   */
  const BUTTON_EVENTS: Published[] = [
    { event: "pitService.toggled", data: { service: "fuel", on: true } },
    { event: "pitLane.approaching", data: {} },
    { event: "pitService.readbackRequested", data: { reason: "entry" } },
    { event: "pitService.autoFuelSwitched", data: { on: true, refuel: false } },
  ];

  it.each([
    // The pit-road preset parks the car over the pit limit, so its speeding
    // cue is looping when the button starts. Entering replay mode closes
    // every active-state loop (`publishActiveStateTeardown`), which is the
    // translator being right rather than the button being noisy: a cue left
    // running would loop over the run. It is the ONLY event any preset adds.
    { preset: "on-pit-road", extra: [{ event: "pitSpeeding.ended", data: {} }] as Published[] },
    { preset: "in-pit-stall", extra: [] as Published[] },
    { preset: "in-garage", extra: [] as Published[] },
    { preset: "off-track", extra: [] as Published[] },
  ])("plays the same four events from the $preset preset — the bracket makes it preset-proof", ({ preset, extra }) => {
    // The review case (#474): from a pit-road preset the button's own reset of
    // `OnPitRoad` used to be a `pitLane.exited` edge, which set the 4.5 s
    // pit-action cooldown — swallowing the press confirmation — and scheduled
    // a "to confirm" recap that landed mid-run. Inside the replay-mode bracket
    // the reset is seeded instead, so every preset plays the run the
    // description promises: no exit, no recap, the press confirmed.
    const { controller, events } = startRecording(preset);

    runSequence(controller, steps);

    expect(events).toEqual([...extra, ...BUTTON_EVENTS]);
    expect(events.filter((e) => e.event === "pitLane.exited")).toEqual([]);
    expect(events.filter((e) => e.event === "pitService.readbackRequested")).toHaveLength(1);
  });

  it("positive control: the same takeover with autofuel left disarmed reads as the driver clearing fuel", () => {
    // Without this the assertion above would be satisfied by a rig in which
    // every fuel flip came out as autofuel's.
    const { controller, events } = startRecording();
    const disarmed = steps.map((s, i) =>
      i === takeoverAt ? { ...s, patch: { ...s.patch, dpFuelAutoFillActive: 0 } } : s,
    );

    runSequence(controller, disarmed);

    expect(
      events.filter((e) => e.event.startsWith("pitService.") && e.event !== "pitService.readbackRequested"),
    ).toEqual([
      { event: "pitService.toggled", data: { service: "fuel", on: true } },
      { event: "pitService.toggled", data: { service: "fuel", on: false } },
    ]);
  });

  it("ends on track with autofuel disarmed and the fuel bit clear, so a second press replays it whole", () => {
    const holdOf = (list: readonly TelemetryStep[]): number => list.reduce((sum, s) => sum + (s.holdMs ?? 0), 0);

    expect(seedSteps[1].patch).toMatchObject({
      PlayerTrackSurface: TrkLoc.OnTrack,
      dpFuelAutoFillActive: 0,
      PitSvFlags: 0,
    });
    // From one run's approach to the next run's is the rest of this run plus
    // the start of the next — the whole sequence. The approach readback is
    // cooled down for this long, and a quicker re-press would lose it.
    expect(holdOf(steps)).toBeGreaterThan(PIT_APPROACH_COOLDOWN_MS);

    const { controller, events } = startRecording();

    runSequence(controller, steps);
    const firstPress = events.splice(0);

    runSequence(controller, steps);

    expect(events).toEqual(firstPress);
    expect(firstPress).toHaveLength(4);
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

describe('the "Nothing To Do (empty stop)" shortcut (issue #1180)', () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "pit-status-empty-stop");
  const steps = shortcut?.telemetrySequence ?? [];
  const inProgressAt = steps.findIndex((s) => s.patch.PlayerCarPitSvStatus === PitSvStatus.InProgress);

  /**
   * The translator started either at boot (the mock's own telemetry, no
   * preset) or as `startTranslator` leaves it (race session, hot-lap), then
   * recording EVERY event in the catalog: the bracket must keep the car's trip
   * into its box silent, so a narrower recorder would hide a pit-lane event or
   * a readback it let slip.
   */
  function startRecording(from: "boot" | "hot-lap"): { controller: MockSDKController; events: Published[] } {
    let controller: MockSDKController;

    if (from === "boot") {
      controller = new MockSDKController();
      controller.setConnected(true);
      initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
      controller.tickOnce();
    } else {
      controller = startTranslator().controller;
    }

    const events: Published[] = [];

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data }));
    }

    return { controller, events };
  }

  it("drives the translator rather than publishing an event, under the label the bundled script's test line names", () => {
    const script = defaultScript as CalloutScript;

    expect(shortcut?.event).toBeUndefined();
    expect(shortcut?.category).toBe("Pit Status");
    expect(shortcut?.label).toBe("Nothing To Do (empty stop)");
    expect(script.scenarios["pit-crew.pit-status-nothing-to-do"]?.test).toMatch(
      /^Harness → Pit Status → Nothing To Do \(empty stop\)\. /,
    );
  });

  it("replays the capture's stop 2: stationary on the stall surface, InProgress for under the empty-stop bound, then None", () => {
    // `local/telemetry-watch-20260919-193233-855.jsonl`, 597.75 → 597.77.
    const live = steps[1];

    expect(steps[0].patch).toMatchObject({
      IsReplayPlaying: true,
      IsOnTrack: true,
      OnPitRoad: true,
      // Still false on the capture's closing tick — the translator reads the surface.
      PlayerCarInPitStall: false,
      PlayerTrackSurface: TrkLoc.InPitStall,
      Speed: 0,
      PlayerCarPitSvStatus: PitSvStatus.None,
    });
    expect(live.patch).toEqual({ IsReplayPlaying: false });
    expect(inProgressAt).toBe(2);
    expect(steps[inProgressAt].patch).toEqual({ PlayerCarPitSvStatus: PitSvStatus.InProgress });
    // Under the translator's bound, or the close is not the empty-stop shape.
    expect(steps[inProgressAt].holdMs ?? 0).toBeLessThan(PIT_STATUS_EMPTY_STOP_MAX_MS);
    expect(steps[inProgressAt + 1].patch).toEqual({ PlayerCarPitSvStatus: PitSvStatus.None });
  });

  it("the translator publishes the InProgress it saw, then the empty-stop release, and nothing else", () => {
    // `statusChanged` mirrors the sim, so the one-tick InProgress is published;
    // it is the in-progress contract's quarter-second hold that keeps it
    // unsaid.
    const { controller, events } = startRecording("hot-lap");

    runSequence(controller, steps);

    expect(events).toEqual([
      { event: "pitService.statusChanged", data: { from: PitSvStatus.None, to: PitSvStatus.InProgress } },
      { event: "pitService.stopEmpty", data: {} },
    ]);
  });

  it("needs no preset: from boot, in the garage, the only addition is the first-time-on-track marker no callout speaks", () => {
    // `driver.firstOnTrack` is detected on replay ticks too, by design (the
    // translator never misses a garage → on-track transition), so the bracket
    // cannot hide it — and it does not need to: nothing in the audio layer
    // subscribes to it.
    const { controller, events } = startRecording("boot");

    runSequence(controller, steps);

    expect(events).toEqual([
      { event: "driver.firstOnTrack", data: {} },
      { event: "pitService.statusChanged", data: { from: PitSvStatus.None, to: PitSvStatus.InProgress } },
      { event: "pitService.stopEmpty", data: {} },
    ]);
  });

  it("plays the same on a second press, and ends on the circuit with no service status", () => {
    const { controller, events } = startRecording("hot-lap");

    runSequence(controller, steps);
    runSequence(controller, steps);

    expect(events.map((e) => e.event)).toEqual([
      "pitService.statusChanged",
      "pitService.stopEmpty",
      "pitService.statusChanged",
      "pitService.stopEmpty",
    ]);
    expect(getLatestTelemetry()).toMatchObject({
      IsReplayPlaying: false,
      IsOnTrack: true,
      OnPitRoad: false,
      PlayerTrackSurface: TrkLoc.OnTrack,
      PlayerCarPitSvStatus: PitSvStatus.None,
    });
  });

  it("positive control: the same stop with InProgress held past the bound is not an empty stop, so no release", () => {
    const { controller, events } = startRecording("hot-lap");
    const longStop = steps.map((s, i) => (i === inProgressAt ? { ...s, holdMs: 1000 } : s));

    runSequence(controller, longStop);

    expect(events).toEqual([
      { event: "pitService.statusChanged", data: { from: PitSvStatus.None, to: PitSvStatus.InProgress } },
    ]);
  });
});

describe("the Telemetry Readout shortcuts (issue #466)", () => {
  const readouts = SCENARIO_SHORTCUTS.filter((s) => s.category === "Telemetry Readout");

  it("offers the auditions the spec lists, in order", () => {
    expect(readouts.map((s) => s.id)).toEqual([
      "readout-fuel-last-lap-liters",
      "readout-fuel-last-lap-gallons",
      "readout-fuel-average",
      "readout-fuel-average-partial",
      "readout-no-data",
      "readout-track-temp",
      "readout-air-temp",
      "readout-fuel-edge",
    ]);
  });

  it("each publishes a well-formed telemetryReadout.requested payload", () => {
    for (const s of readouts) {
      expect(s.event, s.id).toBe("telemetryReadout.requested");

      const data = s.data as { kind: string; value: number | null; unit: string; laps: number | null };
      const isFuel = data.kind === "fuel-last-lap" || data.kind === "fuel-average";

      expect(["fuel-last-lap", "fuel-average", "track-temp", "air-temp"], s.id).toContain(data.kind);
      expect(isFuel ? ["liters", "gallons"] : ["celsius", "fahrenheit"], s.id).toContain(data.unit);
      expect(data.laps === null, s.id).toBe(data.kind !== "fuel-average" || data.value === null);

      if (data.value === null) expect(isFuel, s.id).toBe(true);
    }
  });

  it("the partial average names fewer laps than a full window, and the edge sits at the top of the recorded range", () => {
    const byId = (id: string) => readouts.find((s) => s.id === id)?.data as { value: number; laps: number };

    expect(byId("readout-fuel-average").laps).toBe(5);
    expect(byId("readout-fuel-average-partial").laps).toBe(3);
    expect(Math.round(byId("readout-fuel-edge").value * 10) / 10).toBe(120.9);
  });

  it("every readout entry in the bundled script names one of these buttons", () => {
    const script = defaultScript as CalloutScript;
    const labels = readouts.map((s) => s.label);
    const ids = Object.keys(script.scenarios).filter((id) => id.startsWith("pit-crew.readout-"));

    expect(ids).toHaveLength(5);

    for (const id of ids) {
      const test = script.scenarios[id].test ?? "";
      const named = labels.some((label) => test.startsWith(`Harness → Telemetry Readout → ${label}.`));

      expect(named, `${id}: ${test}`).toBe(true);
    }
  });
});

describe("the incident-and-damage sequences behind a held Voice bus (issue #1211)", () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  type Stamped = Published & { timestamp: number };

  const collision = SCENARIO_SHORTCUTS.find((s) => s.id === "incident-collision-during-spotter-call");
  const qualifying = SCENARIO_SHORTCUTS.find((s) => s.id === "incident-collision-during-spotter-call-qualifying");
  const escalation = SCENARIO_SHORTCUTS.find((s) => s.id === "incident-escalation-while-another-line-plays");
  const damage = SCENARIO_SHORTCUTS.find((s) => s.id === "damage-repair-needed");

  /**
   * Long enough for a damage edge the translator DOES see to be announced:
   * the debounce, the grace and a second of margin.
   */
  const DAMAGE_ANNOUNCE_WINDOW_MS = DAMAGE_DEBOUNCE_MS + DAMAGE_INCIDENT_GRACE_MS + 1000;

  /** What the three sequences are about: the car alongside, the incident burst, and the damage edge. */
  const WATCHED = new Set(["radar.changed", "incident.scored", "incident.occurred", "damage.repairNeeded.raised"]);

  /**
   * The translator as a tester's harness has it at boot — the mock's own
   * default telemetry, in the garage, no preset applied — so the sequences
   * are shown to set up everything they need themselves. Records EVERY event
   * in the catalog with its envelope timestamp, so an event the opening
   * bracket let slip shows up, and so two emits can be pinned to one tick.
   */
  function startAtBoot(): { controller: MockSDKController; events: Stamped[] } {
    const controller = new MockSDKController();
    controller.setConnected(true);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
    controller.tickOnce();

    const events: Stamped[] = [];

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data, timestamp: ev.timestamp }));
    }

    return { controller, events };
  }

  function watched(events: readonly Stamped[]): Published[] {
    return events.filter((e) => WATCHED.has(e.event)).map(({ event, data }) => ({ event, data }));
  }

  /**
   * Everything else the run published, bar `driver.firstOnTrack`: booted in
   * the garage, the car's first live tick on track is that event whatever
   * drives it there, and no callout consumes it.
   */
  function unwatched(events: readonly Stamped[]): string[] {
    return events.map((e) => e.event).filter((name) => !WATCHED.has(name) && name !== "driver.firstOnTrack");
  }

  const COLLISION_EVENTS: Published[] = [
    { event: "radar.changed", data: { from: "clear", to: "left" } },
    { event: "incident.scored", data: { delta: 4 } },
    { event: "incident.occurred", data: { delta: 4, points: 4, type: "collision-car" } },
    { event: "damage.repairNeeded.raised", data: {} },
    { event: "radar.changed", data: { from: "left", to: "clear" } },
  ];

  it("adds the three as translator-driven shortcuts in the Incidents category", () => {
    for (const shortcut of [collision, qualifying, escalation]) {
      expect(shortcut?.event).toBeUndefined();
      expect(shortcut?.telemetrySequence).toBeDefined();
      expect(shortcut?.category).toBe("Incidents");
    }
  });

  it('"Collision during a spotter call" publishes the incident and then the damage while the car is still alongside', () => {
    // Both land between the car arriving and the car clearing — under the
    // spotter's focus floor, which is the point of the button: before #1211
    // both lines were dropped there.
    const { controller, events } = startAtBoot();

    runSequence(controller, collision?.telemetrySequence ?? []);

    expect(watched(events)).toEqual(COLLISION_EVENTS);
    // Nothing but those: the opening bracket seeds the world it sets rather
    // than announcing it.
    expect(unwatched(events)).toEqual([]);

    // The damage edge settles after the burst has flushed, so it waits out
    // the grace and goes out on a later tick than the incident.
    const occurred = events.find((e) => e.event === "incident.occurred");
    const raised = events.find((e) => e.event === "damage.repairNeeded.raised");

    expect(raised?.timestamp).toBeGreaterThan(occurred?.timestamp ?? Infinity);
  });

  it('"Collision during a spotter call" plays the same on a second press — the opening bracket reseeds the count and the repair bits', () => {
    const { controller, events } = startAtBoot();

    runSequence(controller, collision?.telemetrySequence ?? []);
    runSequence(controller, collision?.telemetrySequence ?? []);

    expect(watched(events)).toEqual([...COLLISION_EVENTS, ...COLLISION_EVENTS]);
  });

  it("the qualifying variant is the same telemetry, on a flying qualifying lap no other button latches", () => {
    expect(qualifying?.telemetrySequence).toEqual(collision?.telemetrySequence);
    expect(qualifying?.qualifyingInvalidationSnapshot).toMatchObject({
      sessionType: "qualifying",
      lapLimited: true,
      lapStartedFromPits: false,
      lapCounted: true,
    });

    // The per-lap latch is keyed by (sessionNum, lapCompleted): sharing a lap
    // with a Qualifying Invalidation button would silence one of the two.
    const snapshot = qualifying?.qualifyingInvalidationSnapshot;
    const sharing = SCENARIO_SHORTCUTS.filter(
      (s) =>
        s !== qualifying &&
        s.qualifyingInvalidationSnapshot?.sessionNum === snapshot?.sessionNum &&
        s.qualifyingInvalidationSnapshot?.lapCompleted === snapshot?.lapCompleted,
    );

    expect(sharing.map((s) => s.id)).toEqual([]);
  });

  it("the two race sequences post a race snapshot, so a qualifying snapshot an earlier button left cannot take the burst", () => {
    for (const shortcut of [collision, escalation]) {
      expect(shortcut?.qualifyingInvalidationSnapshot?.sessionType, shortcut?.id).toBe("race");
    }
  });

  it('"Escalation while another line plays" announces the off-track, then the wall hit with its total, then the damage on the escalation flush tick', () => {
    const { controller, events } = startAtBoot();

    runSequence(controller, escalation?.telemetrySequence ?? []);

    expect(watched(events)).toEqual([
      { event: "incident.scored", data: { delta: 1 } },
      { event: "incident.occurred", data: { delta: 1, points: 1, type: "off-track" } },
      { event: "incident.scored", data: { delta: 1 } },
      // Two points — the sequence's total (#938) — though the count moved +1.
      { event: "incident.occurred", data: { delta: 1, points: 2, type: "collision-world" } },
      { event: "damage.repairNeeded.raised", data: {} },
    ]);
    expect(unwatched(events)).toEqual([]);

    // The translator's hold: the damage edge settled with no burst open, the
    // escalation opened one inside the grace, and the damage went out on that
    // burst's flush tick. The collision test above is the positive control —
    // its timestamps differ, so this equality is not a property of the rig.
    const escalated = events.filter((e) => e.event === "incident.occurred")[1];
    const raised = events.find((e) => e.event === "damage.repairNeeded.raised");

    expect(raised?.timestamp).toBe(escalated?.timestamp);
  });

  it('"Damage Detected" leaves the translator knowing the damage the line checks, without announcing it a second time', () => {
    // The line's speakGate (#1288) asks the translator's settled damage state,
    // so the button sets the repair bits — inside a replay-mode bracket, so
    // they are seeded as known damage rather than read as a rising edge.
    const { controller, events } = startAtBoot();

    runSequence(controller, [...(damage?.telemetrySequence ?? []), { patch: {}, holdMs: DAMAGE_ANNOUNCE_WINDOW_MS }]);

    expect(damage?.event).toBe("damage.repairNeeded.raised");
    expect((getLatestTelemetry()?.EngineWarnings ?? 0) & DAMAGE_REPAIR_MASK).toBe(DAMAGE_REPAIR_MASK);
    expect(isDamageRepairNeeded()).toBe(true);
    expect(events.filter((e) => e.event === "damage.repairNeeded.raised")).toEqual([]);
  });

  it("positive control: the same bits set outside the bracket are announced by the translator", () => {
    // Without this the assertion above would pass on a rig that never
    // announced damage at all.
    const { controller, events } = startAtBoot();

    runSequence(controller, [{ patch: { EngineWarnings: DAMAGE_REPAIR_MASK }, holdMs: DAMAGE_ANNOUNCE_WINDOW_MS }]);

    expect(events.filter((e) => e.event === "damage.repairNeeded.raised")).toHaveLength(1);
  });
});

describe('the "Crash into a full-course caution" shortcut (issue #1185)', () => {
  beforeEach(() => {
    initializeEventBus(silentLogger);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSimEventsIracing();
    _resetEventBus();
  });

  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "incident-crash-into-full-course-caution");

  const WATCHED_PREFIXES = ["incident.", "damage.", "caution.", "paceCar.", "flag.caution-waving."];

  /**
   * The race session preset and the hot-lap telemetry preset, as the button's
   * description asks, recording the incident, damage, caution and pace-car
   * events with their envelope timestamps.
   */
  function startRecording(): { controller: MockSDKController; events: (Published & { timestamp: number })[] } {
    const controller = new MockSDKController();
    controller.setSessionInfo(readPreset("session", "race") as SessionInfo);
    controller.mutateTelemetry(readPreset("telemetry", "hot-lap") as Partial<TelemetryData>);
    controller.setConnected(true);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
    controller.tickOnce();

    const events: (Published & { timestamp: number })[] = [];

    for (const name of ALL_EVENT_NAMES) {
      if (!WATCHED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;

      getEventBus().subscribe(name, (ev) => events.push({ event: ev.event, data: ev.data, timestamp: ev.timestamp }));
    }

    return { controller, events };
  }

  const EXPECTED_ORDER = [
    "flag.caution-waving.raised",
    "incident.scored",
    "incident.occurred",
    "caution.lineup.changed",
    "paceCar.deployed",
    "damage.repairNeeded.raised",
  ];

  it("is a translator-driven Incidents shortcut that needs a session preset", () => {
    expect(shortcut?.event).toBeUndefined();
    expect(shortcut?.category).toBe("Incidents");
    expect(shortcut?.requires).toContain("player-car-index");
  });

  it("publishes the caution waving, the incident burst, the lineup change, the pace car and then the damage", () => {
    const { controller, events } = startRecording();

    runSequence(controller, shortcut?.telemetrySequence ?? []);

    expect(events.map((e) => e.event)).toEqual(EXPECTED_ORDER);
    expect(events.find((e) => e.event === "incident.occurred")?.data).toEqual({
      delta: 4,
      points: 4,
      type: "collision-car",
    });
    // The field re-forms behind car 7, as in "Caution → lineup change".
    expect(events.find((e) => e.event === "caution.lineup.changed")?.data).toMatchObject({
      followCarIdx: 9,
      followCarNumber: "7",
    });

    // Caution, lineup change and pace car all land inside about 2.5 s.
    const stamp = (name: string) => events.find((e) => e.event === name)?.timestamp ?? NaN;

    expect(stamp("paceCar.deployed") - stamp("flag.caution-waving.raised")).toBeLessThanOrEqual(2500);
    expect(stamp("damage.repairNeeded.raised")).toBeGreaterThan(stamp("incident.occurred"));
  });

  it("plays the same on a second press — the opening bracket resets the pace car, the flags and the count", () => {
    const { controller, events } = startRecording();

    runSequence(controller, shortcut?.telemetrySequence ?? []);
    runSequence(controller, shortcut?.telemetrySequence ?? []);

    expect(events.map((e) => e.event)).toEqual([...EXPECTED_ORDER, ...EXPECTED_ORDER]);
  });
});
