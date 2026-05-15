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
import { type SimEventName, TrackWetness } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";

export type ScenarioShortcut = {
  id: string;
  category: string;
  label: string;
  description?: string;
  event: SimEventName;
  data: Record<string, unknown>;
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
];
