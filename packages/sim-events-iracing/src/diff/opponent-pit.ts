/**
 * Opponent pit-entry callouts (issue #622).
 *
 * Detects each car's `CarIdxTrackSurface` transition INTO
 * `TrkLoc.AproachingPits` against a per-car previous-tick baseline and emits
 * `opponentPit.entered` for the cars that matter: the (class) leader, and
 * same-lap cars within ±2 effective positions of the player. Never keys on
 * `CarIdxOnPitRoad` — real telemetry shows it reading true for on-track cars
 * (see the header of `race-finish.ts`).
 *
 * **Effective positions.** Ranks come from the canonical frozen order
 * (`calculateFrozenRacePositions`, threaded in by the translator — the
 * `diffOvertakes` slot) per `race-positions.md`; class ranks derive from the
 * same order via `classPositionFromOrder` (#588's class space).
 *
 * **Aggregation (the oval safety valve).** The incident-burst shape: a rolling
 * list of qualifying-entry timestamps pruned to the last 12 s on every tick.
 * While the aggregate hasn't fired this episode, entries below the threshold
 * announce individually; the entry that reaches the threshold emits one
 * `"others"` aggregate, and every later non-leader entry stays silent until
 * the window has been quiet for 12 s (the `opponentPitAggregateAnnounced`
 * flag, NOT the live window count, gates the silence — pruning old entries
 * below the threshold mid-episode must not resume enumeration). The leader
 * always announces individually and still counts toward the window total;
 * within a tick the leader's emission is ordered first.
 *
 * **Gating in the diff** (the `diffPitsOpen` precedent): race sessions only,
 * replay-only sessions suppressed (#604), pre-green suppressed (#647 — grid
 * shuffles produce meaningless positions), post-race suppressed (the whole
 * field pits after the checkered — announcing that is noise), and an
 * unresolved player carIdx suppresses everything (classification is relative
 * to the player; with `-1` the player's own car could classify as an
 * opponent). Baselines advance every tick so a gated transition is absorbed,
 * never replayed when the gate opens.
 */
import { classPositionFromOrder, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/** Rolling window for counting near-simultaneous qualifying pit entries. */
export const OPPONENT_PIT_AGGREGATE_WINDOW_MS = 12_000;

/** Qualifying entries within the window at which enumeration collapses. */
export const OPPONENT_PIT_AGGREGATE_THRESHOLD = 3;

/**
 * Per-car re-announce cooldown — a car crawling back and forth across the
 * approach-zone boundary can't re-announce the same stop.
 */
export const OPPONENT_PIT_CAR_COOLDOWN_MS = 30_000;

type Classification = {
  relation: "leader" | "ahead" | "behind" | "nearby";
  position: number;
};

function classify(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  carIdx: number,
  isMultiClass: boolean,
): Classification | null {
  const carClasses = telemetry.CarIdxClass;

  // Multi-class: only same-class cars are rivals; positions are class space.
  if (isMultiClass) {
    const playerClass = carClasses?.[playerCarIdx];
    const carClass = carClasses?.[carIdx];

    if (playerClass === undefined || carClass === undefined || playerClass !== carClass) return null;
  }

  const carPos = isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);

  if (carPos <= 0) return null;

  // The (class) leader always qualifies — no same-lap or window check.
  if (carPos === 1) return { relation: "leader", position: 1 };

  const playerPos = isMultiClass
    ? classPositionFromOrder(positions, carClasses, playerCarIdx)
    : (positions[playerCarIdx] ?? 0);

  if (playerPos <= 0) return null;

  // Same lap: lap-progress scores within one full lap. Raw `CarIdxLap`
  // equality misbehaves around S/F crossings; the score form is what the
  // position machinery ranks by.
  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;
  const carLc = lc?.[carIdx] ?? -1;
  const playerLc = lc?.[playerCarIdx] ?? -1;

  if (carLc < 0 || playerLc < 0) return null;

  const scoreGap = Math.abs(carLc + (dp?.[carIdx] ?? 0) - (playerLc + (dp?.[playerCarIdx] ?? 0)));

  if (scoreGap >= 1.0) return null;

  const delta = carPos - playerPos;

  if (delta === -1) return { relation: "ahead", position: carPos };

  if (delta === 1) return { relation: "behind", position: carPos };

  if (delta === -2 || delta === 2) return { relation: "nearby", position: carPos };

  return null;
}

export function diffOpponentPit(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  paceCarIdx: number | null,
  isRaceSession: boolean,
  replayOnlySession: boolean,
  preGreen: boolean,
  postRace: boolean,
  isMultiClass: boolean,
  frozenPositions: number[],
  now: number,
  emit: EmitFn,
): void {
  // Prune the aggregation window every tick; a quiet window ends the episode.
  if (state.opponentPitRecentEntries.length > 0) {
    state.opponentPitRecentEntries = state.opponentPitRecentEntries.filter(
      (t) => now - t <= OPPONENT_PIT_AGGREGATE_WINDOW_MS,
    );

    if (state.opponentPitRecentEntries.length === 0) {
      state.opponentPitAggregateAnnounced = false;
    }
  }

  const ts = telemetry.CarIdxTrackSurface as number[] | undefined;

  if (!ts) return;

  // First tick — seed the per-car baseline without firing.
  if (!state.opponentPitInitialized) {
    state.opponentPitInitialized = true;
    state.opponentPitLastSurface = ts.slice();

    return;
  }

  const prev = state.opponentPitLastSurface;
  const gated = !isRaceSession || replayOnlySession || preGreen || postRace || playerCarIdx < 0;

  if (!gated) {
    const lc = telemetry.CarIdxLapCompleted;
    const dp = telemetry.CarIdxLapDistPct;
    const qualifying: Array<{ carIdx: number; c: Classification }> = [];

    for (let i = 0; i < ts.length; i++) {
      if (i === playerCarIdx || i === paceCarIdx) continue;

      if (ts[i] !== TrkLoc.AproachingPits || prev[i] === TrkLoc.AproachingPits || prev[i] === undefined) continue;

      // In-world test (the race-finish.ts shape) — blipped/vanished cars skip.
      if ((lc?.[i] ?? -1) < 0 || (dp?.[i] ?? -1) < 0) continue;

      if (now < (state.opponentPitCarCooldownUntil[i] ?? 0)) continue;

      const c = classify(telemetry, frozenPositions, playerCarIdx, i, isMultiClass);

      if (c) qualifying.push({ carIdx: i, c });
    }

    // Leader-first within the tick — the leader's individual line must never
    // trail a same-tick aggregate (the docs' promised ordering).
    if (qualifying.length > 1) {
      qualifying.sort((a, b) => Number(b.c.relation === "leader") - Number(a.c.relation === "leader"));
    }

    for (const { carIdx, c } of qualifying) {
      state.opponentPitCarCooldownUntil[carIdx] = now + OPPONENT_PIT_CAR_COOLDOWN_MS;
      state.opponentPitRecentEntries.push(now);

      if (c.relation === "leader") {
        // Leader-first: always individual, even mid-aggregation.
        emit({
          event: "opponentPit.entered",
          data: { relation: "leader", carIdx, position: c.position, isMultiClass },
        });
        continue;
      }

      if (state.opponentPitAggregateAnnounced) continue;

      if (state.opponentPitRecentEntries.length < OPPONENT_PIT_AGGREGATE_THRESHOLD) {
        emit({
          event: "opponentPit.entered",
          data: { relation: c.relation, carIdx, position: c.position, isMultiClass },
        });
      } else {
        // Threshold reached: collapse to the aggregate tail, once per episode.
        state.opponentPitAggregateAnnounced = true;
        emit({ event: "opponentPit.entered", data: { relation: "others" } });
      }
    }
  }

  // Advance the baseline in place every tick — even when gated, so a
  // transition during a non-race / replay / pre-green / post-race window
  // never replays once the gate opens. Element-wise copy, no per-tick
  // allocation (the other diffs' baseline convention).
  for (let i = 0; i < ts.length; i++) prev[i] = ts[i];

  prev.length = ts.length;
}
