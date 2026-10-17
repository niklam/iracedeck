/**
 * Replay Control dial — Lap (#801): the viewed car's next / previous lap per
 * detent, by #1426's record step, else by iRacing's own lap search. A rotation
 * mode of the dial surface (`replay-control-dial-mode.ts`); what a turn does is
 * the shared record-step mode (`replay-control-step-mode.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`.
 *
 * The box shows the lap on screen from the record, not from `CarIdxLap`: in a
 * replay watched inside a live session the per-car arrays read the live
 * field, and four snapshots scrubbed back to the camera car racing all read
 * −1 there. Without a recorded lap for the car at the cursor it shows the
 * replay time.
 */
import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { createRecordStepMode, formatReplayClock } from "./replay-control-step-mode.js";
import { RECORD_STEPS, type RecordListing } from "./replay-record-step.js";

/** The replay-cursor owner every Lap turn's jump and search goes out under. */
const CURSOR_OWNER = "dial-lap";

/**
 * @internal Exported for testing
 *
 * The recorded lap of the camera car that is on screen at `frame`, from its
 * lap list already read (`listRecord("lap", source)`): the last recorded lap
 * start whose landing — the frame a lap step jumps to, a second before the
 * line — is at or before it, so a turn that lands on a lap reads that lap at
 * once rather than the one it is a second from finishing. Null when the list
 * could not be read (no store, no car on camera, no car number) or holds no
 * lap by then.
 */
export function recordedLapAt(frame: number, listing: RecordListing): number | null {
  if (!listing.hit || listing.list !== "lap") return null;

  let lap: number | null = null;

  for (const start of listing.entries) {
    if (listing.landing(start.frame) > frame) break;

    lap = start.lap;
  }

  return lap;
}

/** The Lap value: `L12` from the record, else the replay time; null mid-seek. */
function lapValue(_io: ReplayDialStepIo, position: ReplayPosition | null, listing: RecordListing): string | null {
  if (position === null) return null;

  const lap = recordedLapAt(position.frame, listing);

  return lap === null ? formatReplayClock(position.time) : `L${lap}`;
}

/** The Lap mode. Clockwise is the next lap, counter-clockwise the previous one. */
export const lapMode = createRecordStepMode({
  label: "LAP",
  rotateDescription: "Next / previous lap",
  target: "lap",
  owner: CURSOR_OWNER,
  logLabel: "Dial lap",
  steps: { next: RECORD_STEPS["next-lap"], previous: RECORD_STEPS["prev-lap"] },
  value: lapValue,
});
