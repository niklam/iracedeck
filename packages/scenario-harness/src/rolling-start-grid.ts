/**
 * The rolling-start grid the "Rolling Start" shortcuts form the field up in
 * (issue #1167), in its own module because two things read it: the shortcuts
 * that patch it into the mock SDK (`scenario-shortcuts.ts`), and the
 * precondition that asks the translator's lineup reader what it would make of
 * it in the session the tester has applied (`shortcut-preconditions.ts`).
 *
 * Indexed against the `race` / `race-oval` session presets' roster, as the
 * caution shortcuts' pace arrays are: the pace car at index 0, the player at
 * index 7 (car "42"), eighteen slots in all.
 *
 * **The shape is the measured one, the cars are not.** The 2026-09-17 oval
 * capture (`local/telemetry-watch-20260917-191825-092.jsonl`, committed as
 * `sim-events-iracing`'s `rolling-start-formation-20260917.json`) held one
 * lineup from the first `GetInCar` record until 2.7 s after the green: the
 * pace car at −1/−1 — it leads from the road and holds no row — and the field
 * on lines 0 and 1, rows counted from 0 on each, the pole at line 0 row 0.
 * That capture ran 20 cars against a roster this harness does not share, so
 * the same shape is laid over the preset's seventeen: odd indices down line 0,
 * even ones down line 1, in index order. Line 0 therefore holds nine cars
 * (rows 0–8) and line 1 eight (rows 0–7), which the reader counts rather than
 * computes, so the uneven tail costs nothing.
 *
 * The player (index 7) sits at line 0 row 3: seventh on the grid, on the
 * inside, behind car "8" (index 5, line 0 row 2), with car "19" (index 3,
 * line 0 row 1) one row further up and car "99" (index 1) on pole.
 */
import { PaceMode, SessionState, TrkLoc } from "@iracedeck/iracing-sdk";

/** The preset roster's pace car — `DriverInfo.PaceCarIdx` in `race` and `race-oval`. */
export const FORMATION_PACE_CAR_IDX = 0;

/** The car the player forms up behind: car "8", one row up on line 0. */
export const FORMATION_FOLLOW_CAR_IDX = 5;

/** The next car up line 0, car "19": who the player follows once car "8" has gone. */
export const FORMATION_NEXT_FOLLOW_CAR_IDX = 3;

/** The pole, car "99": line 0 row 0, the slot the grid frame hangs on. */
export const FORMATION_POLE_CAR_IDX = 1;

export const FORMATION_PACE_LINE = [-1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
export const FORMATION_PACE_ROW = [-1, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8];

/**
 * Where the pace car waits before it pulls away: just short of start/finish,
 * so its first crossing is the grid RELEASE — the crossing `diff/pace-laps.ts`
 * must not mistake for the end of a pace lap (it sits at ~0 laps accrued).
 */
export const FORMATION_PACE_CAR_STAGED_PCT = 0.99;

/**
 * Per-car lap progress for the gridded field. Present because the pace-lap
 * diff tracks the pace car's own `CarIdxLapDistPct` (issue #773), and once
 * that array exists the shared in-world predicate (`carInWorld`) reads it for
 * every car: a slot left out would read as a car that is not in the world,
 * and the lineup walk would step over it. So every car gets a valid one — the
 * field parked two by two back from the line, a row every half a percent of a
 * lap. They do not move during the run: nothing the formation calls read
 * depends on where the field is, only on the pace car's progress and on who
 * is in the world.
 */
export const FORMATION_LAP_DIST_PCT = FORMATION_PACE_ROW.map((row, carIdx) =>
  carIdx === FORMATION_PACE_CAR_IDX ? FORMATION_PACE_CAR_STAGED_PCT : Number((0.98 - row * 0.005).toFixed(3)),
);

/**
 * Per-car track surface: the pace car waiting on the pit-approach surface, as
 * captured (it read `AproachingPits` until it pulled onto the road 5.7 s into
 * `ParadeLaps`), and the field on the track. The capture had the field
 * gridded on the pit-approach surface too and rolling onto the track car by
 * car; that is left out, since the lineup reader asks only whether a car is
 * in the world and a surface change on seventeen cars is seventeen edges for
 * the opponent diffs to read.
 */
export const FORMATION_TRACK_SURFACE = FORMATION_PACE_ROW.map((_row, carIdx) =>
  carIdx === FORMATION_PACE_CAR_IDX ? TrkLoc.AproachingPits : TrkLoc.OnTrack,
);

/**
 * The grid itself, as a telemetry patch: everything the translator's lineup
 * reader looks at bar the session phase, which each shortcut sets for the
 * moment it starts from. `CarIdxLapCompleted` is DELETED (`null`): with it
 * gone the canonical race order ranks nobody, so no position, gap or overtake
 * event can come out of a field the run never moves.
 */
export const FORMATION_GRID_PATCH = {
  PaceMode: PaceMode.DoubleFileStart,
  CarIdxPaceLine: FORMATION_PACE_LINE,
  CarIdxPaceRow: FORMATION_PACE_ROW,
  CarIdxLapDistPct: FORMATION_LAP_DIST_PCT,
  CarIdxTrackSurface: FORMATION_TRACK_SURFACE,
  CarIdxLapCompleted: null,
} as const;

/**
 * The session phase a formation is read in: `ParadeLaps`, the state the
 * translator holds a formation through and one of the pre-green states the
 * lineup reader takes for a grid.
 */
export const FORMATION_SESSION_STATE = SessionState.ParadeLaps;
