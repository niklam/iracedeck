/**
 * How many probes lead toward the start of the interval before any later
 * frame is tried: the midpoint, the first quarter, eighth, sixteenth and
 * thirty-second. Five rounds of halving, the depth the walk's budget for
 * probes that find the car gone covers in full.
 */
const LEAD_ROUNDS = 5;

/**
 * The frames the lap search probes inside the open interval `(lo, hi)`, in the
 * order it tries them (#1354), each frame once, until every frame between the
 * bounds has been offered.
 *
 * The search bisects on a car's lap, and a probe that finds the car out of the
 * world says nothing about which half the lap is in: a car is gone before it
 * joins, after it retires, and every time it sits in the garage between two
 * runs. So such a probe moves no bound and the search takes the next frame
 * from here instead. As first built (#607) it read "gone" as "too early",
 * which sent the search for any car that left before the end of the recording
 * to the recording's last frame.
 *
 * The order is chosen for what a probe costs, which is a jump whose time grows
 * with its length (about 8 ms per 1000 frames, 42 seconds across a 24-hour
 * recording):
 *
 * 1. **The midpoint, then toward the start** — the first quarter, eighth,
 *    sixteenth and thirty-second. A car that drove the lap being looked for and
 *    is gone now has usually retired, and the green fallback's lap is always
 *    the first, so the car is most likely to be found early. These five probes
 *    together travel one length of the interval.
 * 2. **Then every other frame, one round of halving at a time** (the quarter
 *    points, the eighths and so on), each round walked from whichever of its
 *    ends is nearer the last probe, so the cursor does not cross the interval
 *    between two rounds for nothing.
 *
 * The caller starts a new sequence whenever a bound moves, so a search that
 * always finds the car probes exactly the midpoints a plain bisection would.
 */
export function* halvingProbeFrames(lo: number, hi: number): Generator<number, void, void> {
  const span = hi - lo;
  const offered = new Set<number>();
  let last: number | null = null;

  const take = (frame: number): boolean => {
    if (frame <= lo || frame >= hi || offered.has(frame)) return false;

    offered.add(frame);
    last = frame;

    return true;
  };

  for (let parts = 2, round = 0; round < LEAD_ROUNDS && parts / 2 < span; parts *= 2, round++) {
    const frame = lo + Math.floor(span / parts);

    if (take(frame)) yield frame;
  }

  // The last round has at least one part per frame, so no frame is left out.
  for (let parts = 2; parts / 2 < span; parts *= 2) {
    const round: number[] = [];

    for (let k = 1; k < parts; k += 2) {
      const frame = lo + Math.floor((span * k) / parts);

      if (frame > lo && frame < hi && !offered.has(frame)) round.push(frame);
    }

    if (round.length === 0) continue;

    const from: number = last ?? lo;

    if (Math.abs(from - round[0]) > Math.abs(from - round[round.length - 1])) round.reverse();

    for (const frame of round) {
      if (take(frame)) yield frame;
    }
  }
}
