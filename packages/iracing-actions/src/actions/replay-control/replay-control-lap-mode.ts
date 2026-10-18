/**
 * Replay Control dial — Lap (#801): the viewed car's next / previous lap per
 * detent, by #1426's record step, else by iRacing's own lap search. A rotation
 * mode of the dial surface (`replay-control-dial-mode.ts`); what a turn does is
 * the shared record-step mode (`replay-control-step-mode.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`.
 *
 * The box shows the viewed car's lap over the laps in the session, `12/25`
 * (`replay-dial-lap-readout.ts`, the lap from the record), with the replay
 * time, `m:ss`, beneath it, which the paced search's count takes while it
 * works for laps (the maintainer's second test round, 2026-10-18).
 */
import { BLANK_CAPTION, createRecordStepMode, formatReplayClock } from "./replay-control-step-mode.js";
import { lapOfLapsReadout } from "./replay-dial-lap-readout.js";
import { RECORD_STEPS } from "./replay-record-step.js";

/** The replay-cursor owner every Lap turn's jump and search goes out under. */
const CURSOR_OWNER = "dial-lap";

/** The Lap mode. Clockwise is the next lap, counter-clockwise the previous one. */
export const lapMode = createRecordStepMode({
  label: "LAP",
  rotateDescription: "Next / previous lap",
  target: "lap",
  owner: CURSOR_OWNER,
  logLabel: "Dial lap",
  steps: { next: RECORD_STEPS["next-lap"], previous: RECORD_STEPS["prev-lap"] },
  value: (io, position, listing) => lapOfLapsReadout(io, position, listing),
  // The position's time: a pending target's while a jump is under way, where
  // telemetry reads 0; null on a tick read mid-seek, and the box keeps it. No
  // time to show is a blank caption, so the value does not move.
  caption: (_io, position) => (position === null ? null : formatReplayClock(position.time) || BLANK_CAPTION),
});
