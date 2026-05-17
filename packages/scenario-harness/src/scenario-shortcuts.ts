/**
 * Curated one-click triggers for the active Pit Crew scenarios + a few
 * handy state changes that don't naturally fall out of telemetry mutation.
 *
 * Each shortcut maps to a `bus.publish` call with a fully-formed payload.
 * Authoring scenarios this way is faster than hand-editing JSON in the
 * raw event injector — the user can focus on hearing/seeing the response,
 * not on writing event payloads.
 *
 * Adding a shortcut: append an entry below. Adding a category: pick a
 * stable `category` string and add at least one entry under it. Order in
 * the array drives display order in the UI.
 */
import type { QualifyingInvalidationSnapshot } from "@iracedeck/audio-scenarios/pit-crew";
import { type SimEventName, TrackWetness } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";

export type ScenarioShortcut = {
  id: string;
  category: string;
  label: string;
  description?: string;
  event: SimEventName;
  data: Record<string, unknown>;
  /**
   * Optional snapshot for the qualifying lap-invalidation scenario (issue #567).
   * When present, the UI POSTs `/api/qualifying-invalidation/snapshot` with this
   * payload BEFORE publishing `event`, so the scenario's resolver returns the
   * intended snapshot at fire time. A single click therefore drives both the
   * snapshot setup and the trigger event.
   */
  qualifyingInvalidationSnapshot?: QualifyingInvalidationSnapshot;
};

const ALL_FOUR_TIRES = ["LF", "RF", "LR", "RR"] as const;

function tireSet(name: string, label: string, tires: readonly string[]): ScenarioShortcut {
  return {
    id: `tire-${name}`,
    category: "Tire Service",
    label,
    event: "tireService.changed",
    data: {
      added: [...tires],
      removed: ALL_FOUR_TIRES.filter((t) => !tires.includes(t)),
      current: [...tires],
    },
  };
}

function flag(label: string, event: SimEventName, data: Record<string, unknown> = {}): ScenarioShortcut {
  return { id: `flag-${label.toLowerCase().replace(/\s+/g, "-")}`, category: "Flags", label, event, data };
}

function radar(label: string, from: string, to: string): ScenarioShortcut {
  return {
    id: `radar-${to.replace(/\s+/g, "-")}`,
    category: "Radar",
    label,
    event: "radar.changed",
    data: { from, to },
  };
}

function pitStatus(id: string, label: string, target: PitSvStatus, description?: string): ScenarioShortcut {
  return {
    id: `pit-status-${id}`,
    category: "Pit Status",
    label,
    description,
    event: "pitService.statusChanged",
    // `from` is presented as `None` so each shortcut reads as a fresh
    // transition into the target state. Same-family preempt still works
    // when two shortcuts fire in quick succession because the scenario
    // engine sees identical `family: "pit-status"` metadata regardless
    // of the `from` value.
    data: { from: PitSvStatus.None, to: target },
  };
}

function qualifyingInvalidation(
  id: string,
  label: string,
  snapshot: Omit<QualifyingInvalidationSnapshot, "lapStartedFromPits"> & { lapStartedFromPits?: boolean },
  options: { description?: string; incidentType?: string; delta?: number } = {},
): ScenarioShortcut {
  return {
    id: `qualifying-invalidation-${id}`,
    category: "Qualifying Invalidation",
    label,
    description: options.description,
    event: "incident.occurred",
    data: { delta: options.delta ?? 1, type: options.incidentType ?? "off-track" },
    qualifyingInvalidationSnapshot: { lapStartedFromPits: false, ...snapshot },
  };
}

function trackConditions(
  direction: "worsening" | "drying",
  id: string,
  label: string,
  target: TrackWetness,
): ScenarioShortcut {
  // Pick a `from` one step away from `to` in the chosen direction so the
  // scenario predicate (`to > from` for worsening, `to < from` for drying)
  // resolves naturally without having to compute exhaustively.
  const from = direction === "worsening" ? target - 1 : target + 1;

  return {
    id: `track-${direction}-${id}`,
    category: `Track Conditions — ${direction === "worsening" ? "Worsening" : "Drying"}`,
    label,
    description: `${direction === "worsening" ? "Track is getting wetter" : "Track is drying"} — now ${label}`,
    event: "track.wetness.changed",
    data: { from, to: target },
  };
}

export const SCENARIO_SHORTCUTS: readonly ScenarioShortcut[] = [
  // ── Pit Service ──
  {
    id: "fuel-on",
    category: "Pit Service",
    label: "Fuel ON",
    description: "Driver enables fuel for the next stop",
    event: "pitService.toggled",
    data: { service: "fuel", on: true },
  },
  {
    id: "fuel-off",
    category: "Pit Service",
    label: "Fuel OFF",
    description: "Driver disables fuel for the next stop",
    event: "pitService.toggled",
    data: { service: "fuel", on: false },
  },
  {
    id: "windshield-on",
    category: "Pit Service",
    label: "Windshield ON",
    description: "Driver enables windshield tearoff for the next stop",
    event: "pitService.toggled",
    data: { service: "windshield", on: true },
  },
  {
    id: "windshield-off",
    category: "Pit Service",
    label: "Windshield OFF",
    description: "Driver disables windshield tearoff for the next stop",
    event: "pitService.toggled",
    data: { service: "windshield", on: false },
  },
  {
    id: "fast-repair-on",
    category: "Pit Service",
    label: "Fast Repair ON",
    description: "Driver enables fast repair for the next stop",
    event: "pitService.toggled",
    data: { service: "fastRepair", on: true },
  },
  {
    id: "fast-repair-off",
    category: "Pit Service",
    label: "Fast Repair OFF",
    description: "Driver disables fast repair for the next stop",
    event: "pitService.toggled",
    data: { service: "fastRepair", on: false },
  },

  // ── Tire Service ──
  // The 5 standard patterns the registered scenarios match on (current set).
  tireSet("all", "All", ALL_FOUR_TIRES),
  {
    id: "tire-none",
    category: "Tire Service",
    label: "Skip",
    description: "Clear the tire selection (current = [])",
    event: "tireService.changed",
    data: { added: [], removed: [...ALL_FOUR_TIRES], current: [] },
  },
  tireSet("fronts", "Fronts", ["LF", "RF"]),
  tireSet("rears", "Rears", ["LR", "RR"]),
  tireSet("lefts", "Lefts", ["LF", "LR"]),
  tireSet("rights", "Rights", ["RF", "RR"]),
  // Single corners (intentional puncture-only changes).
  tireSet("lf", "LF only", ["LF"]),
  tireSet("rf", "RF only", ["RF"]),
  tireSet("lr", "LR only", ["LR"]),
  tireSet("rr", "RR only", ["RR"]),
  // Diagonals
  tireSet("lf-rr", "LF + RR", ["LF", "RR"]),
  tireSet("rf-lr", "RF + LR", ["RF", "LR"]),
  // Three-corner combos — labelled by the tire that's *skipped* so the
  // intent reads cleanly ("All except RR"); compare with the patterns
  // above which name what's *included*.
  tireSet("skip-rr", "All except RR", ["LF", "RF", "LR"]),
  tireSet("skip-lr", "All except LR", ["LF", "RF", "RR"]),
  tireSet("skip-rf", "All except RF", ["LF", "LR", "RR"]),
  tireSet("skip-lf", "All except LF", ["RF", "LR", "RR"]),
  // Compound switches (iRacing exposes 0=dry / 1=wet).
  {
    id: "compound-dry",
    category: "Tire Service",
    label: "Compound → DRY",
    description: "Switch the pit-service compound to dry",
    event: "tireService.compoundChanged",
    data: { from: 1, to: 0 },
  },
  {
    id: "compound-wet",
    category: "Tire Service",
    label: "Compound → WET",
    description: "Switch the pit-service compound to wet",
    event: "tireService.compoundChanged",
    data: { from: 0, to: 1 },
  },

  // ── Pit Lane ──
  { id: "pit-approaching", category: "Pit Lane", label: "Approaching", event: "pitLane.approaching", data: {} },
  { id: "pit-entered", category: "Pit Lane", label: "Entered Pit Lane", event: "pitLane.entered", data: {} },
  { id: "stall-entered", category: "Pit Lane", label: "Entered Stall", event: "pitStall.entered", data: {} },
  { id: "stall-departed", category: "Pit Lane", label: "Departed Stall", event: "pitStall.departed", data: {} },
  { id: "pit-exited", category: "Pit Lane", label: "Exited Pit Lane", event: "pitLane.exited", data: {} },

  // ── Flags ──
  flag("Yellow (local)", "flag.yellow.raised", { scope: "local" }),
  flag("Yellow (full)", "flag.yellow.raised", { scope: "full" }),
  flag("Yellow Cleared", "flag.yellow.cleared"),
  flag("Green", "flag.green.raised"),
  flag("White", "flag.white.raised"),
  flag("Checkered", "flag.checkered.raised"),
  flag("Blue", "flag.blue.raised"),
  flag("Black", "flag.black.raised"),
  flag("Red", "flag.red.raised"),
  flag("Debris", "flag.debris.raised"),
  flag("Meatball", "flag.meatball.raised"),

  // ── Damage ──
  // Bypasses the rising-edge + 3000 ms debounce in
  // `sim-events-iracing/diff/damage.ts` — fires the bus event directly
  // so you hear the audio without waiting for the diff to settle. Use
  // the Engine Warnings panel checkboxes (Mandatory / Optional Repair)
  // when you specifically want to exercise the diff.
  {
    id: "damage-repair-needed",
    category: "Damage",
    label: "Damage Detected",
    description: "Fire `damage.repairNeeded.raised` directly (skips the diff debounce)",
    event: "damage.repairNeeded.raised",
    data: {},
  },

  // ── Incidents ──
  // One shortcut per IncidentType the bus publishes (issue #530). The
  // diff classifies the iRacing report byte before publishing, so the
  // harness mirrors that vocabulary directly. `delta` is the canonical
  // point count for each type per iRacing's `irsdk_IncidentFlags` enum
  // comments (off-track 1x, out-of-control 2x, contact 0x, collision 2x
  // for world / 4x for car).
  {
    id: "incident-off-track",
    category: "Incidents",
    label: "Off Track (1x)",
    description: "Track-limits nudge — `Mind the track limits` etc.",
    event: "incident.occurred",
    data: { delta: 1, type: "off-track" },
  },
  {
    id: "incident-out-of-control",
    category: "Incidents",
    label: "Out of Control (2x)",
    description: "Spin / loss of control — composure callout (default off in PI).",
    event: "incident.occurred",
    data: { delta: 2, type: "out-of-control" },
  },
  {
    id: "incident-contact-world",
    category: "Incidents",
    label: "Contact — Wall (0x)",
    description: "Light wall rub — engineer notes no penalty.",
    event: "incident.occurred",
    data: { delta: 0, type: "contact-world" },
  },
  {
    id: "incident-collision-world",
    category: "Incidents",
    label: "Collision — Wall (2x)",
    description: "Heavier wall hit — engineer announces 2-point penalty.",
    event: "incident.occurred",
    data: { delta: 2, type: "collision-world" },
  },
  {
    id: "incident-contact-car",
    category: "Incidents",
    label: "Contact — Car (0x)",
    description: "Light car-to-car rub — engineer notes no penalty.",
    event: "incident.occurred",
    data: { delta: 0, type: "contact-car" },
  },
  {
    id: "incident-collision-car",
    category: "Incidents",
    label: "Collision — Car (4x)",
    description: "Heavier car-to-car hit — engineer announces 4-point penalty.",
    event: "incident.occurred",
    data: { delta: 4, type: "collision-car" },
  },
  {
    id: "off-track-started",
    category: "Incidents",
    label: "Off-Track Started",
    event: "offTrack.started",
    data: {},
  },
  // ── Qualifying Invalidation ──
  // Issue #567. Each shortcut posts its embedded `qualifyingInvalidationSnapshot`
  // to `/api/qualifying-invalidation/snapshot` before publishing the trigger
  // event, so a single click drives both the snapshot setup and the
  // `incident.occurred` fire. Together they cover every code path through the
  // scenario: out-of-laps, counted-singular, counted-plural, plenty fallback,
  // time-limited (core only), session gating, and the per-lap latch.
  qualifyingInvalidation(
    "lap-limited-3-laps-left",
    "Off-Track — 3 laps left",
    { sessionType: "qualifying", sessionNum: 1, lapsRemaining: 3, lapLimited: true, lapCompleted: 1 },
    { description: "Qualifying with 3 laps to go — composed plural tail." },
  ),
  qualifyingInvalidation(
    "lap-limited-1-lap-left",
    "Contact-Car — 1 lap left",
    { sessionType: "qualifying", sessionNum: 1, lapsRemaining: 1, lapLimited: true, lapCompleted: 2 },
    {
      description: "Qualifying with 1 lap to go — composed singular tail.",
      incidentType: "contact-car",
      delta: 0,
    },
  ),
  qualifyingInvalidation(
    "lap-limited-out-of-laps",
    "Off-Track — out of laps",
    { sessionType: "qualifying", sessionNum: 1, lapsRemaining: 0, lapLimited: true, lapCompleted: 3 },
    { description: "Qualifying with no laps remaining — out-of-laps branch." },
  ),
  qualifyingInvalidation(
    "lap-limited-plenty",
    "Off-Track — plenty of laps",
    { sessionType: "qualifying", sessionNum: 1, lapsRemaining: 8, lapLimited: true, lapCompleted: 4 },
    { description: "Qualifying with 6+ laps to go — fallback to plenty-of-laps clip." },
  ),
  qualifyingInvalidation(
    "time-limited",
    "Off-Track — time-limited",
    { sessionType: "qualifying", sessionNum: 1, lapsRemaining: undefined, lapLimited: false, lapCompleted: 5 },
    { description: "Time-limited qualifying — core line only, tail skipped." },
  ),
  qualifyingInvalidation(
    "race-session-silent",
    "Off-Track in Race (silent)",
    { sessionType: "race", sessionNum: 0, lapsRemaining: 3, lapLimited: true, lapCompleted: 6 },
    { description: "Session-gating check — should produce no audio." },
  ),
  qualifyingInvalidation(
    "practice-session-silent",
    "Off-Track in Practice (silent)",
    { sessionType: "practice", sessionNum: 0, lapsRemaining: 3, lapLimited: true, lapCompleted: 7 },
    { description: "Session-gating check — should produce no audio." },
  ),
  qualifyingInvalidation(
    "latch-repeat",
    "Same Lap Again (latch)",
    { sessionType: "qualifying", sessionNum: 1, lapsRemaining: 3, lapLimited: true, lapCompleted: 1 },
    {
      description:
        "Fires the same (sessionNum=1, lapCompleted=1) as the first qualifying shortcut — should be silent on the second click thanks to the per-lap latch. Reset by clicking any other qualifying-invalidation shortcut (different lapCompleted) or by a server restart.",
    },
  ),
  qualifyingInvalidation(
    "pit-exit-lap-silent",
    "Off-Track on pit-exit lap (silent)",
    {
      sessionType: "qualifying",
      sessionNum: 1,
      lapsRemaining: 2,
      lapLimited: true,
      lapCompleted: 3,
      lapStartedFromPits: true,
    },
    {
      description:
        "Lap began at pit exit (lapStartedFromPits=true) — should produce no audio. Covers both the session out-lap and any mid-session post-pit-exit lap: neither is a timed attempt.",
    },
  ),

  {
    id: "off-track-ended",
    category: "Incidents",
    label: "Off-Track Ended",
    event: "offTrack.ended",
    data: {},
  },

  // ── Pit Status ──
  // `pitService.statusChanged` transitions (issue #479). Bypasses the
  // sim translator so you hear/see the scenario without driving
  // `PlayerCarPitSvStatus` through `/api/telemetry`. Same-family
  // preempt: fire two in a row to confirm the second cancels the first.
  pitStatus("in-progress", "In Progress", PitSvStatus.InProgress, "Crew started working on the car"),
  pitStatus("complete", "Complete", PitSvStatus.Complete, "Service finished — ready to leave the box"),
  pitStatus("too-far-left", "Too Far Left", PitSvStatus.TooFarLeft),
  pitStatus("too-far-right", "Too Far Right", PitSvStatus.TooFarRight),
  pitStatus("too-far-forward", "Too Far Forward", PitSvStatus.TooFarForward),
  pitStatus("too-far-back", "Too Far Back", PitSvStatus.TooFarBack),
  pitStatus("bad-angle", "Bad Angle", PitSvStatus.BadAngle),
  pitStatus(
    "cant-fix-that",
    "Can't Fix That",
    PitSvStatus.CantFixThat,
    "Crew won't perform the queued repair this stop",
  ),

  // ── Radar ──
  // `from` is the previous radar state; `to` is the new one. The radar
  // engine drives its own tick loop off the current state, so any
  // transition the engine would otherwise see via diffing telemetry.
  radar("Clear", "left", "clear"),
  radar("Left", "clear", "left"),
  radar("Right", "clear", "right"),
  radar("Both Sides", "clear", "both"),
  radar("Two Left", "left", "two-left"),
  radar("Two Right", "right", "two-right"),

  // ── Track Conditions — Worsening ──
  // `track.wetness.changed` transitions where `to > from`. Bypasses the sim
  // translator so you hear the engineer line without driving the iRacing
  // `TrackWetness` field through `/api/telemetry`. Six worsening targets:
  // Dry isn't a worsening target (you can only become wetter than Dry, not
  // arrive at Dry by getting wetter). Same-family preempt works between any
  // two track-conditions shortcuts fired in quick succession.
  trackConditions("worsening", "mostly-dry", "Mostly Dry", TrackWetness.MostlyDry),
  trackConditions("worsening", "very-lightly-wet", "Very Lightly Wet", TrackWetness.VeryLightlyWet),
  trackConditions("worsening", "lightly-wet", "Lightly Wet", TrackWetness.LightlyWet),
  trackConditions("worsening", "moderately-wet", "Moderately Wet", TrackWetness.ModeratelyWet),
  trackConditions("worsening", "very-wet", "Very Wet", TrackWetness.VeryWet),
  trackConditions("worsening", "extremely-wet", "Extremely Wet", TrackWetness.ExtremelyWet),

  // ── Track Conditions — Drying ──
  // `track.wetness.changed` transitions where `to < from`. Six drying
  // targets: ExtremelyWet isn't a drying target (you can only dry from
  // ExtremelyWet, not arrive at it by drying).
  trackConditions("drying", "very-wet", "Very Wet", TrackWetness.VeryWet),
  trackConditions("drying", "moderately-wet", "Moderately Wet", TrackWetness.ModeratelyWet),
  trackConditions("drying", "lightly-wet", "Lightly Wet", TrackWetness.LightlyWet),
  trackConditions("drying", "very-lightly-wet", "Very Lightly Wet", TrackWetness.VeryLightlyWet),
  trackConditions("drying", "mostly-dry", "Mostly Dry", TrackWetness.MostlyDry),
  trackConditions("drying", "dry", "Dry", TrackWetness.Dry),

  // ── Lap Time ──
  // `lap.completed` transitions where `isBest` is true (issue #555). Current
  // clip scope is minutes 1–10, whole seconds 0–59, decimals 0–9 — laps over
  // 10 minutes are dropped by the scenario's `where:` predicate (good for
  // verifying the gate). Same-family preempt works between two shortcuts
  // fired in quick succession.
  {
    id: "lap-best-1m-03s",
    category: "Lap Time",
    label: "Best Lap 1:03.4",
    description:
      'New PB with a prior best — engineer says "That was your best lap yet. One minute, three point four seconds."',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 63.4,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 63.4,
      previousBestLapTime: 64.1,
      sessionType: "race",
    },
  },
  {
    id: "lap-best-1m-23s",
    category: "Lap Time",
    label: "Best Lap 1:23.4",
    description:
      'Mid-range PB exercising the expanded seconds coverage — "One minute, twenty three point four seconds."',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 83.4,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 83.4,
      previousBestLapTime: 85.0,
      sessionType: "race",
    },
  },
  {
    id: "lap-best-sub-minute",
    category: "Lap Time",
    label: "Best Lap 0:34.8",
    description:
      'Sub-1-minute new PB — engineer skips the minute clip ("That was your best lap yet. Thirty four point eight seconds.")',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 34.8,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 34.8,
      previousBestLapTime: 35.5,
      sessionType: "race",
    },
  },
  {
    id: "lap-first-valid-2m-07s",
    category: "Lap Time",
    label: "First Valid Lap 2:07.0",
    description:
      'Driver\'s first valid lap of the session — engineer uses the "That lap was" intro instead of "best lap yet".',
    event: "lap.completed",
    data: {
      lap: 1,
      lapTime: 127.0,
      isBest: true,
      isFirstValid: true,
      bestLapTime: 127.0,
      sessionType: "race",
    },
  },
  {
    id: "lap-best-boundary-10m-59s",
    category: "Lap Time",
    label: "Best Lap 10:59.9 (top boundary)",
    description:
      "Top of the current clip range — minutes=10, seconds=59, decimal=9. Verifies the upper boundary is speakable.",
    event: "lap.completed",
    data: {
      lap: 3,
      lapTime: 659.9,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 659.9,
      previousBestLapTime: 662.4,
      sessionType: "race",
    },
  },
  {
    id: "lap-out-of-scope",
    category: "Lap Time",
    label: "Best Lap 11:05.5 (out of scope)",
    description:
      "Minute component (11) exceeds LAP_TIME_MINUTE_MAX (10) — the scenario's `where:` predicate short-circuits and no audio plays. Use this to verify the gate still suppresses over-long laps.",
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 665.5,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 665.5,
      previousBestLapTime: 670.0,
      sessionType: "race",
    },
  },

  // ── Position ──
  // `lap.completed` transitions where the position changed (issue #566).
  // Reuses the same bus event as Lap Time — both scenarios subscribe and fire
  // off the same payload. All shortcuts here use `sessionType: "qualifying"`
  // because the position family is qualifying-only — the standings phrasings
  // ("That puts us to P5", "on pole") don't fit race semantics. See the
  // race-silent / practice-silent shortcuts at the end to validate the gate.
  // The lap-time block above sets `isBest: true` so the engineer announces
  // the time first; these set `isBest: false` so ONLY the position scenario
  // fires (clearer for harness QA). Set `isBest: true` in one of these to
  // audit cross-family ordering.
  {
    id: "position-improved",
    category: "Position",
    label: "Improved 5 → 3",
    description: 'Driver moved up two spots — engineer says "That puts us to pee three."',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 3,
      previousPosition: 5,
      classPosition: 3,
      previousClassPosition: 5,
      isMultiClass: false,
    },
  },
  {
    id: "position-worsened",
    category: "Position",
    label: "Worsened 3 → 5",
    description: 'Driver dropped two spots — engineer says "We\'re currently pee five."',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 5,
      previousPosition: 3,
      classPosition: 5,
      previousClassPosition: 3,
      isMultiClass: false,
    },
  },
  {
    id: "position-first-fix",
    category: "Position",
    label: "First Valid Lap P1",
    description:
      'Driver\'s first valid lap of the session with no previous position — engineer uses the "better" intro: "That puts us to pee one."',
    event: "lap.completed",
    data: {
      lap: 1,
      lapTime: 84.2,
      isBest: true,
      isFirstValid: true,
      sessionType: "qualifying",
      position: 1,
      classPosition: 1,
      isMultiClass: false,
    },
  },
  {
    id: "position-pole-qualifying",
    category: "Position",
    label: "Qualifying P1 (pole)",
    description:
      'Improvement to P1 in qualifying — engineer says the self-contained pole line: "That puts us on pole." (no number).',
    event: "lap.completed",
    data: {
      lap: 3,
      lapTime: 49.5,
      isBest: true,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 1,
      previousPosition: 2,
      classPosition: 1,
      previousClassPosition: 2,
      isMultiClass: false,
    },
  },
  {
    id: "position-holding-pole",
    category: "Position",
    label: "Holding P1 (qualifying, slow lap)",
    description:
      'Already on pole on a slow lap — pole line does NOT repeat. Falls through to the status line: "We\'re currently pee one."',
    event: "lap.completed",
    data: {
      lap: 4,
      lapTime: 51.0,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 1,
      previousPosition: 1,
      classPosition: 1,
      previousClassPosition: 1,
      isMultiClass: false,
    },
  },
  {
    id: "position-unchanged-non-pb",
    category: "Position",
    label: "Unchanged P5 (non-PB lap)",
    description:
      'Position did not change AND the lap was not a PB — engineer fires the status line "We\'re currently pee five."',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 5,
      previousPosition: 5,
      classPosition: 5,
      previousClassPosition: 5,
      isMultiClass: false,
    },
  },
  {
    id: "position-unchanged-pb",
    category: "Position",
    label: "Unchanged P5 (PB lap)",
    description:
      "Position did not change AND the lap was a PB — scenario stays silent because lap-time-best already narrates the lap.",
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: true,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 5,
      previousPosition: 5,
      classPosition: 5,
      previousClassPosition: 5,
      isMultiClass: false,
    },
  },
  {
    id: "position-multi-class",
    category: "Position",
    label: "Multi-class P12 (class P3 → P2)",
    description:
      'Multi-class qualifying — overall P12, but class position improved P3 → P2. Engineer says "That puts us to pee two" (the class number, not the overall).',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 12,
      previousPosition: 12,
      classPosition: 2,
      previousClassPosition: 3,
      isMultiClass: true,
    },
  },
  {
    id: "position-out-of-scope",
    category: "Position",
    label: "P65 (out of scope)",
    description:
      "Position exceeds POSITION_NUMBER_MAX (64). Scenario's `where:` predicate short-circuits — no audio plays.",
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 65,
      previousPosition: 70,
      classPosition: 65,
      previousClassPosition: 70,
      isMultiClass: false,
    },
  },
  {
    id: "position-race-improved",
    category: "Position",
    label: "Improved in Race",
    description:
      'Race lap with an improvement P5 → P3. Engineer says "We\'re currently pee three." Issue #569 enabled the family in race for real changes; race always uses the "currently" intro (never "that puts us to") because race standings don\'t follow from lap times.',
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "race",
      position: 3,
      previousPosition: 5,
      classPosition: 3,
      previousClassPosition: 5,
      isMultiClass: false,
      lapsSincePositionChange: 0,
    },
  },
  {
    id: "position-race-hold-silent",
    category: "Position",
    label: "Hold in Race (silent — race-status owns hold)",
    description:
      "Race lap with no change on a non-PB lap. Position-change stays silent — the every-3-laps race-status callout owns hold-position updates per #569. Verifies the race-specific suppression in positionChangeIsAnnounceable.",
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "race",
      position: 5,
      previousPosition: 5,
      classPosition: 5,
      previousClassPosition: 5,
      isMultiClass: false,
      lapsSincePositionChange: 1,
    },
  },
  {
    id: "position-practice-silent",
    category: "Position",
    label: "Improved in Practice (silent)",
    description: "Practice sessions don't fire position callouts — verifies the session-type gate.",
    event: "lap.completed",
    data: {
      lap: 5,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "practice",
      position: 3,
      previousPosition: 5,
      classPosition: 3,
      previousClassPosition: 5,
      isMultiClass: false,
    },
  },
  // Race-status (issue #569). Fires when lapsSincePositionChange > 0 && % 3 === 0
  // in a race session. Each shortcut sets the cadence-hit value directly so the
  // scenario reads as if the diff had anchored or reset position several laps
  // back.
  {
    id: "race-status-cadence-hit",
    category: "Race",
    label: "Status update (P5 on lap 7)",
    description:
      'Race session, P5 held for 3 laps since last change. Engineer says "We\'re currently pee five." Fires the every-3-laps cadence.',
    event: "lap.completed",
    data: {
      lap: 7,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "race",
      position: 5,
      previousPosition: 5,
      classPosition: 5,
      previousClassPosition: 5,
      isMultiClass: false,
      lapsSincePositionChange: 3,
    },
  },
  {
    id: "race-status-leader",
    category: "Race",
    label: "Leader status (P1 on lap 6)",
    description:
      'Race leader at the every-3 cadence. Engineer says "We\'re still leading the race. Keep it up." (single self-contained clip — no number).',
    event: "lap.completed",
    data: {
      lap: 6,
      lapTime: 83.5,
      isBest: false,
      isFirstValid: false,
      sessionType: "race",
      position: 1,
      previousPosition: 1,
      classPosition: 1,
      previousClassPosition: 1,
      isMultiClass: false,
      lapsSincePositionChange: 3,
    },
  },
  {
    id: "race-status-silent-not-cadence",
    category: "Race",
    label: "Not on cadence (silent)",
    description: "Race session, 2 laps since change (not a multiple of 3). where: short-circuits — no audio plays.",
    event: "lap.completed",
    data: {
      lap: 6,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "race",
      position: 5,
      previousPosition: 5,
      classPosition: 5,
      previousClassPosition: 5,
      isMultiClass: false,
      lapsSincePositionChange: 2,
    },
  },
  {
    id: "race-status-silent-qualifying",
    category: "Race",
    label: "Qualifying (silent)",
    description:
      "Qualifying sessions don't fire race-status — the position family from #566 handles qualifying. Verifies the session-type gate.",
    event: "lap.completed",
    data: {
      lap: 6,
      lapTime: 84.2,
      isBest: false,
      isFirstValid: false,
      sessionType: "qualifying",
      position: 5,
      previousPosition: 5,
      classPosition: 5,
      previousClassPosition: 5,
      isMultiClass: false,
      lapsSincePositionChange: 3,
    },
  },
  // Race-end (issue #569). Fires off race.finished directly — the bus event
  // carries the final positions; the plugin caches it and composes with the
  // PI driver-name pick before the scenario speaks.
  {
    id: "race-end-won",
    category: "Race",
    label: "Race over — P1 (we won!)",
    description:
      'Race finished, P1. Engineer says "<Name>, we won! We won! Well done. Amazing job. You deserved this win."',
    event: "race.finished",
    data: { position: 1, classPosition: 1, isMultiClass: false },
  },
  {
    id: "race-end-second",
    category: "Race",
    label: "Race over — P2 (second place)",
    description: 'Race finished, P2. Engineer says "<Name>, that\'s second place. Very well done."',
    event: "race.finished",
    data: { position: 2, classPosition: 2, isMultiClass: false },
  },
  {
    id: "race-end-third",
    category: "Race",
    label: "Race over — P3 (podium)",
    description: 'Race finished, P3. Engineer says "<Name>, we made it to the podium. We\'re third. Well done."',
    event: "race.finished",
    data: { position: 3, classPosition: 3, isMultiClass: false },
  },
  {
    id: "race-end-mid-pack",
    category: "Race",
    label: "Race over — P9 (mid-pack)",
    description:
      'Race finished, P9. Engineer says "<Name>, the race is over. The final result for us is pee nine." Tests the composed P4+ readout.',
    event: "race.finished",
    data: { position: 9, classPosition: 9, isMultiClass: false },
  },
  {
    id: "race-end-multi-class-class-win",
    category: "Race",
    label: "Race over — multi-class P15 / class P1",
    description:
      'Multi-class race finish — overall P15 but class winner. Engineer says "<Name>, we won!" (class wins narrate as a win, same rule as #566).',
    event: "race.finished",
    data: { position: 15, classPosition: 1, isMultiClass: true },
  },
];
