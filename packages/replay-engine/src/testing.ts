/**
 * Test helpers shared with `iracing-actions`' tests (#1467); never imported by
 * production code. Reached as `@iracedeck/replay-engine/testing`.
 */
export {
  type CursorTestEvent,
  cursorTestEvent,
  type ReplayCursorProbe,
  stageReplayCursorProbe,
} from "./replay-cursor.test-support.js";
export { type SteppedReplayState, steppedReplayState, withSteppedReplayState } from "./replay-state.test-support.js";
