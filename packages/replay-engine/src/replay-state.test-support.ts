/**
 * Test support (#1324): a stand-in for `SDKController`'s debounced replay
 * state, for tests whose controller is a mock. It holds the SDK's own
 * `ReplayStateTracker`, so a test that swaps telemetry and advances the clock
 * means what it meant against the #1230 sighting: the post-seek blip, the
 * grace running out, a jump to live.
 *
 * The real controller steps the tracker on every poll. A mocked controller
 * has no poll, so here every `getReplayState` call first steps the tracker
 * with whatever `telemetry` and `sessionInfo` return at that moment, as if a
 * poll had just read them, then reads it at `nowMs` — stepping on read stands
 * in for stepping per poll. No telemetry steps nothing. Never imported by
 * production code.
 */
import { type ReplayState, ReplayStateTracker, type TelemetryData } from "@iracedeck/iracing-sdk";

/** The two controller members the replay surfaces read the state through. */
export interface SteppedReplayState {
  getReplayState(nowMs?: number): ReplayState;
  noteReplayLeftForLive(nowMs?: number): void;
}

export function steppedReplayState(
  telemetry: () => TelemetryData | null,
  sessionInfo: () => unknown = () => null,
): SteppedReplayState {
  const tracker = new ReplayStateTracker();

  return {
    getReplayState(nowMs: number = Date.now()): ReplayState {
      const t = telemetry();

      if (t) tracker.step(t, sessionInfo(), nowMs);

      return tracker.read(nowMs);
    },
    noteReplayLeftForLive(nowMs: number = Date.now()): void {
      tracker.noteLeftForLive(nowMs);
    },
  };
}

/** What a mocked controller reads telemetry and session info through. */
export interface ReplayStateReads {
  getCurrentTelemetry(): TelemetryData | null;
  getSessionInfo(): unknown;
}

/**
 * `controller` with a {@link steppedReplayState} attached, stepped from the
 * controller's own `getCurrentTelemetry` / `getSessionInfo`. Both are read
 * through the controller at every call, so a test that later replaces either
 * still steps the state with what it set.
 */
export function withSteppedReplayState<C extends ReplayStateReads>(controller: C): C & SteppedReplayState {
  return Object.assign(
    controller,
    steppedReplayState(
      () => controller.getCurrentTelemetry(),
      () => controller.getSessionInfo(),
    ),
  );
}
