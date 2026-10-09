/**
 * Test support (#1324): a stand-in for `SDKController`'s debounced replay
 * state, for tests whose controller is a mock. It runs the SDK's own rule
 * (`nextReplayState`, `replayStateAt`, `replayLeftForLive`), so a test that
 * swaps telemetry and advances the clock means what it meant against the
 * #1230 sighting: the post-seek blip, the grace running out, a jump to live.
 *
 * Every `getReplayState` call first steps the state with whatever `telemetry`
 * and `sessionInfo` return at that moment, as if a tick carrying them had just
 * been notified, then reads it at `nowMs`. No telemetry steps nothing. Never
 * imported by production code.
 */
import {
  initialReplayState,
  nextReplayState,
  replayLeftForLive,
  type ReplayState,
  replayStateAt,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";

/** The two controller members the replay surfaces read the state through. */
export interface SteppedReplayState {
  getReplayState(nowMs?: number): ReplayState;
  noteReplayLeftForLive(nowMs?: number): boolean;
}

export function steppedReplayState(
  telemetry: () => TelemetryData | null,
  sessionInfo: () => unknown = () => null,
): SteppedReplayState {
  let state = initialReplayState();

  return {
    getReplayState(nowMs: number = Date.now()): ReplayState {
      const t = telemetry();

      if (t) state = nextReplayState(state, t, sessionInfo(), nowMs);

      return replayStateAt(state, nowMs);
    },
    noteReplayLeftForLive(nowMs: number = Date.now()): boolean {
      const next = replayLeftForLive(state, nowMs);
      const dropped = next !== state;

      state = next;

      return dropped;
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
