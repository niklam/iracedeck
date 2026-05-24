/**
 * Pit-box count-in (issue #600).
 *
 * As the player drives down pit road toward their own pit box, the engineer
 * counts the remaining distance down: "five" (120 m), "four" (100 m), "three"
 * (80 m), "two" (60 m), "one" (40 m), "pit now" (20 m). Each mark is published
 * once per pit-road visit as the remaining distance crosses into its band.
 *
 * Inputs:
 *   - `OnPitRoad` gates the whole feature — the count-in only runs on pit road.
 *   - `boxTrkPct` is the player's pit box as a 0–1 fraction of the lap, resolved
 *     by the translator from `SessionInfo.DriverInfo.DriverPitTrkPct`. Known up
 *     front, so the count-in works on the very first stop of a session.
 *   - `trackLengthMeters` converts the fractional gap to meters (the same cached
 *     value the overtake gate uses).
 *
 * Distance is the forward gap from `LapDistPct` to the box, folded around the
 * lap. The matching mark is the band the remaining distance falls into — the
 * smallest threshold still ≥ the remaining distance. This means:
 *   - a normal approach fires each mark once as the car descends through the
 *     bands;
 *   - entering pit road already within range fires only the marks still ahead
 *     (no burst of skipped numbers);
 *   - beyond the first mark (>120 m) nothing fires, and once the box is passed
 *     the distance folds to ~a full lap so no band matches and the count stops.
 *
 * The spoken-marks set lives on `TranslatorState` and is cleared whenever the
 * car is not on pit road, so a second stop counts down again. No first-tick
 * seeding is needed — the diff fires purely on the live distance, never on a
 * connect-time transition. A car parked in its stall (`PlayerCarInPitStall`)
 * has arrived and needs no count-in, so it is gated out (this also suppresses a
 * spurious "pit now" when connecting while already in the box).
 */
import type { PitBoxMark } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * Distance marks, largest threshold first. Each mark fires when the remaining
 * distance to the box (meters) first falls at or below its threshold and above
 * the next smaller one.
 */
export const PIT_BOX_COUNTDOWN_MARKS: ReadonlyArray<{ mark: PitBoxMark; meters: number }> = [
  { mark: "five", meters: 120 },
  { mark: "four", meters: 100 },
  { mark: "three", meters: 80 },
  { mark: "two", meters: 60 },
  { mark: "one", meters: 40 },
  { mark: "pit-now", meters: 20 },
];

/**
 * Select the mark whose band contains `remainingMeters` — the smallest
 * threshold still ≥ the remaining distance. Returns `null` when the car is
 * further than the largest threshold (or the distance has wrapped past the box
 * to ~a full lap), so nothing fires outside the count-in window.
 *
 * @internal Exported for testing.
 */
export function selectPitBoxMark(remainingMeters: number): PitBoxMark | null {
  let match: PitBoxMark | null = null;

  for (const { mark, meters } of PIT_BOX_COUNTDOWN_MARKS) {
    // Epsilon makes the threshold inclusive against floating-point noise — a
    // remaining distance computed as `pct × length` lands a hair above an exact
    // boundary (e.g. 20.0000000000000018 m for the 20 m mark), which would
    // otherwise drop into the next-larger band.
    if (remainingMeters <= meters + 1e-6) {
      match = mark; // keep tightening toward the smallest matching threshold
    } else {
      break; // thresholds descend; once we're past one, no smaller band matches
    }
  }

  return match;
}

export function diffPitBoxCountdown(
  state: TranslatorState,
  telemetry: TelemetryData,
  boxTrkPct: number | null,
  trackLengthMeters: number | null,
  emit: EmitFn,
): void {
  const onPitRoad = telemetry.OnPitRoad ?? false;

  if (!onPitRoad) {
    // Reset per-visit tracking so the next pit-road entry counts down again.
    if (state.pitBoxMarksSpoken.size > 0) state.pitBoxMarksSpoken.clear();

    return;
  }

  // Parked in the stall — the car has arrived, no count-in. Also suppresses a
  // spurious "pit now" when connecting while already sitting in the box.
  if (telemetry.PlayerCarInPitStall ?? false) return;

  // Can't locate the box or convert the gap to meters — stay silent rather than
  // guess. `boxTrkPct` is null when DriverPitTrkPct is missing/out of range;
  // `trackLengthMeters` is null before the session YAML is parsed.
  if (boxTrkPct === null || boxTrkPct <= 0 || trackLengthMeters === null || trackLengthMeters <= 0) {
    return;
  }

  const lapDistPct = telemetry.LapDistPct;

  if (typeof lapDistPct !== "number" || lapDistPct < 0) return;

  // Forward distance from the current position to the box, folded around the
  // lap so a car just behind the box (and the box just behind S/F) reads the
  // short way round.
  const remainingFraction = (((boxTrkPct - lapDistPct) % 1) + 1) % 1;
  const remainingMeters = remainingFraction * trackLengthMeters;

  const mark = selectPitBoxMark(remainingMeters);

  if (mark === null || state.pitBoxMarksSpoken.has(mark)) return;

  state.pitBoxMarksSpoken.add(mark);
  emit({ event: "pitBox.countdown", data: { mark } });
}
