/**
 * Replay Control dial — whether the per-car telemetry arrays are the replay's
 * own (#801). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("The display").
 *
 * In a saved replay the per-car arrays (`CarIdxLapDistPct`,
 * `CarIdxLapCompleted`, …) are the replay's wherever the cursor is: snapshots
 * of saved replays show them varying per car and over frames. In a replay
 * watched inside a live session they read the live field, so they describe
 * the frame on screen only at the live edge; scrubbed back further they are
 * the live cars' (#1281's capture; scrubbed back to the camera car racing,
 * its `CarIdxLapCompleted` reads −1). Track Order's neighbours and the lap on screen's fallback
 * when the record has none both read the arrays only where this says so.
 */
import { REPLAY_LIVE_EDGE_MAX_FRAMES, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ReplayDialStepIo } from "./replay-control-dial-mode.js";

/**
 * @internal Exported for testing
 *
 * Whether the per-car telemetry arrays are the replay's own: in a saved
 * replay always; in an in-session replay only at the live edge, the cursor
 * within the SDK's `REPLAY_LIVE_EDGE_MAX_FRAMES` of the end of the tape
 * (`ReplayFrameNumEnd`). Scrubbed back further, they read the live field.
 * Says nothing of a tick read mid-seek, which the caller rules out first.
 */
export function carArraysTrusted(
  io: Pick<ReplayDialStepIo, "isSavedReplay">,
  telemetry: TelemetryData | null,
): boolean {
  if (io.isSavedReplay()) return true;

  const toEnd = telemetry?.ReplayFrameNumEnd;

  return typeof toEnd === "number" && toEnd >= 0 && toEnd <= REPLAY_LIVE_EDGE_MAX_FRAMES;
}
