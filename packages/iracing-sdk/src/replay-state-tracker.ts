/**
 * The one holder of the debounced replay state (#1324).
 *
 * `SDKController` keeps the production instance; the scenario harness's mock
 * controller and the action tests' stand-in keep one each, so the three run
 * the same rule from the same place rather than three copies of the same four
 * lines. The rule itself stays in the pure functions of `telemetry-features.ts`
 * (`nextReplayState`, `replayStateAt`, `replayLeftForLive`, `replaySeekHeld`);
 * this class only sequences them over a held state.
 */
import {
  initialReplayState,
  nextReplayState,
  replayLeftForLive,
  replaySeekHeld,
  type ReplayState,
  replayStateAt,
} from "./telemetry-features.js";
import type { TelemetryData } from "./types.js";

/**
 * A seek hold as the replay engine tells it (#1429): for `remainingMs` more,
 * and never past the last replay sighting plus `maxPastSightingMs`, the
 * longest any seek on the tape can take. A duration rather than a time, so
 * the engine's clock and the tracker's need not be the same clock.
 */
export interface ReplaySeekHold {
  readonly remainingMs: number;
  readonly maxPastSightingMs: number;
}

export class ReplayStateTracker {
  private state: ReplayState = initialReplayState();

  /**
   * Steps the state with one telemetry read, as `nextReplayState` does. The
   * real controller steps on every fresh, non-null poll — before its
   * `SessionTick` dedupe, so a repeated tick steps too — and never on a
   * re-delivery of an older read, which would re-stamp a stale sighting.
   * `nowMs` is the read's wall time, injectable for tests.
   */
  step(telemetry: TelemetryData, sessionInfo: unknown, nowMs: number = Date.now()): void {
    this.state = nextReplayState(this.state, telemetry, sessionInfo, nowMs);
  }

  /** The state re-evaluated at `nowMs`, so the exit grace expires between steps too. */
  read(nowMs: number = Date.now()): ReplayState {
    return replayStateAt(this.state, nowMs);
  }

  /** Applies `replayLeftForLive`: the plugin's own `goToEnd` was just sent at `nowMs`. */
  noteLeftForLive(nowMs: number = Date.now()): void {
    this.state = replayLeftForLive(this.state, nowMs);
  }

  /**
   * Applies `replaySeekHeld` (#1429): a seek of the replay engine's own holds
   * the replay sighting for `hold.remainingMs` more from `nowMs`, capped at
   * the last sighting plus `hold.maxPastSightingMs`, or, for null or a
   * duration that is not positive, none is under way any more.
   */
  holdForSeek(hold: ReplaySeekHold | null, nowMs: number = Date.now()): void {
    const until =
      hold !== null && hold.remainingMs > 0
        ? { untilMs: nowMs + hold.remainingMs, maxPastSightingMs: hold.maxPastSightingMs }
        : null;

    this.state = replaySeekHeld(this.state, until, nowMs);
  }

  /** Back to live with nothing sighted — what a dropped connection means. */
  reset(): void {
    this.state = initialReplayState();
  }
}
