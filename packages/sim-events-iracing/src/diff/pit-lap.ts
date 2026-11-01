/**
 * The pit-road facts of one lap (issues #465, #1163): whether it started on
 * pit road (an out lap) and whether the car entered pit road during it (an
 * in lap). One definition, two readers: the fuel tracker (`fuel-laps.ts`),
 * which excludes such laps from its consumption averages, and the lap diff
 * (`laps.ts`), which publishes them on `lap.completed` as `isOutLap` /
 * `isInLap` so the every-lap call can stay silent on a lap that does not
 * describe pace. Each reader keeps a latch of its own, anchored at its own
 * lap boundary (the fuel tracker at the paired line crossing it measures by
 * `SessionTime`; the lap diff at the `LapCompleted` move `lap.completed`
 * reports), because the two segment laps differently — the tracker re-anchors
 * partial segments after a tow, a garage visit or a reset and discards them,
 * while every lap the counter completes is one `lap.completed` reports. What
 * is shared is the rule: the fields, how a lap boundary opens them, and how a
 * tick advances them, so the two can never disagree about what an out lap or
 * an in lap is.
 *
 * - **Out lap** — the car was on pit road (`OnPitRoad`) on the tick the lap
 *   opened. Pit road crosses start/finish on most tracks, so a car leaving
 *   its stall opens its lap on pit road; where the exit blends in before the
 *   line the opening tick is already off pit road, and the lap is not an out
 *   lap by this rule.
 * - **In lap** — the car entered pit road during the lap after having been
 *   off it at some point in the same lap. A lap opened on pit road and
 *   driven out is not an in lap for the ticks before the car has left pit
 *   road; one that leaves and comes back is both an out lap and an in lap.
 *
 * The tick that closes a lap counts toward it: a reader observes the tick
 * first, then closes the lap and opens the next with the same tick's
 * `OnPitRoad`, so a crossing on pit road ends an in lap and opens an out lap.
 */

/** The per-lap pit-road latch a reader keeps for the lap in progress. */
export type PitLapLatch = {
  /** The lap in progress opened on pit road. */
  isOutLap: boolean;
  /** The car has been off pit road at some point during the lap in progress. */
  leftPitRoad: boolean;
  /** The car entered pit road during the lap in progress, after having been off it. */
  enteredPits: boolean;
};

/** A latch for a lap opened with the car off pit road: the no-pit-road-yet starting point. */
export function createPitLapLatch(): PitLapLatch {
  return { isOutLap: false, leftPitRoad: true, enteredPits: false };
}

/**
 * Open a lap at a lap boundary: `onPitRoad` is the car's `OnPitRoad` on the
 * tick the lap opens, which decides whether it is an out lap and whether the
 * in-lap rule has to wait for the car to leave pit road first.
 */
export function openPitLap(latch: PitLapLatch, onPitRoad: boolean): void {
  latch.isOutLap = onPitRoad;
  latch.leftPitRoad = !onPitRoad;
  latch.enteredPits = false;
}

/**
 * Advance the latch by one tick of the lap in progress. A reader calls this
 * before it tests for its lap boundary, so the closing tick's own state counts
 * toward the lap it closes.
 */
export function observePitLap(latch: PitLapLatch, onPitRoad: boolean): void {
  if (onPitRoad) {
    if (latch.leftPitRoad) latch.enteredPits = true;
  } else {
    latch.leftPitRoad = true;
  }
}

/** The pit-road facts of a lap once it has closed, as `lap.completed` and the fuel record carry them. */
export type PitLapFacts = {
  /** The lap started on pit road. */
  isOutLap: boolean;
  /** The car entered pit road during the lap, after having been off it. */
  isInLap: boolean;
};

/** Read the closed lap's facts off the latch that accumulated it, before the next lap is opened. */
export function closePitLap(latch: PitLapLatch): PitLapFacts {
  return { isOutLap: latch.isOutLap, isInLap: latch.enteredPits };
}
