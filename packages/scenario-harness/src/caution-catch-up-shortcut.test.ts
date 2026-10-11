/**
 * "Flags → Caution → catch-up" against the real translator (issue #1168).
 *
 * `caution.gapOpened` and `caution.gapStillOpen` are decisions the translator
 * makes over time: the player's gap to the car he lines up behind, as a ratio
 * to the pack's own spacing, held past a threshold through a dwell, after the
 * pack has settled behind the pace car — and again thirty seconds on if he is
 * not closing. So the button is pinned by driving it through the translator on
 * the fake clock, recording every event in the catalog, and reading the live
 * gap the two callouts' speak gate reads (`getCautionGap()`) step by step.
 *
 * What it is then HEARD to say is `caution-catch-up-heard.test.ts`.
 */
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { CalloutScript } from "@iracedeck/callout-script";
import { _resetEventBus, getEventBus, initializeEventBus } from "@iracedeck/event-bus";
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
  CATCH_UP_CLEAR_MULTIPLE,
  CATCH_UP_DWELL_MS,
  CATCH_UP_MIN_SPACING_SAMPLES,
  CATCH_UP_RAISE_MULTIPLE,
  CATCH_UP_REMINDER_MS,
  CATCH_UP_SETTLE_MS,
  CATCH_UP_UNJUDGED_TOLERANCE_MS,
  type CautionGap,
  getCautionGap,
  getPaceLineup,
  initializeSimEventsIracing,
} from "@iracedeck/sim-events-iracing";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_EVENT_NAMES, CATCH_UP_GATE_NOTE, EVENT_TEMPLATES } from "./event-names.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import { SCENARIO_SHORTCUTS, type TelemetryStep } from "./scenario-shortcuts.js";
import { checkShortcutPreconditions, type HarnessPreconditionState } from "./shortcut-preconditions.js";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

/** Every telemetry preset the harness ships: the button must play the same from each. */
const TELEMETRY_PRESETS = readdirSync(join(PRESETS_DIR, "telemetry"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

/** The session presets' player: car "42", row 7 of the single-file lineup. */
const PLAYER = 7;

/** The car he lines up behind: car "11", row 6. */
const FOLLOW = 6;

/** `SessionFlags` as racing with no flag shown: pit service open, start lights hidden. */
const RACING_NO_FLAG = Flags.Servicible | Flags.StartHidden;

/** The events one run makes the translator publish, in order. */
const RUN = [
  "flag.caution-waving.raised",
  "caution.fieldCaught",
  "caution.gapOpened",
  "caution.gapStillOpen",
  "caution.restarted",
];

function readPreset(kind: "session" | "telemetry", name: string): unknown {
  return JSON.parse(readFileSync(join(PRESETS_DIR, kind, `${name}.json`), "utf8"));
}

const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === "flag-caution-catch-up");
const steps: readonly TelemetryStep[] = shortcut?.telemetrySequence ?? [];

/** What one step did: the events the translator published during it, when, and the live gap once it had run. */
type StepTrace = {
  events: { event: string; at: number }[];
  gap: CautionGap | null;
  /** The fake clock when the step's patch landed. */
  at: number;
};

type Rig = { controller: MockSDKController; trace: StepTrace[]; events: { event: string; at: number }[] };

/**
 * The translator over the mock SDK, set up as a tester would before pressing:
 * a session preset, a telemetry preset (or the mock's boot telemetry),
 * connected, and seeded. Every event in the catalog is recorded from then on,
 * bar `driver.firstOnTrack` — the one-shot "first time in the car" event no
 * callout consumes.
 */
function startRig(sessionPreset = "race", telemetryPreset: string | null = "hot-lap"): Rig {
  const controller = new MockSDKController();

  controller.setSessionInfo(readPreset("session", sessionPreset) as SessionInfo);

  if (telemetryPreset !== null) {
    controller.mutateTelemetry(readPreset("telemetry", telemetryPreset) as Partial<TelemetryData>);
  }

  controller.setConnected(true);
  initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
  controller.tickOnce();

  const rig: Rig = { controller, trace: [], events: [] };

  for (const name of ALL_EVENT_NAMES) {
    if (name === "driver.firstOnTrack") continue;

    getEventBus().subscribe(name, (ev) => rig.events.push({ event: ev.event, at: Date.now() }));
  }

  return rig;
}

/**
 * Drives the translator through `sequence` the way the UI's button does with
 * the mock's timer running: the patch, then ticks at the mock's own 14 ms for
 * the step's hold. The ticking is the point — the catch-up machine runs per
 * tick on the clock, so a sequence that only advanced the clock would never
 * let a dwell or a reminder come due.
 */
function drive(rig: Rig, sequence: readonly TelemetryStep[]): void {
  const TICK_MS = 14;

  for (const step of sequence) {
    const before = rig.events.length;
    const at = Date.now();

    rig.controller.mutateTelemetry(step.patch as TelemetryPatch);
    rig.controller.tickOnce();

    for (let elapsed = 0; elapsed < (step.holdMs ?? 0); elapsed += TICK_MS) {
      vi.advanceTimersByTime(TICK_MS);
      rig.controller.tickOnce();
    }

    rig.trace.push({ events: rig.events.slice(before), gap: getCautionGap(), at });
  }
}

/**
 * The whole button as the UI and `/api/telemetry` carry it out with the mock's
 * own tick loop running at `tickIntervalMs`: each step's patch, a tick at once
 * only where the step asks for one, then its hold while the loop ticks. Unlike
 * {@link drive}, nothing here ticks more often than the loop does.
 */
function pressAtTickInterval(rig: Rig, tickIntervalMs: number): void {
  rig.controller.setTickInterval(tickIntervalMs);
  rig.controller.start();

  for (const step of steps) {
    rig.controller.mutateTelemetry(step.patch as TelemetryPatch);

    if (step.tick === true) rig.controller.tickOnce();

    vi.advanceTimersByTime(step.holdMs ?? 0);
  }

  // One more tick of the loop, so the last patch has been seen.
  vi.advanceTimersByTime(tickIntervalMs);
  rig.controller.stop();
}

const names = (events: readonly { event: string }[]): string[] => events.map((e) => e.event);

/** The index of the one step whose patch `matches` — failing loudly when there is none, or more than one. */
function stepWhere(what: string, matches: (step: TelemetryStep, index: number) => boolean): number {
  const found = steps.flatMap((step, index) => (matches(step, index) ? [index] : []));

  expect(found, `steps that are "${what}"`).toHaveLength(1);

  return found[0] ?? -1;
}

const flagsOf = (step: TelemetryStep): number =>
  typeof step.patch.SessionFlags === "number" ? step.patch.SessionFlags : 0;
const isBracketStep = (step: TelemetryStep): boolean => "IsReplayPlaying" in step.patch;
const movesTheField = (step: TelemetryStep): boolean =>
  !isBracketStep(step) && Array.isArray(step.patch.CarIdxLapDistPct);

beforeEach(() => {
  initializeEventBus(silentLogger);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  _resetSimEventsIracing();
  _resetEventBus();
});

describe('the "Caution → catch-up" shortcut (issue #1168)', () => {
  const waving = stepWhere("the caution thrown", (s) => (flagsOf(s) & Flags.CautionWaving) !== 0);
  const pickup = stepWhere("the pickup", (s) => (flagsOf(s) & Flags.Caution) !== 0);
  const fieldMoves = steps.flatMap((step, index) => (movesTheField(step) ? [index] : []));
  const [opens, closes] = fieldMoves;
  const restart = stepWhere("the restart", (s) => (flagsOf(s) & Flags.Green) !== 0);

  it("is the caution button the reference voice's script names, beside its siblings", () => {
    expect(shortcut).toMatchObject({ category: "Flags", label: "Caution → catch-up" });

    const script = defaultScript as CalloutScript;

    for (const scenarioId of ["pit-crew.caution-catch-up", "pit-crew.caution-catch-up-reminder"]) {
      expect(script.scenarios[scenarioId]?.test, scenarioId).toMatch(/^Harness → Flags → Caution → catch-up/);
    }

    // After the three older caution buttons, in the Flags group.
    const flags = SCENARIO_SHORTCUTS.filter((s) => s.category === "Flags").map((s) => s.id);

    expect(flags.slice(flags.indexOf("flag-caution-restart"), flags.indexOf("flag-caution-catch-up") + 1)).toEqual([
      "flag-caution-restart",
      "flag-caution-lineup-change",
      "flag-caution-extra-lap",
      "flag-caution-catch-up",
    ]);
  });

  it("drives the translator rather than publishing an event, and refuses to run without a session preset", () => {
    // Publishing `caution.gapOpened` would step over the decision AND be
    // refused at the callout's gate: the translator would not judge the gap
    // open.
    expect(shortcut?.event).toBeUndefined();
    expect(steps.length).toBeGreaterThan(0);
    expect(shortcut?.requires).toEqual(["player-car-index", "track-length", "sdk-connected"]);
  });

  it("control: with the mock SDK disconnected the whole run publishes nothing — why it refuses to start that way", () => {
    // A disconnected translator sees no ticks, so the minute goes by with no
    // caution, no gap and no call, on the right session preset and all. The
    // three older caution buttons are in the same position and say so in
    // their descriptions; this one is refused, since nothing it auditions can
    // happen at all (`shortcut-preconditions.test.ts` pins the refusal).
    const controller = new MockSDKController();

    controller.setSessionInfo(readPreset("session", "race") as SessionInfo);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
    controller.tickOnce();

    const rig: Rig = { controller, trace: [], events: [] };

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => rig.events.push({ event: ev.event, at: Date.now() }));
    }

    drive(rig, steps);

    expect(controller.getState().isConnected).toBe(false);
    expect(rig.events).toEqual([]);
    expect(rig.trace.every((step) => step.gap === null)).toBe(true);
  });

  it("warns in the raw injector that its two events are silent unless the translator judges the gap open", () => {
    const noted = EVENT_TEMPLATES.filter((t) => t.description.includes(CATCH_UP_GATE_NOTE)).map((t) => t.name);

    expect(noted.sort()).toEqual(["caution.gapOpened", "caution.gapStillOpen"]);
    expect(CATCH_UP_GATE_NOTE).toContain("Flags → Caution → catch-up");
  });

  it("opens inside a replay-mode bracket: on track in a settled pack, under green, nobody lined up", () => {
    // The bracket is what keeps the previous button out of the run. A baseline
    // of `OnPitRoad: true` would turn the bracket's own "off pit road" into a
    // pit exit under caution — one call and no reminders — and a session that
    // is not racing is not one a caution can be thrown in.
    const [open, close] = steps;

    expect(open.patch).toMatchObject({
      IsReplayPlaying: true,
      IsOnTrack: true,
      OnPitRoad: false,
      PlayerCarInPitStall: false,
      PlayerTrackSurface: TrkLoc.OnTrack,
      SessionState: SessionState.Racing,
      SessionFlags: RACING_NO_FLAG,
      CarIdxPaceFlags: null,
      CarIdxLapCompleted: null,
    });
    expect((open.patch.CarIdxPaceRow as number[]).every((row) => row === -1)).toBe(true);
    expect((open.patch.CarIdxTrackSurface as number[]).every((surface) => surface === TrkLoc.OnTrack)).toBe(true);
    expect(open.tick).toBe(true);
    expect(close).toEqual({ patch: { IsReplayPlaying: false }, holdMs: expect.any(Number), tick: true });
    expect(close.holdMs ?? 0).toBeGreaterThan(REPLAY_EXIT_GRACE_MS);
    expect(steps.filter(isBracketStep)).toHaveLength(2);
    // Then a tick of its own, so the translator re-seeds on what the bracket
    // arranged before the flag is thrown, however slowly the loop is ticking.
    expect(steps[2]).toEqual({ patch: {}, tick: true });
  });

  it("opens the gap after the pickup, holds it, closes it, then restarts — in that order", () => {
    expect(fieldMoves).toHaveLength(2);
    expect([waving, pickup, opens, closes, restart]).toEqual([3, 4, 5, 6, 7]);
    expect(steps).toHaveLength(9);
  });

  it("takes its waits from the translator's own windows", () => {
    // Imported, not typed in: a window the translator lengthens lengthens the
    // button with it, and the run still reaches the reminder.
    const LINE_ALLOWANCE_MS = 4000;

    expect(steps[pickup].holdMs).toBe(CATCH_UP_SETTLE_MS);
    expect(steps[opens].holdMs ?? 0).toBeGreaterThanOrEqual(
      CATCH_UP_DWELL_MS + CATCH_UP_REMINDER_MS + LINE_ALLOWANCE_MS,
    );
    // Short of a SECOND reminder: the button auditions one.
    expect(steps[opens].holdMs ?? 0).toBeLessThan(CATCH_UP_DWELL_MS + 2 * CATCH_UP_REMINDER_MS);
    // The caution's own calls get their time before the pickup's.
    expect(steps[waving].holdMs ?? 0).toBeGreaterThanOrEqual(LINE_ALLOWANCE_MS);
  });

  it("forms a settled pack and drops the player four spacings back, the cars behind him with him", () => {
    // The translator judges a ratio, so what matters is the shape: every pair
    // one spacing apart, the pace car's own pair two, and — once the gap is
    // open — only the player's pair different.
    const inPlace = steps[0].patch.CarIdxLapDistPct as number[];
    const droppedBack = steps[opens].patch.CarIdxLapDistPct as number[];
    const gapsOf = (pct: number[]): number[] => pct.slice(1).map((value, i) => Number((pct[i] - value).toFixed(4)));
    const spacing = gapsOf(inPlace)[1];

    expect(gapsOf(inPlace)).toEqual([2 * spacing, ...Array<number>(16).fill(spacing)]);
    expect(steps[closes].patch.CarIdxLapDistPct).toEqual(inPlace);

    const opened = gapsOf(droppedBack);

    expect(opened[PLAYER - 1]).toBeCloseTo(4 * spacing, 6);
    expect(opened.filter((_gap, i) => i !== PLAYER - 1)).toEqual(gapsOf(inPlace).filter((_gap, i) => i !== PLAYER - 1));
    // Past the raise multiple, with room: the measured dropped-back readings
    // start at 3.4×.
    expect(4).toBeGreaterThan(CATCH_UP_RAISE_MULTIPLE);
  });

  it.each(["race", "race-oval"])(
    "makes the translator report the gap, then remind once, and nothing after it closes (%s)",
    (preset) => {
      const rig = startRig(preset);

      drive(rig, steps);

      expect(rig.trace.map((step) => names(step.events))).toEqual([
        [],
        [],
        [],
        ["flag.caution-waving.raised"],
        ["caution.fieldCaught"],
        // Both of them inside the one step that holds the gap open.
        ["caution.gapOpened", "caution.gapStillOpen"],
        // Closed: silently, and no reminder follows.
        [],
        ["caution.restarted"],
        [],
      ]);
    },
  );

  it("reports the gap one settle and one dwell after the pickup, and reminds one reminder interval later", () => {
    const rig = startRig();

    drive(rig, steps);

    const at = (event: string): number => rig.events.find((e) => e.event === event)?.at ?? Number.NaN;
    const caught = at("caution.fieldCaught");
    const opened = at("caution.gapOpened");
    const reminded = at("caution.gapStillOpen");
    // The mock's tick, twice: the patch's own tick and the one that finds the window elapsed.
    const TICKS_MS = 2 * 14;

    expect(opened - caught).toBeGreaterThanOrEqual(CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS);
    expect(opened - caught).toBeLessThanOrEqual(CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS + TICKS_MS);
    expect(reminded - opened).toBeGreaterThanOrEqual(CATCH_UP_REMINDER_MS);
    expect(reminded - opened).toBeLessThanOrEqual(CATCH_UP_REMINDER_MS + TICKS_MS);
    // The reminder's line has its listening time before the gap closes.
    expect(rig.trace[closes].at - reminded).toBeGreaterThanOrEqual(4000);
  });

  it("has the translator judge the gap open exactly while the button holds it open — what both callouts ask before they speak", () => {
    const rig = startRig();

    drive(rig, steps);

    // Under the waving flag there is a lineup and a reading, and the phase
    // blocks it: a waving field is not a pack.
    expect(rig.trace[waving].gap).toMatchObject({ warranted: false, blockedBy: ["phase"] });
    // Picked up and settled, in place: live, and nothing to call.
    expect(rig.trace[pickup].gap).toMatchObject({ warranted: false, blockedBy: [] });
    expect(rig.trace[pickup].gap?.measurement.ratio).toBeCloseTo(1, 6);
    // Open: four times the pack's spacing, to car 11, over fifteen pairs.
    expect(rig.trace[opens].gap).toMatchObject({ warranted: true, blockedBy: [] });
    expect(rig.trace[opens].gap?.measurement).toMatchObject({ followCarIdx: FOLLOW, spacingSamples: 15 });
    expect(rig.trace[opens].gap?.measurement.ratio).toBeCloseTo(4, 6);
    expect(15).toBeGreaterThanOrEqual(CATCH_UP_MIN_SPACING_SAMPLES);
    // Closed: below the clear multiple, so a call still waiting is refused.
    expect(rig.trace[closes].gap).toMatchObject({ warranted: false, blockedBy: [] });
    expect(rig.trace[closes].gap?.measurement.ratio).toBeLessThan(CATCH_UP_CLEAR_MULTIPLE);
    // After the green nothing is warranted, whatever the rows still say.
    expect(rig.trace[restart].gap?.warranted).toBe(false);
  });

  it("measures a real distance on both race presets — they carry the track length a gap is read against", () => {
    // Without `WeekendInfo.TrackLength` a lap fraction is not a distance: the
    // translator measures no gap, every tick, and the button plays the
    // caution with no catch-up call. The two presets differ in length and
    // agree on the ratio, which is why the lap fractions serve both.
    const gapsOn = (preset: string): { gapMeters: number | null; packSpacingMeters: number | null } => {
      _resetSimEventsIracing();
      _resetEventBus();
      initializeEventBus(silentLogger);

      const rig = startRig(preset);

      drive(rig, steps.slice(0, opens + 1));

      const measurement = rig.trace[opens].gap?.measurement;

      return { gapMeters: measurement?.gapMeters ?? null, packSpacingMeters: measurement?.packSpacingMeters ?? null };
    };

    const road = gapsOn("race");
    const oval = gapsOn("race-oval");

    expect(road.packSpacingMeters).toBeCloseTo(10.25, 6);
    expect(road.gapMeters).toBeCloseTo(41, 6);
    expect(oval.packSpacingMeters).toBeCloseTo(11.9, 6);
    expect(oval.gapMeters).toBeCloseTo(47.6, 6);
  });

  it("control: on a session with no track length the same run reports no gap at all", () => {
    // The dependency the test above names, shown: strip the one field and the
    // catch-up half of the run is gone, with the caution itself untouched.
    const controller = new MockSDKController();
    const session = readPreset("session", "race") as { WeekendInfo: Record<string, unknown> };
    const { TrackLength: _dropped, ...weekendWithoutLength } = session.WeekendInfo;

    expect(session.WeekendInfo.TrackLength).toEqual(expect.stringMatching(/km$/));

    controller.setSessionInfo({ ...session, WeekendInfo: weekendWithoutLength } as unknown as SessionInfo);
    controller.mutateTelemetry(readPreset("telemetry", "hot-lap") as Partial<TelemetryData>);
    controller.setConnected(true);
    initializeSimEventsIracing(getEventBus(), controller as unknown as SDKController, silentLogger);
    controller.tickOnce();

    const rig: Rig = { controller, trace: [], events: [] };

    for (const name of ALL_EVENT_NAMES) {
      getEventBus().subscribe(name, (ev) => rig.events.push({ event: ev.event, at: Date.now() }));
    }

    drive(rig, steps);

    expect(names(rig.events)).toEqual(RUN.filter((event) => !event.startsWith("caution.gap")));
    expect(rig.trace[opens].gap?.measurement.gapMeters).toBeNull();

    // Which is the run the `track-length` precondition refuses before it
    // starts: the dry check and this wet one agree about the same session.
    const state = (sessionInfo: unknown): HarnessPreconditionState => ({
      sessionInfo: sessionInfo as Record<string, unknown>,
      isConnected: true,
      telemetry: controller.getState().telemetry,
    });

    expect(
      checkShortcutPreconditions(shortcut?.requires, state({ ...session, WeekendInfo: weekendWithoutLength })),
    ).toEqual(expect.stringContaining("WeekendInfo.TrackLength"));
    expect(checkShortcutPreconditions(shortcut?.requires, state(session))).toBeNull();
  });

  it("control: with the tick loop slower than the translator's tolerance the gap is never reported — its dwell has to be continuous", () => {
    // Readings further apart than `CATCH_UP_UNJUDGED_TOLERANCE_MS` do not add
    // up to "at the raise multiple for a dwell": each starts the dwell again.
    // The tester can slow the mock's loop to five seconds from the header, and
    // the button then plays its caution with no catch-up call, for a reason
    // that is the translator's, not the button's.
    const slow = startRig();

    pressAtTickInterval(slow, CATCH_UP_UNJUDGED_TOLERANCE_MS + 200);

    expect(names(slow.events)).toEqual(RUN.filter((event) => !event.startsWith("caution.gap")));

    _resetSimEventsIracing();
    _resetEventBus();
    initializeEventBus(silentLogger);

    // Just inside the tolerance the same loop is a continuous reading.
    const bridged = startRig();

    pressAtTickInterval(bridged, CATCH_UP_UNJUDGED_TOLERANCE_MS - 100);

    expect(names(bridged.events)).toEqual(RUN);
  });

  it("control: held open instead of closed, the gap is reminded of a second time — so the silence after closing is the closing's", () => {
    const rig = startRig();
    const heldOpen = steps.map((step, index) =>
      index === closes ? { patch: {}, holdMs: CATCH_UP_REMINDER_MS + 1000 } : step,
    );

    drive(rig, heldOpen);

    expect(names(rig.events).filter((event) => event === "caution.gapStillOpen")).toHaveLength(2);
  });

  it("control: closing by more than a pack spacing before the reminder is due silences it — the reminder is for a driver who is not closing", () => {
    // What the button's steady gap asks of the translator, shown from the
    // other side: the same run with the gap a spacing and a half shorter by
    // the time the reminder is judged. Still open (two and a half spacings,
    // above the clear multiple), and no reminder.
    const rig = startRig();
    const inPlace = steps[0].patch.CarIdxLapDistPct as number[];
    const droppedBack = steps[opens].patch.CarIdxLapDistPct as number[];
    const closingUp = inPlace.map((pct, carIdx) => pct + (droppedBack[carIdx] - pct) / 2);
    const half = (steps[opens].holdMs ?? 0) / 2;
    const closing = steps.flatMap((step, index) =>
      index === opens
        ? [
            { ...step, holdMs: half },
            { patch: { CarIdxLapDistPct: closingUp }, holdMs: half },
          ]
        : [step],
    );

    drive(rig, closing);

    expect(names(rig.events)).toEqual(RUN.filter((event) => event !== "caution.gapStillOpen"));
    expect(rig.trace[opens + 1].gap).toMatchObject({ warranted: true });
    expect(rig.trace[opens + 1].gap?.measurement.ratio).toBeCloseTo(2.5, 6);
    expect(2.5).toBeGreaterThan(CATCH_UP_CLEAR_MULTIPLE);
  });

  it("lines the field up single file behind the pace car for the whole caution, the player behind car 11", () => {
    const rig = startRig();

    drive(rig, steps.slice(0, pickup + 1));

    expect(getPaceLineup()).toMatchObject({
      anchor: "pace-car",
      doubleFile: false,
      line: null,
      followCarIdx: FOLLOW,
      followCarNumber: "11",
      lineupPosition: PLAYER,
      followsPaceCar: false,
    });
  });

  it("ends racing with no flag shown, nobody lined up and its per-car arrays gone, so a second press plays the same run", () => {
    const rig = startRig();

    drive(rig, steps);

    const left = rig.controller.getState().telemetry as Record<string, unknown>;

    expect((left.SessionFlags as number) >>> 0).toBe(RACING_NO_FLAG >>> 0);
    expect(left.SessionState).toBe(SessionState.Racing);
    expect(getPaceLineup()).toBeNull();
    expect(getCautionGap()).toBeNull();
    // "Caution → extra lap" counts on the telemetry carrying no per-car lap
    // progress.
    expect(left).not.toHaveProperty("CarIdxLapDistPct");
    expect(left).not.toHaveProperty("CarIdxLapCompleted");
    expect(left).not.toHaveProperty("CarIdxTrackSurface");

    const firstPress = names(rig.events.splice(0));

    drive(rig, steps);

    expect(names(rig.events)).toEqual(firstPress);
    expect(firstPress).toEqual(RUN);
  });

  it.each([null, ...TELEMETRY_PRESETS])("plays the same five events from the %s telemetry preset", (preset) => {
    // The pit-road preset is the one the bracket is there for: its car is ON
    // pit road, and outside replay mode the button's own "off pit road" would
    // be a pit exit under caution — one call, no reminder.
    const rig = startRig("race", preset);

    drive(rig, steps);

    // Entering replay mode closes any active loop the preset left running (a
    // speeding cue, from the pit-road preset's car parked over the limit):
    // the translator's own teardown, and no part of the run.
    expect(names(rig.events).filter((event) => event !== "pitSpeeding.ended")).toEqual(RUN);
  });

  it("stays about a minute long", () => {
    const total = steps.reduce((sum, step) => sum + (step.holdMs ?? 0), 0);

    // The translator's three windows alone are 43 s of it.
    expect(total).toBeGreaterThanOrEqual(CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS + CATCH_UP_REMINDER_MS);
    expect(total).toBeLessThanOrEqual(65_000);
  });
});
