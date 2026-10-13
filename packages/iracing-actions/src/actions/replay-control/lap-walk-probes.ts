/**
 * The frames the lap search probes inside the open interval `(lo, hi)`, in the
 * order it tries them (#1354): the midpoint first, then the quarter points,
 * the eighths and so on, each frame once, until every frame between the bounds
 * has been offered.
 *
 * The search bisects on a car's lap, and a probe that finds the car out of the
 * world says nothing about which half the lap is in: a car is gone before it
 * joins, after it retires, and every time it sits in the garage between two
 * runs. So such a probe moves no bound and the search takes the next frame
 * from here instead. As first built (#607) it read "gone" as "too early",
 * which sent the search for any car that left before the end of the recording
 * to the recording's last frame.
 *
 * The caller starts a new sequence whenever a bound moves, so a search that
 * always finds the car probes exactly the midpoints a plain bisection would.
 */
export function* halvingProbeFrames(lo: number, hi: number): Generator<number, void, void> {
  const span = hi - lo;
  const offered = new Set<number>();

  // The last pass has at least one part per frame, so no frame is left out.
  for (let parts = 2; parts / 2 < span; parts *= 2) {
    for (let k = 1; k < parts; k += 2) {
      const frame = lo + Math.floor((span * k) / parts);

      if (frame <= lo || frame >= hi || offered.has(frame)) continue;

      offered.add(frame);
      yield frame;
    }
  }
}
