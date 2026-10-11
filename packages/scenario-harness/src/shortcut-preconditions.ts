/**
 * Preconditions a scenario shortcut can declare (issue #1127).
 *
 * A shortcut that drives the translator depends on harness state it does not
 * set up itself, and the failure mode when that state is missing is the worst
 * kind: PART of the run goes silent. Pressing a caution button with no session
 * preset applied plays every flag-driven line and drops every lineup-driven one
 * — `resolvePaceLineup` reads `DriverInfo.DriverCarIdx` to know who the
 * player is and returns `null` outright without it, while the caution's own
 * speak gate is flag-only — leaving nothing in the UI and one
 * `optional clause skipped — var {{caution.followCarNumber}} resolved to
 * nothing` in a debug log. A tester who hears that learns to distrust the
 * callouts rather than the setup.
 *
 * So a shortcut names what it needs, and the harness REFUSES to start it with
 * a message saying what is missing and how to fix it. It deliberately does not
 * fix it: the tester arranged whatever session state they have on purpose, and
 * a button that silently applies a preset over it is a worse surprise than a
 * refusal.
 *
 * The reason text lives on the rule rather than on each shortcut, so the three
 * caution buttons cannot drift from each other's wording.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import {
  isOvalTrack,
  type PaceLineup,
  parseTrackLengthMeters,
  resolvePaceLineup,
  resolvePlayerCarIdx,
} from "@iracedeck/sim-events-iracing";

import {
  FORMATION_LAP_DIST_PCT,
  FORMATION_PACE_LINE,
  FORMATION_PACE_ROW,
  FORMATION_SESSION_STATE,
  FORMATION_TRACK_SURFACE,
} from "./rolling-start-grid.js";

/**
 * What a shortcut can require of the harness before it will run.
 *
 * `player-car-index` — session info names the player's car. Every `caution.*`
 * script variable reads the lineup, which needs it.
 *
 * `sdk-connected` — the mock SDK is connected (#1349). The overtake gate reads
 * the translator's latest telemetry, which a disconnected translator never
 * receives, so an overtake or gap line would be refused by its own gate while
 * the button looked as if it had worked. The rolling-start buttons need it for
 * the same reason one step removed (#1167): their callouts ask the translator
 * whether a formation is running, and a translator that sees no ticks never
 * opens one. So does the caution catch-up button (#1168): its two calls ask
 * whether the gap to the car ahead is open, which a translator that sees no
 * ticks never judges — the button would run for a minute and play nothing.
 *
 * `rolling-start-grid` — the translator would read the rolling-start buttons'
 * grid as a GRID in the session the harness holds (#1167): a race session,
 * naming the player's car and the pace car. Without it the formation calls
 * are refused by their own race-only gate, or lose the car to form up behind.
 *
 * `rolling-start-oval-grid` — that, and the translator would name the LANE:
 * the track is an oval. What "Formation (oval, two laps)" auditions is the
 * lane wording, so unlike the caution buttons, which treat the lane as an
 * enrichment and run on a road course too, that button is refused without it.
 *
 * `track-length` — session info carries a track length the translator can
 * read (#1168). The catch-up button's gap is a lap fraction times it; without
 * one the translator measures no gap on any tick, so the caution plays and
 * neither catch-up call ever does.
 */
export type ShortcutPrecondition =
  "player-car-index" | "sdk-connected" | "rolling-start-grid" | "rolling-start-oval-grid" | "track-length";

/** The live harness state a precondition is checked against, read by the route on every start. */
export type HarnessPreconditionState = {
  sessionInfo: Record<string, unknown> | null;
  isConnected: boolean;
  /**
   * The mock's current telemetry. Read for the session it is in
   * (`SessionNum`): whether a session is a race is a question about one entry
   * of the session list, and the translator answers it against this.
   */
  telemetry: TelemetryData;
};

type PreconditionRule = {
  /** True when the harness satisfies the requirement. */
  satisfied: (state: HarnessPreconditionState) => boolean;
  /** What is missing and how to fix it. Shown to the tester verbatim. */
  reason: string;
};

/**
 * Whether session info names the player's car — asked of the translator's own
 * `resolvePlayerCarIdx`, the read this precondition exists to get ahead of,
 * rather than of a restatement of it. A restated rule drifts the moment the
 * resolver tightens, and a check that admits a value the resolver rejects lets
 * the half-silent run through anyway, which is the whole failure it is here to
 * prevent.
 */
function namesPlayerCar(sessionInfo: Record<string, unknown> | null): boolean {
  return resolvePlayerCarIdx(sessionInfo) !== null;
}

/**
 * What the translator's lineup reader makes of the rolling-start buttons' grid
 * in the session the harness holds (issue #1167) — the read their callouts
 * will make at speak time, made here before the run.
 *
 * Asked of `resolvePaceLineup` and `isOvalTrack` themselves, for the reason
 * {@link namesPlayerCar} asks `resolvePlayerCarIdx`: the grid frame is several
 * rules at once — a race session, in a known pre-green state, naming the
 * player's car and the pace car, the pace car holding no row and one car on
 * pole — and a copy of any of them here would drift the day the reader
 * tightened, admitting the very run this check exists to refuse. The
 * telemetry is the grid the buttons patch in (`rolling-start-grid.ts`) over
 * the session number the mock is in, so the answer is about THIS grid in THIS
 * session and nothing has to be assumed about either.
 */
function readFormationGrid(state: HarnessPreconditionState): PaceLineup | null {
  const telemetry = {
    SessionNum: state.telemetry.SessionNum,
    SessionState: FORMATION_SESSION_STATE,
    CarIdxPaceLine: FORMATION_PACE_LINE,
    CarIdxPaceRow: FORMATION_PACE_ROW,
    CarIdxLapDistPct: FORMATION_LAP_DIST_PCT,
    CarIdxTrackSurface: FORMATION_TRACK_SURFACE,
  } as TelemetryData;

  return resolvePaceLineup(telemetry, state.sessionInfo, isOvalTrack(state.sessionInfo));
}

const PRECONDITION_RULES: Record<ShortcutPrecondition, PreconditionRule> = {
  "player-car-index": {
    satisfied: (state) => namesPlayerCar(state.sessionInfo),
    reason:
      "Apply a session preset first. This sequence's caution lines read the driver list to work out which car is yours " +
      "(DriverInfo.DriverCarIdx), so without one the follow-car, restart-position and lane lines are all silent while the " +
      'flag lines still play — a half-silent run that reads as broken callouts. The "race" preset is the one the ' +
      'description asks for; "race-oval" is the same 18-car field on an oval, which additionally names the lane a ' +
      "double-file restart forms up in.",
  },
  "sdk-connected": {
    satisfied: (state) => state.isConnected,
    reason:
      'Connect the mock SDK first (the "Connected" toggle in the header). This callout checks a gate that reads what ' +
      "the translator has seen: the overtake gate reads live telemetry (on track, at racing speed, off pit road, " +
      "nobody alongside), a rolling-start call asks whether a formation is running, and a catch-up call asks whether " +
      "your gap under caution is open. The button arranges that itself, but a disconnected translator receives no " +
      "telemetry, so the gate stays shut and the line is silent for the wrong reason.",
  },
  "rolling-start-grid": {
    satisfied: (state) => readFormationGrid(state)?.anchor === "grid",
    reason:
      'Apply the "race" or "race-oval" session preset first. The rolling-start buttons form the field up on a grid ' +
      "indexed for that roster (the pace car at index 0, your car at index 7), and the translator reads it as a grid " +
      "only in a race session whose driver list names both (DriverInfo.DriverCarIdx, DriverInfo.PaceCarIdx). Without " +
      "one the formation calls are refused by their own race-only gate, or lose the car you form up behind, and the " +
      "button reads as broken callouts rather than as a session that was never set up.",
  },
  "rolling-start-oval-grid": {
    satisfied: (state) => {
      const grid = readFormationGrid(state);

      return grid?.anchor === "grid" && grid.line !== null;
    },
    reason:
      'Apply the "race-oval" session preset first. This run auditions the lane wording ("Inside line, behind car…"), ' +
      "which the translator names only on an oval running double file, in a race session whose driver list names your " +
      "car and the pace car (DriverInfo.DriverCarIdx, DriverInfo.PaceCarIdx). On any other session the formation " +
      "calls would speak without the lane or not at all, and the run would not be the one its description promises. " +
      'The "race" preset is the same field on a road course: Rolling Start → Pace car moving and → Car ahead ' +
      "changed run there, with no lane named.",
  },
  "track-length": {
    // The translator's own parse, the pure half of its cached track-length
    // read: asked, not restated, so "a usable track length" means here exactly
    // what it means to the diff that divides by it.
    satisfied: (state) => parseTrackLengthMeters(state.sessionInfo) !== null,
    reason:
      'Apply the "race" or "race-oval" session preset first, or give the session a WeekendInfo.TrackLength the sim ' +
      'would write (for example "2.38 km"). This run opens your gap to the car ahead by moving lap distances, and the ' +
      "translator turns a lap fraction into a gap by multiplying it by the track length: without one it measures no " +
      "gap at all, so the caution would play for a minute with neither catch-up call in it.",
  },
};

/**
 * The first unmet precondition's reason, or `null` when the shortcut may run.
 *
 * Necessary rather than sufficient, and deliberately so: a preset that names a
 * player car whose roster does not hold the rest of the field (`practice`, with
 * its empty driver list) still passes here and still resolves fewer lines than
 * the description promises. The bar is the one state whose absence silences the
 * lineup family WHOLESALE, not every state that could thin it out — a stricter
 * gate would start refusing runs the sequence supports.
 */
export function checkShortcutPreconditions(
  preconditions: readonly ShortcutPrecondition[] | undefined,
  state: HarnessPreconditionState,
): string | null {
  for (const name of preconditions ?? []) {
    const rule = PRECONDITION_RULES[name];

    if (!rule.satisfied(state)) return rule.reason;
  }

  return null;
}
