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
import {
  type RaceStartSnapshot,
  type SimEventName,
  type StartCountdownSeconds,
  TrackWetness,
} from "@iracedeck/event-bus";
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
  /**
   * Optional snapshot for the race-start scenario (issue #568). Same mechanism
   * as `qualifyingInvalidationSnapshot`: the UI POSTs `/api/race-start/snapshot`
   * BEFORE publishing `event` (always `session.changed`), so the scenario's
   * resolver returns the intended snapshot — including the grid position, which
   * the production translator reads from `QualifyResultsInfo` rather than the
   * event payload. Lets QA exercise each position clause deterministically.
   */
  raceStartSnapshot?: RaceStartSnapshot;
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

function startLight(id: string, label: string, event: SimEventName, description?: string): ScenarioShortcut {
  return { id: `start-${id}`, category: "Start", label, description, event, data: {} };
}

function startCountdown(seconds: StartCountdownSeconds): ScenarioShortcut {
  return {
    id: `start-countdown-${seconds}`,
    category: "Start",
    label: `Countdown ${seconds}`,
    description: `Start countdown number — ${seconds} seconds to go`,
    event: "startLight.countdown.raised",
    data: { seconds },
  };
}

function rollingStart(id: string, label: string, event: SimEventName, description?: string): ScenarioShortcut {
  return { id: `rolling-start-${id}`, category: "Rolling Start", label, description, event, data: {} };
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
  snapshot: Omit<QualifyingInvalidationSnapshot, "lapStartedFromPits" | "lapCounted"> & {
    lapStartedFromPits?: boolean;
    lapCounted?: boolean;
  },
  options: { description?: string; incidentType?: string; delta?: number } = {},
): ScenarioShortcut {
  return {
    id: `qualifying-invalidation-${id}`,
    category: "Qualifying Invalidation",
    label,
    description: options.description,
    event: "incident.occurred",
    data: { delta: options.delta ?? 1, type: options.incidentType ?? "off-track" },
    qualifyingInvalidationSnapshot: { lapStartedFromPits: false, lapCounted: true, ...snapshot },
  };
}

/**
 * Race-start shortcut (issue #568). Each carries a fully-formed
 * `raceStartSnapshot` so the UI sets it via `/api/race-start/snapshot` before
 * publishing `session.changed` — letting QA exercise each position clause
 * deterministically. `playerCarPosition` is the **1-indexed** value the
 * scenario speaks (P1 → pole, P2..P64 → composed, > P64 / undefined → clause
 * skipped); the production translator derives it from `QualifyResultsInfo`,
 * but the harness supplies it directly. Other snapshot fields use fixed
 * sample values — they drive the temp/wetness brief, not the position clause.
 */
function raceStart(
  id: string,
  label: string,
  playerCarPosition: number | undefined,
  description: string,
  from = 0,
): ScenarioShortcut {
  return {
    id: `race-start-${id}`,
    category: "Race Start",
    label,
    description,
    event: "session.changed",
    data: { from, to: 1 },
    raceStartSnapshot: {
      driverName: "niklas",
      trackTemp: 28,
      airTemp: 20,
      tempUnit: "celsius",
      wetness: TrackWetness.Dry,
      playerCarPosition,
    },
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
  flag("White — Last Lap Started", "flag.white-last-lap.raised"),
  flag("Checkered", "flag.checkered.raised"),
  flag("Blue", "flag.blue.raised"),
  flag("Black", "flag.black.raised"),
  flag("Red", "flag.red.raised"),
  flag("Debris", "flag.debris.raised"),
  flag("Meatball", "flag.meatball.raised"),
  flag("Crossed", "flag.crossed.raised"),
  flag("One Pace Lap to Go", "flag.one-pace-lap-to-go.raised"),
  flag("Green Held", "flag.green-held.raised"),
  flag("Ten to Go", "flag.ten-to-go.raised"),
  flag("Five to Go", "flag.five-to-go.raised"),
  flag("Disqualify", "flag.disqualify.raised"),
  flag("Furled", "flag.furled.raised"),
  flag("Furled Cleared", "flag.furled.cleared"),
  flag("DQ — Scoring Invalid", "flag.dq-scoring-invalid.raised"),
  flag("Yellow Waving", "flag.yellow-waving.raised"),
  flag("Caution Waving", "flag.caution-waving.raised"),
  {
    id: "flag-white-leader",
    category: "Flags",
    label: "Leader's final lap",
    description: 'The overall leader starts their final lap — "The leader is about to start their final lap."',
    event: "flag.white-leader.raised",
    data: {},
  },

  // ── Start (issues #480 / #673) ──
  // Start-gantry lines + the per-number start countdown. The gantry lines carry
  // no payload; the countdown fires `startLight.countdown.raised` once per number
  // with the chosen `seconds` (90/60/30/10 — 90 added in #673). Fire two
  // countdown buttons in quick succession to confirm same-family preempt.
  startLight("start-ready", "Ready", "startLight.start-ready.raised", "Start gantry: Ready"),
  startLight("start-go", "Go", "startLight.start-go.raised", "Start gantry: Go"),
  startCountdown(90),
  startCountdown(60),
  startCountdown(30),
  startCountdown(10),

  // ── Rolling Start (issue #660) ──
  // Payload-less: the pace car begins moving the field onto the formation lap.
  rollingStart(
    "pace-car-moving",
    "Pace car moving",
    "rollingStart.pace-car-moving.raised",
    "Rolling start: pace car begins moving the field into the formation lap",
  ),

  // ── Pit Window (issue #655) ──
  // `pitsOpen.changed` directly — bypasses the race-only / replay-only diff
  // gating so you hear the open / closed line without driving `PitsOpen` through
  // `/api/telemetry`. Same-family preempt: fire both in quick succession to
  // confirm the second cancels the first.
  {
    id: "pit-window-opened",
    category: "Pit Window",
    label: "Pits opened",
    description: 'Pit road just opened for the player — engineer says "Pits are open."',
    event: "pitsOpen.changed",
    data: { from: false, to: true },
  },
  {
    id: "pit-window-closed",
    category: "Pit Window",
    label: "Pits closed",
    description: 'Pit road just closed for the player — engineer says "Pits are closed."',
    event: "pitsOpen.changed",
    data: { from: true, to: false },
  },

  // ── Opponent Pit (issue #622) ──
  // `opponentPit.entered` directly — bypasses the diff's race-only /
  // aggregation gating so each relation line is auditionable on demand. The
  // nearby number speaks the payload position (the harness snapshot resolver
  // reads the cached payload; there's no live telemetry read here).
  {
    id: "opponent-pit-leader",
    category: "Opponent Pit",
    label: "Leader pitting",
    description: 'The race leader dives into the pits — "The leader is pitting."',
    event: "opponentPit.entered",
    data: { relation: "leader", carIdx: 3, position: 1 },
  },
  {
    id: "opponent-pit-ahead",
    category: "Opponent Pit",
    label: "Car ahead pitting",
    description: 'The car directly ahead pits — "The car ahead is pitting."',
    event: "opponentPit.entered",
    data: { relation: "ahead", carIdx: 11, position: 4 },
  },
  {
    id: "opponent-pit-behind",
    category: "Opponent Pit",
    label: "Car behind pitting",
    description: 'The car directly behind pits — "The car behind is pitting."',
    event: "opponentPit.entered",
    data: { relation: "behind", carIdx: 12, position: 6 },
  },
  {
    id: "opponent-pit-nearby",
    category: "Opponent Pit",
    label: "P7 pitting (±2)",
    description: 'A car two positions away pits — "The car in, P7, is pitting."',
    event: "opponentPit.entered",
    data: { relation: "nearby", carIdx: 13, position: 7 },
  },
  {
    id: "opponent-pit-others",
    category: "Opponent Pit",
    label: "Several cars pitting",
    description: 'The aggregate tail — "And it seems there are other cars pitting as well."',
    event: "opponentPit.entered",
    data: { relation: "others" },
  },

  // ── Opponent Flags (issue #936) ──
  // `opponentFlag.flagged` directly — bypasses the diff's aggregation gating so
  // each relation × flag line is auditionable on demand. The flags are: black,
  // furled, meatball, disqualify. The relations are: ahead / behind / track-ahead
  // for flags that matter to race strategy, plus "others" for aggregate. The
  // trigger types are: raised (black/furled/meatball/disqualify), entered-range
  // (track-ahead only). Similar payload style to opponent-pit.
  {
    id: "opponent-flag-ahead-black",
    category: "Opponent Flags",
    label: "P5 ahead: black flag",
    description: 'Car ahead got black-flagged — "The car ahead has been black-flagged."',
    event: "opponentFlag.flagged",
    data: { relation: "ahead", carIdx: 7, flag: "black", trigger: "raised", position: 5 },
  },
  {
    id: "opponent-flag-ahead-furled",
    category: "Opponent Flags",
    label: "P5 ahead: furled",
    description: 'Car ahead got a furled warning — "The car ahead has a black flag warning."',
    event: "opponentFlag.flagged",
    data: { relation: "ahead", carIdx: 7, flag: "furled", trigger: "raised", position: 5 },
  },
  {
    id: "opponent-flag-ahead-meatball",
    category: "Opponent Flags",
    label: "P5 ahead: meatball",
    description: 'Car ahead got penalized pit-stop call — "The car ahead has been given a pit stop."',
    event: "opponentFlag.flagged",
    data: { relation: "ahead", carIdx: 7, flag: "meatball", trigger: "raised", position: 5 },
  },
  {
    id: "opponent-flag-ahead-disqualify",
    category: "Opponent Flags",
    label: "P5 ahead: DQ",
    description: 'Car ahead was disqualified — "The car ahead has been disqualified."',
    event: "opponentFlag.flagged",
    data: { relation: "ahead", carIdx: 7, flag: "disqualify", trigger: "raised", position: 5 },
  },
  {
    id: "opponent-flag-behind-black",
    category: "Opponent Flags",
    label: "Behind: black flag",
    description: 'Car behind got black-flagged — "The car behind has been black-flagged."',
    event: "opponentFlag.flagged",
    data: { relation: "behind", carIdx: 12, flag: "black", trigger: "raised" },
  },
  {
    id: "opponent-flag-behind-furled",
    category: "Opponent Flags",
    label: "Behind: furled",
    description: 'Car behind got a furled warning — "The car behind has a black flag warning."',
    event: "opponentFlag.flagged",
    data: { relation: "behind", carIdx: 12, flag: "furled", trigger: "raised" },
  },
  {
    id: "opponent-flag-behind-meatball",
    category: "Opponent Flags",
    label: "Behind: meatball",
    description: 'Car behind got penalized pit-stop call — "The car behind has been given a pit stop."',
    event: "opponentFlag.flagged",
    data: { relation: "behind", carIdx: 12, flag: "meatball", trigger: "raised" },
  },
  {
    id: "opponent-flag-behind-disqualify",
    category: "Opponent Flags",
    label: "Behind: DQ",
    description: 'Car behind was disqualified — "The car behind has been disqualified."',
    event: "opponentFlag.flagged",
    data: { relation: "behind", carIdx: 12, flag: "disqualify", trigger: "raised" },
  },
  {
    id: "opponent-flag-track-ahead-black",
    category: "Opponent Flags",
    label: "Track ahead: black flag",
    description: 'Car on track ahead has a black flag — "The car on track ahead has a black flag."',
    event: "opponentFlag.flagged",
    data: { relation: "track-ahead", carIdx: 13, flag: "black", trigger: "entered-range", gapSeconds: 8 },
  },
  {
    id: "opponent-flag-track-ahead-furled",
    category: "Opponent Flags",
    label: "Track ahead: furled",
    description: 'Car on track ahead has a furled warning — "The car on track ahead has a black flag warning."',
    event: "opponentFlag.flagged",
    data: { relation: "track-ahead", carIdx: 13, flag: "furled", trigger: "entered-range", gapSeconds: 8 },
  },
  {
    id: "opponent-flag-track-ahead-meatball",
    category: "Opponent Flags",
    label: "Track ahead: meatball",
    description: 'Car on track ahead got penalized pit-stop call — "The car on track ahead has a meatball."',
    event: "opponentFlag.flagged",
    data: { relation: "track-ahead", carIdx: 13, flag: "meatball", trigger: "entered-range", gapSeconds: 8 },
  },
  {
    id: "opponent-flag-track-ahead-disqualify",
    category: "Opponent Flags",
    label: "Track ahead: DQ",
    description: 'Car on track ahead was disqualified — "The car on track ahead has been disqualified."',
    event: "opponentFlag.flagged",
    data: { relation: "track-ahead", carIdx: 13, flag: "disqualify", trigger: "entered-range", gapSeconds: 8 },
  },
  {
    id: "opponent-flag-others",
    category: "Opponent Flags",
    label: "Several cars flagged",
    description: 'The aggregate tail — "And it seems there are other cars with flags as well."',
    event: "opponentFlag.flagged",
    data: { relation: "others" },
  },

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
  // One shortcut per IncidentType the bus publishes (issue #530), plus
  // delta-varied buttons (issue #922). The diff classifies the iRacing
  // report byte before publishing, so the harness mirrors that vocabulary
  // directly. Per-type point weights are NOT fixed across iRacing content
  // (dirt-road car contact scores 2x, not 4x) — the spoken count is always
  // composed from `delta`, the new points detected for the incident, so the
  // varied buttons exercise count selection without iRacing.
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
    description: "Light wall rub — intro only, no count clause for a zero delta.",
    event: "incident.occurred",
    data: { delta: 0, type: "contact-world" },
  },
  {
    id: "incident-collision-world",
    category: "Incidents",
    label: "Collision — Wall (2x)",
    description: "Heavier wall hit — engineer announces the detected 2-point count.",
    event: "incident.occurred",
    data: { delta: 2, type: "collision-world" },
  },
  {
    id: "incident-contact-car",
    category: "Incidents",
    label: "Contact — Car (0x)",
    description: "Light car-to-car rub — intro only, no count clause for a zero delta.",
    event: "incident.occurred",
    data: { delta: 0, type: "contact-car" },
  },
  {
    id: "incident-contact-car-1x",
    category: "Incidents",
    label: "Contact — Car (1x)",
    description: "Car contact that scored a point — contact intro plus one-point count.",
    event: "incident.occurred",
    data: { delta: 1, type: "contact-car" },
  },
  {
    id: "incident-collision-car",
    category: "Incidents",
    label: "Collision — Car (4x)",
    description: "Heavier car-to-car hit — engineer announces the detected 4-point count.",
    event: "incident.occurred",
    data: { delta: 4, type: "collision-car" },
  },
  {
    id: "incident-collision-car-2x",
    category: "Incidents",
    label: "Collision — Car (2x, dirt)",
    description: "The issue #922 repro: dirt-road car collision scoring 2x — announces two points, not four.",
    event: "incident.occurred",
    data: { delta: 2, type: "collision-car" },
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
  // time-limited (core only), session gating, the per-lap latch, the
  // pit-exit-lap suppression, and the beyond-counted-laps suppression (#776).
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
  qualifyingInvalidation(
    "beyond-counted-laps-silent",
    "Off-Track beyond counted laps (silent)",
    {
      sessionType: "qualifying",
      sessionNum: 1,
      lapsRemaining: 0,
      lapLimited: true,
      lapCompleted: 4,
      lapCounted: false,
    },
    {
      description:
        "Lap 3+ of a 2-lap qualifying (lapCounted=false, issue #776) — the driver kept circulating after the counted attempts were done, so nothing is invalidated and no audio plays. Contrast with the out-of-laps shortcut, which is the FINAL counted lap (lapCounted=true).",
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
      "No position-number clip exists for P65 (the default voice ships 1..64), so the callout aborts at expansion (issues #835/#836) — no audio plays.",
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
  // Invalid-lap prefix (issue #572). When the just-completed lap is flagged
  // invalid by iRacing, the position scenario prepends "That lap didn't count."
  // and forces the worse-framing intro — no pole, no "better" branch. Each
  // shortcut sets `lapIsValid: false` so the invalid branch fires regardless
  // of position delta.
  {
    id: "position-invalid-unchanged",
    category: "Position",
    label: "Invalid lap, unchanged P5",
    description:
      "Invalid lap with unchanged position — engineer says \"That lap didn't count. We're currently pee five.\" Verifies the prefix lands on the status-update path.",
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
      lapIsValid: false,
    },
  },
  {
    id: "position-invalid-worsened",
    category: "Position",
    label: "Invalid lap, worsened 3 → 5",
    description:
      "Invalid lap with worsened position — engineer says \"That lap didn't count. We're currently pee five.\" Verifies the prefix lands on the worsened path.",
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
      lapIsValid: false,
    },
  },
  {
    id: "position-invalid-improved-on-paper",
    category: "Position",
    label: "Invalid lap, improved on paper 5 → 3",
    description:
      'Invalid lap with standings shifted from others\' laps — engineer still uses worse framing: "That lap didn\'t count. We\'re currently pee three." Verifies the invalid branch beats the "better" framing.',
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
      lapIsValid: false,
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

  // Race start (issue #568). Each shortcut publishes `session.changed` AND
  // carries a `raceStartSnapshot` the UI pushes to `/api/race-start/snapshot`
  // first — so the scenario's resolver returns the intended grid position at
  // fire time (the production translator reads it from `QualifyResultsInfo`,
  // not from the event payload). The scenario still gates on
  // `getSessionType() === "race"`, so set the session type to a race session
  // (via the session picker / a race preset) for these to fire. Each variant
  // exercises a distinct position clause; the ~3 s `triggerDelay` applies.
  raceStart(
    "p1",
    "Race start — P1 (pole)",
    1,
    'Pole start. Engineer says "Time to race, <Name>. Starting from pole. Well done. <conditions>."',
  ),
  raceStart(
    "p5",
    "Race start — P5",
    5,
    'Composed position clause. Engineer says "Time to race, <Name>. Qualifying put us to P 5. <conditions>."',
  ),
  raceStart(
    "p30",
    "Race start — P30",
    30,
    'Mid-pack composed clause. Engineer says "Time to race, <Name>. Qualifying put us to P 30. <conditions>."',
  ),
  raceStart(
    "p65",
    "Race start — P65 (out of range)",
    65,
    "No position-number clip exists for P65, so the optional position clause skips (issue #836); greeting + conditions still play.",
  ),
  raceStart(
    "no-position",
    "Race start — no position",
    undefined,
    "Grid position unavailable (QualifyResultsInfo miss). Position clause skipped; greeting + conditions still play.",
  ),

  // Fresh-connect variants (issue #871). The translator's mid-session connect
  // synthesis marks itself with `from: -1`; the race-start `where:` rejects it
  // when the race is already underway (SessionState Racing / post-race) and
  // still briefs on the pre-green grid. The gate reads the event envelope's
  // telemetry, which `/api/bus/publish` fills from the live mock state — so
  // apply the named telemetry preset BEFORE clicking. Like every Race Start
  // shortcut, the scenario also gates on `getSessionType() === "race"`, so a
  // race session preset must be active or the where: rejects before the #871
  // gate is ever reached.
  raceStart(
    "fresh-connect-grid",
    "Fresh connect — pre-green grid (briefs)",
    3,
    "Synthetic fresh-connect session.changed (from: -1) while the race hasn't gone green. Apply the race session preset AND the on-grid telemetry preset first (SessionState: Warmup) — the grid brief still plays (issue #871).",
    -1,
  ),
  raceStart(
    "fresh-connect-mid-race",
    "Fresh connect — mid-race (suppressed)",
    3,
    "Synthetic fresh-connect session.changed (from: -1) with the race underway. Apply the race session preset AND the hot-lap telemetry preset first (SessionState: Racing) — no brief plays (issue #871).",
    -1,
  ),

  // ── Overtakes (issue #574) ──
  // Fire the bus events directly so you hear/see the scenario without driving
  // `PlayerCarPosition` through `/api/telemetry` and waiting for the 3000 ms
  // hold + 10 m gap gates to settle. Same-family preempt: fire two in a row
  // to confirm the second cancels the first.
  {
    id: "overtake-gained-p5",
    category: "Overtakes",
    label: "Gained — now P5",
    description:
      'Player passed someone and held the new P5 for the sustainment window. Engineer says "Nice pass. That puts us to pee five."',
    event: "overtake.completed",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 5,
      previousPosition: 6,
      gapBehindMeters: 15,
      isLeader: false,
    },
  },
  {
    id: "overtake-gained-leader",
    category: "Overtakes",
    label: "Gained the lead (P2 → P1)",
    description:
      "Player took P1. Engineer fires the dedicated leader line: \"Nice pass! We're now leading race. Let's keep it that way!\"",
    event: "overtake.completed",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 1,
      previousPosition: 2,
      gapBehindMeters: 15,
      isLeader: true,
    },
  },
  {
    id: "overtake-lost-p5",
    category: "Overtakes",
    label: "Lost — now P5",
    description:
      "Player was passed and dropped from P4 to P5. Engineer says \"Come on, <name>. Don't give up positions like that. We're now in pee five.\"",
    event: "overtake.lost",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 5,
      previousPosition: 4,
      gapAheadMeters: 15,
    },
  },
  {
    id: "overtake-gained-multi-class",
    category: "Overtakes",
    label: "Gained — multi-class (class P3 → P2)",
    description:
      'Multi-class gain — overall P12 (unchanged) but class position improved P3 → P2. Engineer fires the dedicated P2 line on the CLASS position: "Nice pass! Up to second in class. The class lead is in our sights."',
    event: "overtake.completed",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 12,
      previousPosition: 12,
      classPosition: 2,
      previousClassPosition: 3,
      isMultiClass: true,
      gapBehindMeters: 15,
      isLeader: false,
    },
  },
  {
    id: "overtake-gained-p2",
    category: "Overtakes",
    label: "Gained — P3 → P2 (podium line)",
    description:
      'Player took P2 (podium, always reacts). Engineer fires the dedicated P2 line: "Nice pass! We\'re up to second. The lead is in our sights." No follow-up readout (the line states the position).',
    event: "overtake.completed",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 2,
      previousPosition: 3,
      gapBehindMeters: 15,
      isLeader: false,
    },
  },
  {
    id: "overtake-gained-p3",
    category: "Overtakes",
    label: "Gained — P4 → P3 (podium line)",
    description:
      "Player took P3 (podium, always reacts). Engineer fires the dedicated P3 line: \"Nice pass! That's the podium — we're third.\" No follow-up readout.",
    event: "overtake.completed",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 3,
      previousPosition: 4,
      gapBehindMeters: 15,
      isLeader: false,
    },
  },
  {
    id: "overtake-gained-retirement",
    category: "Overtakes",
    label: "Gained — retirement (readout only)",
    description:
      'A non-finished car ahead left the world (DNF / disconnect), promoting the player P14 → P13. `fromRetirement: true` suppresses the "Nice pass" reaction — only the position readout fires: "We\'re currently pee thirteen." (issue #603)',
    event: "overtake.completed",
    data: {
      carIdx: 0,
      sustained: 3000,
      position: 13,
      previousPosition: 14,
      isLeader: false,
      fromRetirement: true,
    },
  },

  // ── Pit Box (issue #600) ──
  // Fire each count-in mark directly so you hear the clip without driving
  // LapDistPct toward DriverPitTrkPct through `/api/telemetry`. Same-family
  // preempt: fire two in a row to confirm the second cancels the first.
  {
    id: "pit-box-five",
    category: "Pit Box",
    label: "Five (120 m)",
    description: "Count-in mark fired at 120 m remaining to the pit box.",
    event: "pitBox.countdown",
    data: { mark: "five" },
  },
  {
    id: "pit-box-four",
    category: "Pit Box",
    label: "Four (100 m)",
    description: "Count-in mark fired at 100 m remaining to the pit box.",
    event: "pitBox.countdown",
    data: { mark: "four" },
  },
  {
    id: "pit-box-three",
    category: "Pit Box",
    label: "Three (80 m)",
    description: "Count-in mark fired at 80 m remaining to the pit box.",
    event: "pitBox.countdown",
    data: { mark: "three" },
  },
  {
    id: "pit-box-two",
    category: "Pit Box",
    label: "Two (60 m)",
    description: "Count-in mark fired at 60 m remaining to the pit box.",
    event: "pitBox.countdown",
    data: { mark: "two" },
  },
  {
    id: "pit-box-one",
    category: "Pit Box",
    label: "One (40 m)",
    description: "Count-in mark fired at 40 m remaining to the pit box.",
    event: "pitBox.countdown",
    data: { mark: "one" },
  },
  {
    id: "pit-box-pit-now",
    category: "Pit Box",
    label: "Pit now (20 m)",
    description: "Final count-in cue fired at 20 m remaining to the pit box.",
    event: "pitBox.countdown",
    data: { mark: "pit-now" },
  },

  // ── Corner names (issue #888) ──
  // Fire the event directly so you audition name clips without driving a
  // practice lap. Fire two in a row to confirm same-family preemption.
  {
    id: "corner-name-eau-rouge",
    category: "Corner Names",
    label: "Eau Rouge",
    description: "Corner-name callout for a named corner (practice/test).",
    event: "cornerName.approaching",
    data: { name: "Eau Rouge", slug: "eau-rouge" },
  },
  {
    id: "corner-name-turn-5",
    category: "Corner Names",
    label: "Turn 5",
    description: 'Corner-name callout for a numbered corner — spoken as "Turn five".',
    event: "cornerName.approaching",
    data: { name: "Turn 5", slug: "turn-5" },
  },

  // ── Gaps (issue #933) ──
  // Fire each gap callout path directly. The spoken gap number reads LIVE
  // gaps at speak time from the REAL translator the harness boots, so the
  // readout clause is heard once the mock telemetry actually produces a gap
  // for that side (green-flag race, neighbor on the lead lap, traces warm)
  // AND the shortcut's `carIdx` still matches that live neighbor. Otherwise
  // the clause skips and you hear the line alone — the real cold-start
  // behavior (issue #835: an unresolvable optional clause skips, never
  // aborts the callout).
  {
    id: "gap-trend-ahead-closing",
    category: "Gaps",
    label: "Trend: closing on car ahead",
    description: "Contact projection entered the horizon — we're catching the car ahead.",
    event: "gap.trendChanged",
    data: { side: "ahead", direction: "closing", gapSeconds: 1.8, ratePerLap: -0.8, lapsToContact: 2.3, carIdx: 3 },
  },
  {
    id: "gap-trend-ahead-opening",
    category: "Gaps",
    label: "Trend: car ahead pulling away",
    description: "Breakaway — we're losing touch with the car ahead.",
    event: "gap.trendChanged",
    data: { side: "ahead", direction: "opening", gapSeconds: 3.1, ratePerLap: 0.9, carIdx: 3 },
  },
  {
    id: "gap-trend-behind-closing",
    category: "Gaps",
    label: "Trend: car behind gaining",
    description: "Contact projection entered the horizon — the car behind is closing in.",
    event: "gap.trendChanged",
    data: { side: "behind", direction: "closing", gapSeconds: 1.4, ratePerLap: -0.6, lapsToContact: 2.3, carIdx: 5 },
  },
  {
    id: "gap-trend-behind-opening",
    category: "Gaps",
    label: "Trend: dropping the car behind",
    description: "Breakaway — we're pulling away from the car behind.",
    event: "gap.trendChanged",
    data: { side: "behind", direction: "opening", gapSeconds: 2.8, ratePerLap: 0.8, carIdx: 5 },
  },
  {
    id: "gap-threshold-ahead",
    category: "Gaps",
    label: "Caught the car ahead (threshold)",
    description: "Live gap ahead first dropped under the alert threshold.",
    event: "gap.thresholdCrossed",
    data: { side: "ahead", gapSeconds: 0.9, thresholdSeconds: 1.0, carIdx: 3 },
  },
  {
    id: "gap-threshold-behind",
    category: "Gaps",
    label: "Car behind within threshold",
    description: "Live gap behind first dropped under the alert threshold.",
    event: "gap.thresholdCrossed",
    data: { side: "behind", gapSeconds: 0.8, thresholdSeconds: 1.0, carIdx: 5 },
  },

  // ── Fuel (issue #838) ──
  // Fire each laps-of-fuel-left count directly so you hear the clip without
  // burning down a real tank through `/api/telemetry`. Count 0 is the
  // dedicated box-this-lap call. Same-family preempt: fire two in a row to
  // confirm the second cancels the first.
  ...[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((count) => ({
    id: `fuel-laps-left-${count}`,
    category: "Fuel",
    label: `${count} lap${count === 1 ? "" : "s"} of fuel left`,
    description: `Estimated ${count} full lap${count === 1 ? "" : "s"} of fuel after completing the current lap.`,
    event: "fuel.lapsLeft.crossed" as const,
    data: { count, lapsLeft: count + 0.4 },
  })),
  {
    id: "fuel-laps-left-box",
    category: "Fuel",
    label: "Box this lap",
    description: "The tank won't cover another full lap — box this lap for fuel (count 0).",
    event: "fuel.lapsLeft.crossed",
    data: { count: 0, lapsLeft: 0.4 },
  },
  {
    id: "fuel-race-covered",
    category: "Fuel",
    label: "Enough fuel to finish",
    description:
      "The tank covers what's left of the race (issue #880) — the one-time confirmation spoken inside the last 10 laps.",
    event: "fuel.lapsLeft.raceCovered",
    data: {},
  },
];
