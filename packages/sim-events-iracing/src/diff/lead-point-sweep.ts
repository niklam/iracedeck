/**
 * The lead-point sweep (issues #888, #1573): the one place a call timed to a
 * point on the lap decides when that point has been reached, so the corner
 * names (`diff/corner-name.ts`) and the sector starts (`diff/sector-start.ts`)
 * cannot drift apart.
 *
 * A LEAD POINT — the car's `LapDistPct` plus `speed × leadSeconds` converted
 * to a lap fraction ({@link leadPointPct}) — is tracked tick to tick, and a
 * start (a corner marker, a sector start) fires when it falls inside the
 * forward interval the lead point swept this tick ({@link sweepLeadPoint}):
 * true threshold-crossing semantics, so the first tick seeds silently and
 * starts behind the car never burst-fire. Once per start per lap (the spoken
 * set, cleared when the lead point wraps past S/F — but not when it crosses
 * forward again a line it has just backed over, which is the same lap).
 * Reversing never fires; a discontinuous jump (tow, reset to pits, replay
 * scrub) re-anchors silently and clears the set so the fresh run announces
 * again. Several starts swept in one tick speak only the one nearest the lead
 * point (no stale burst — the #480/#838 rule).
 *
 * The lead point can back over the line without the car doing so: its offset
 * scales with speed, so under hard braking it shrinks faster than the car
 * advances (the lead point moves at `v + lead·a`, backward while
 * `v < lead·|a|`). A lead point that crossed the line, made the lap's first
 * calls, slid back over it and crossed it again would otherwise clear the set
 * a second time and repeat those calls.
 *
 * The module knows nothing of sessions, pit road or what a start means: each
 * diff keeps its own gates and its own sweep state, and consumes a crossing
 * on pit road without announcing it.
 */

/**
 * One-tick lead-point jump (lap fraction) treated as a discontinuity — tow,
 * reset-to-pits, replay scrub. Same scale as the #603 position-tracking
 * threshold: well above racing motion (~0.0003/tick at 60 Hz), well below
 * any plausible teleport.
 */
export const CORNER_TELEPORT_THRESHOLD = 0.05;

/**
 * Cap on the speed-scaled lead offset (lap fraction). Keeps an extreme
 * setting on a short track from pushing the lead point most of a lap ahead
 * (which would both announce absurdly early and confuse the wrap detection).
 */
export const CORNER_LEAD_MAX_PCT = 0.2;

/**
 * One diff's sweep state: what {@link sweepLeadPoint} reads and writes. A
 * diff's slice in `state.ts` carries these three fields under these names.
 */
export type LeadPointSweep = {
  /**
   * Previous tick's lead point, folded into [0, 1). `null` until the first
   * valid tick seeds it silently, and after {@link resetLeadPointSweep}.
   */
  leadPrevPct: number | null;
  /**
   * Indices (into the starts the diff sweeps) already consumed this lap.
   * Cleared when the lead point wraps past S/F (restored to
   * {@link spokenBeforeBackingOver} instead when that is set), on a teleport
   * re-anchor and by {@link resetLeadPointSweep}.
   */
  spoken: Set<number>;
  /**
   * {@link spoken} as it stood when the lead point backed over the
   * start/finish line — a backward move within
   * {@link CORNER_TELEPORT_THRESHOLD} from just past the line to just before
   * it, as the speed-scaled lead does under hard braking — or `null` when it
   * has not. While set, the lead point is still in the lap it backed out of,
   * so the next forward wrap restores this set rather than clearing: the lap's
   * first calls are not made twice, and only what the sweep consumed behind
   * the line in between is dropped, so those starts still announce at the end
   * of the lap. Cleared by that wrap, a teleport re-anchor, a backward jump
   * over {@link CORNER_TELEPORT_THRESHOLD} (a discontinuity, after which the
   * next wrap is a new lap as before) and {@link resetLeadPointSweep}.
   */
  spokenBeforeBackingOver: Set<number> | null;
};

/**
 * The lead point: `lapDistPct` plus the distance covered in `leadSeconds` at
 * `speed`, as a lap fraction capped at {@link CORNER_LEAD_MAX_PCT}, folded
 * into [0, 1). A speed that is not a positive number gives no lead.
 *
 * @param lapDistPct the car's lap fraction, in [0, 1)
 * @param speed the car's speed in m/s (`Speed`)
 * @param leadSeconds how far ahead, in seconds at the current speed
 * @param trackLengthMeters the track's length, positive
 */
export function leadPointPct(
  lapDistPct: number,
  speed: number | undefined,
  leadSeconds: number,
  trackLengthMeters: number,
): number {
  const metersPerSecond = typeof speed === "number" && speed > 0 ? speed : 0;
  const leadPct = Math.min(CORNER_LEAD_MAX_PCT, (metersPerSecond * leadSeconds) / trackLengthMeters);

  return (lapDistPct + leadPct) % 1;
}

/**
 * Start a fresh pass: the next {@link sweepLeadPoint} seeds silently, and
 * nothing is spoken yet. What a diff does when one of its gates fails, so a
 * return to the track announces again.
 */
export function resetLeadPointSweep(sweep: LeadPointSweep): void {
  sweep.leadPrevPct = null;

  if (sweep.spoken.size > 0) sweep.spoken.clear();

  sweep.spokenBeforeBackingOver = null;
}

/**
 * Advance the sweep to this tick's lead point and say which start, if any, it
 * crossed.
 *
 * Every start inside the forward interval `(previous lead point, leadPoint]`
 * not already spoken this lap is consumed (added to `spoken`); only the one
 * nearest the lead point is returned. A first tick (no previous point) seeds
 * silently; reversing returns nothing, and a reverse within
 * {@link CORNER_TELEPORT_THRESHOLD} that backs over the line keeps `spoken` as
 * `spokenBeforeBackingOver`; a forward jump over the threshold re-anchors,
 * clears `spoken` and returns nothing; a wrap past S/F clears `spoken` before
 * the interval is read, or restores it to `spokenBeforeBackingOver` when the
 * lead point had backed over the line.
 *
 * @param sweep the diff's sweep state, written in place
 * @param leadPoint this tick's lead point ({@link leadPointPct})
 * @param starts the lap fractions to sweep, in [0, 1)
 * @returns the index into `starts` to announce, or `-1`
 */
export function sweepLeadPoint(sweep: LeadPointSweep, leadPoint: number, starts: readonly number[]): number {
  const prev = sweep.leadPrevPct;

  sweep.leadPrevPct = leadPoint;

  // First valid tick of a pass: seed silently. Starts "behind" the lead point
  // simply aren't in any future forward interval this lap, so there is no
  // burst and no explicit seeding pass needed.
  if (prev === null) return -1;

  // Signed forward delta folded into (-0.5, 0.5]: negative = reversing.
  const delta = ((leadPoint - prev + 1.5) % 1) - 0.5;

  if (delta <= 0) {
    if (delta < -CORNER_TELEPORT_THRESHOLD) {
      // A backward discontinuity: whatever line the lead point had backed
      // over, the next wrap is a new lap again, as it always was.
      sweep.spokenBeforeBackingOver = null;
    } else if (leadPoint > prev && sweep.spokenBeforeBackingOver === null) {
      // Backed over the line (hard braking shrinks the lead faster than the
      // car advances): still this lap, so keep what it has spoken for the
      // forward re-cross.
      sweep.spokenBeforeBackingOver = new Set(sweep.spoken);
    }

    return -1;
  }

  if (delta > CORNER_TELEPORT_THRESHOLD) {
    // Tow / reset / scrub — re-anchor, clear the lap's spoken set, stay
    // silent. The next genuine crossings announce as a fresh pass.
    sweep.spoken.clear();
    sweep.spokenBeforeBackingOver = null;

    return -1;
  }

  // The lead point wrapped past S/F inside this tick's interval — a new lap,
  // unless it is crossing forward again a line it backed over: then the same
  // lap goes on with what it had spoken before backing over (what the sweep
  // consumed behind the line in between is dropped, so it announces again at
  // the end of the lap).
  if (leadPoint < prev) {
    const lapSpoken = sweep.spokenBeforeBackingOver;

    sweep.spoken.clear();

    if (lapSpoken !== null) {
      for (const i of lapSpoken) sweep.spoken.add(i);

      sweep.spokenBeforeBackingOver = null;
    }
  }

  // Collect starts inside the forward interval (prev, leadPoint]. All of them
  // are consumed (marked spoken); only the one nearest the lead point is
  // returned, so a wide tick never bursts stale calls.
  let bestIdx = -1;
  let bestForward = -1;

  for (let i = 0; i < starts.length; i++) {
    const forward = (starts[i]! - prev + 1) % 1;

    if (forward <= 0 || forward > delta) continue;

    if (sweep.spoken.has(i)) continue;

    sweep.spoken.add(i);

    if (forward > bestForward) {
      bestForward = forward;
      bestIdx = i;
    }
  }

  return bestIdx;
}
