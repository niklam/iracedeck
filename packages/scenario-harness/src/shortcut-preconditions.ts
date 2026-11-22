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
import type { SessionClass } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import {
  classifySession,
  isOvalTrack,
  type PaceLineup,
  parseTrackLengthMeters,
  resolvePaceLineup,
  resolvePlayerCarIdx,
  resolveSessionType,
} from "@iracedeck/sim-events-iracing";

import {
  FORMATION_LAP_DIST_PCT,
  FORMATION_PACE_LINE,
  FORMATION_PACE_ROW,
  FORMATION_SESSION_STATE,
  FORMATION_TRACK_SURFACE,
} from "./rolling-start-grid.js";
import { TRAFFIC_PLAYER_CAR_IDX } from "./traffic-telemetry.js";

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
 * And the Fuel buttons (#1702): the fuel lines ask the translator which kind
 * of session it is, and it answers `null` until it has a tick to read the
 * session number from.
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
 *
 * `traffic-player-car` — session info names car {@link TRAFFIC_PLAYER_CAR_IDX}
 * as the player's (#1113): the slot the rejoin train writes the player into
 * (`traffic-telemetry.ts`). On a session naming another car the translator
 * reads that car's slot, which the train leaves out of the world, so the
 * detector never sees the player stop and the whole run is silent.
 *
 * `session-classified` — the Race Engineer can tell what kind of session the
 * mock is in (#1702): practice, test, qualifying or race, as
 * `classifySession` names it. The fuel countdown is heard per session kind,
 * through the "Speak in" toggles, and a session it cannot classify (the mock
 * boots with no session info) speaks no fuel line at all.
 *
 * `race-session` — that, and the session is a race (#1702). The enough-fuel
 * confirmation is the race countdown's closing line and is heard only there.
 *
 * `translator-session-current` — the translator's latest tick is in the
 * session the mock is in (#1702). The two rules above classify the mock's
 * telemetry, but the fuel gate classifies the translator's (`getSessionClass()`
 * reads the session number off its latest tick), and a telemetry write does
 * not reach the translator until the next tick. With the tick loop paused or
 * slowed, a session number changed by hand is one the precondition would see
 * and the gate would not: the button would be accepted and every fuel line
 * judged against the session before. Connecting and applying a session
 * preset open no such window (the mock delivers a tick on connect, and session
 * info is read live by both).
 *
 * `before-final-lap` — the player is not on their final lap and the
 * session's chequered flag is not out (#1702), as the translator's
 * `isPlayerFinalLapStarted()` answers it: the fuel contracts' speak gate
 * asks the same reader and refuses a line there, so a fuel button would be
 * accepted and play nothing. Every Fuel button declares it, the countdown run
 * too: it puts the car on a racing lap but shows no green flag, and in a race
 * the translator keeps the last lap marked until one.
 */
export type ShortcutPrecondition =
  | "player-car-index"
  | "sdk-connected"
  | "rolling-start-grid"
  | "rolling-start-oval-grid"
  | "track-length"
  | "traffic-player-car"
  | "session-classified"
  | "race-session"
  | "translator-session-current"
  | "before-final-lap";

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
  /**
   * The translator's latest telemetry (`getLatestTelemetry()`), `null` before
   * its first tick or once disconnected: what `getSessionClass()` reads the
   * session number from. It lags {@link telemetry} by a write until the next
   * tick.
   */
  translatorTelemetry: TelemetryData | null;
  /**
   * The translator's `isPlayerFinalLapStarted()`: true from the player's own
   * last lap or with the chequered flag out, `null` when it cannot tell (no
   * tick, a session it cannot read). Not derivable from the telemetry alone:
   * in a race it is a marker the translator keeps until a green flag says the
   * race went on.
   */
  playerFinalLapStarted: boolean | null;
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

/**
 * The session the mock is in, classified as the Race Engineer classifies it
 * (issue #1702): the translator's own `resolveSessionType` and
 * `classifySession`, which is what `getSessionClass()` answers once the
 * translator has a tick. Both are asked, not restated, so "a race" means here
 * what it means to the fuel countdown's session gate;
 * `fuel-countdown-shortcuts.test.ts` checks the two agree on every session
 * preset.
 */
function classifyMockSession(state: HarnessPreconditionState): SessionClass | null {
  return classifySession(resolveSessionType(state.sessionInfo, state.telemetry));
}

/**
 * Whether the translator's latest tick names the same session as the mock's
 * telemetry (issue #1702), asked of the same `resolveSessionType`: the
 * session type is what `getSessionClass()` classifies, so equal types are an
 * equal answer at speak time.
 */
function translatorSeesMockSession(state: HarnessPreconditionState): boolean {
  if (state.translatorTelemetry === null) return false;

  return (
    resolveSessionType(state.sessionInfo, state.translatorTelemetry) ===
    resolveSessionType(state.sessionInfo, state.telemetry)
  );
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
      "nobody alongside), a rolling-start call asks whether a formation is running, a catch-up call asks whether " +
      "your gap under caution is open, and a fuel line asks which kind of session you are in, which the translator " +
      "reads off its latest tick. The button arranges what it can itself, but a disconnected translator receives no " +
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
  "traffic-player-car": {
    // The translator's own resolver, as for `player-car-index`: asked, not
    // restated, so "your car" means here exactly what it means to the detector.
    satisfied: (state) => resolvePlayerCarIdx(state.sessionInfo) === TRAFFIC_PLAYER_CAR_IDX,
    reason:
      'Apply the "race" or "race-oval" session preset first. This run puts a field of cars on track indexed for that ' +
      `roster, your car at index ${TRAFFIC_PLAYER_CAR_IDX}, and the translator reads which car is yours from the driver ` +
      "list (DriverInfo.DriverCarIdx). On a session naming another car, or none, the detector would read an empty " +
      "slot as yours and the whole run would be silent.",
  },
  "session-classified": {
    satisfied: (state) => classifyMockSession(state) !== null,
    reason:
      'Apply a session preset first ("practice", "testing", "qualifying", "lone-qualifying", "race" or "race-oval"). ' +
      "The fuel countdown is heard per kind of session, through the Speak in toggles (Race, Practice, Qualifying, " +
      'Test; here the "Fuel countdown: speak in …" checkboxes in Global Settings), so the Race Engineer reads which ' +
      "kind of session you are in (SessionInfo.Sessions[SessionNum].SessionType). The harness boots with no " +
      "session info, and in a session it cannot classify no fuel line is spoken at all.",
  },
  "race-session": {
    satisfied: (state) => classifyMockSession(state)?.category === "race",
    reason:
      'Apply the "race" or "race-oval" session preset first. "Enough fuel to finish" is the race countdown’s ' +
      "closing line, retracting the warnings before it, so the Race Engineer speaks it in a race only, and only " +
      'with "Fuel countdown: speak in Race" checked. In any other session it is silent.',
  },
  "before-final-lap": {
    // The fuel speak gate's own test, `!== true`: an unknown answer speaks.
    satisfied: (state) => state.playerFinalLapStarted !== true,
    reason:
      "You are on your final lap, or the session's chequered flag is out, and the Race Engineer speaks no fuel count " +
      "there: the line would be refused as it reached the radio. To get back before the final lap, apply the " +
      '"hot-lap" telemetry preset (racing, no flag shown); in a race also show a green flag for one tick ' +
      "(SessionFlags with the Green bit, 4), since a race keeps its last lap marked until a green says it went on. " +
      "Tick once and press again.",
  },
  "translator-session-current": {
    satisfied: translatorSeesMockSession,
    reason:
      "The translator has not read the session you are in yet. The Race Engineer reads which kind of session it is " +
      "from the translator's latest tick (SessionInfo.Sessions[SessionNum].SessionType), and the session number in " +
      "the telemetry has changed since that tick, because the tick loop is paused or slowed. Tick once (or resume the " +
      "loop) and press again: run now, every fuel line would be judged against the session before.",
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
