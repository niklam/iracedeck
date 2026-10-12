/**
 * Replay Control dial — Frame Jog (#1317): one frame per detent, for finding
 * the exact frame of a contact. A rotation mode of the dial surface
 * (`replay-control-dial-mode.ts`), which owns the in-replay guard, the press
 * gestures and every push to the screen. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * What a turn sends follows from how iRacing treats the two commands that can
 * move a replay by frames, measured on 2026-10-12 and recorded in
 * `replay-position-state.ts`: a frame step is immediate but only one counts
 * per sim update, and it wrecks a position jump still under way; an absolute
 * jump may follow another at any pace and the newest wins, but from the second
 * one on the replay takes some 400 ms to show it. So a single detent on a
 * replay at rest is a frame step, and everything else — several detents in one
 * event, or any turn while the last move has not read back — is one absolute
 * jump to the frame the turn is heading for. A jump relative to the current
 * frame is never sent: iRacing resolves one from the start of the recording
 * while an earlier jump is settling, which is what threw the replay to
 * 0:00.00 on a fast turn.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import type { ReplayDialMode } from "./replay-control-dial-mode.js";
import type { ReplayPosition } from "./replay-position-state.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/** The replay-cursor owner every Frame Jog command is sent under. */
const CURSOR_OWNER = "dial-frame-jog";

/**
 * How many frames short of the recording's end a position jump is aimed at
 * most. Measured on 2026-10-12 against a saved replay: a jump to any of the
 * last four frames, or past the end, lands five frames short of it, so its
 * target never reads back; frame steps go on to the last frame but one. Five
 * is that measurement and the rest is slack. It is not relied on: aimed too
 * far on another recording, a jump is one more target that does not read
 * back and is given up, and the frames past the margin are still reached one
 * step at a time.
 */
const JUMP_END_MARGIN_FRAMES = 8;

/**
 * @internal Exported for testing
 *
 * Formats `ReplaySessionTime` (seconds) as `m:ss.ss`. A frame is 1/60 s, so
 * every frame step changes the hundredths. Minutes are not folded into hours;
 * a missing, non-finite or negative time reads as nothing.
 */
export function formatReplayTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";

  // Rounded as one number, so 59.999 carries into the minute instead of reading 0:60.00.
  const hundredths = Math.round(seconds * 100);
  const minutes = Math.floor(hundredths / 6000);
  const wholeSeconds = Math.floor((hundredths % 6000) / 100);

  return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}

/**
 * @internal Exported for testing
 *
 * What one turn sends: one frame step, one absolute jump, or nothing.
 */
export type FrameMove =
  { kind: "step"; direction: 1 | -1 } | { kind: "jump"; frame: number } | { kind: "none"; reason: string };

/**
 * @internal Exported for testing
 *
 * Decides what a turn of `ticks` detents (positive is forward) sends from
 * where the replay stands or is headed. Nothing when that is not known, and
 * nothing when the replay is at rest on the end of the recording the turn
 * points at. A frame step only for a single detent with nothing under way;
 * otherwise an absolute jump, measured from the pending target while one
 * stands — also when that is the frame it already asks for, since a target
 * that has not read back is put right by asking again.
 *
 * The last frames of the recording are the exception, because a jump cannot
 * land there ({@link JUMP_END_MARGIN_FRAMES}) and a step can: a jump is aimed
 * no further than the margin, a turn of several detents past it is one frame
 * step, and while a move into that stretch has not read back nothing is sent,
 * since a step has to wait and a jump would pull the replay back.
 */
export function planFrameMove(ticks: number, position: ReplayPosition | null): FrameMove {
  if (position === null) return { kind: "none", reason: "the replay's position is not known" };

  const { frame, endFrame, seeking } = position;
  const direction = ticks > 0 ? 1 : -1;
  // A step reaches the last frame but one; a jump stops short of the margin.
  const lastStep = endFrame === undefined ? Infinity : endFrame - 1;
  const lastJump = endFrame === undefined ? Infinity : endFrame - JUMP_END_MARGIN_FRAMES;
  const target = ticks > 0 ? Math.min(frame + ticks, Math.max(frame, lastStep)) : Math.max(frame + ticks, 0);

  if (seeking) {
    if (target <= lastJump || frame <= lastJump) return { kind: "jump", frame: Math.min(target, lastJump) };

    return { kind: "none", reason: "a move into the last frames of the recording has not read back" };
  }

  if (target === frame) return { kind: "none", reason: `at the ${ticks > 0 ? "end" : "start"} of the recording` };

  if (Math.abs(ticks) === 1) return { kind: "step", direction };

  if (target <= lastJump) return { kind: "jump", frame: target };

  // Several detents towards frames only a step reaches: as far as a jump goes, then one frame per turn.
  if (ticks > 0 && frame < lastJump) return { kind: "jump", frame: lastJump };

  return { kind: "step", direction };
}

/**
 * @internal Exported for testing
 *
 * The raw reading a turn was decided on, for the debug line: the frame, the
 * replay time in seconds and iRacing's `IsReplayPlaying`, which reads false
 * with frame 0 while a position jump is under way.
 */
export function describeReplayPosition(telemetry: TelemetryData | null): string {
  const frame = telemetry?.ReplayFrameNum ?? "n/a";
  const time = telemetry?.ReplaySessionTime?.toFixed(3) ?? "n/a";
  const replaying = telemetry?.IsReplayPlaying ?? "n/a";

  return `frame=${frame}, time=${time}, replaying=${replaying}`;
}

/** A turn's decision for the debug line: what it sends and the position it was measured from. */
function describeMove(move: FrameMove, position: ReplayPosition | null): string {
  const sends =
    move.kind === "step" ? `step ${move.direction}` : move.kind === "jump" ? `jump to ${move.frame}` : "none";
  const from = position === null ? "n/a" : `${position.frame}${position.seeking ? " (pending)" : ""}`;

  return `move=${sends}, from=${from}`;
}

/**
 * The Frame Jog mode. Clockwise is the next frame, counter-clockwise the
 * previous one, as many frames as the turn has detents, stopping at the ends
 * of the recording. One command per event; a turn while the replay plays
 * sends the pause first, so the jog lands on a still frame whatever iRacing
 * does to playback on a frame step, and the pause is the surface's tracked
 * one, so Press resumes the speed that was playing. Every move goes through
 * the surface's position calls, which keep the target a later turn is
 * measured from and refuse a step into a jump.
 */
export const frameJogMode: ReplayDialMode = {
  label: "FRAME",
  rotateDescription: "Next / previous frame",

  rotate(ticks, _dial, io) {
    const playing = io.liveSpeed().speed !== 0;
    const position = io.position();
    const move = planFrameMove(ticks, position);

    io.logger.debug(
      `Frame jog: ticks=${ticks}, playing=${playing}, ${describeMove(move, position)}, ${describeReplayPosition(io.telemetry())}`,
    );

    if (playing && !io.pause(CURSOR_OWNER)) {
      io.logger.warn("Frame jog skipped: the replay could not be paused");

      return;
    }

    if (move.kind === "none") {
      io.logger.debug(`Frame jog: nothing sent, ${move.reason}`);

      return;
    }

    const sent = move.kind === "step" ? io.step(CURSOR_OWNER, move.direction) : io.jumpTo(CURSOR_OWNER, move.frame);

    if (!sent) io.logger.warn("Frame jog: the move was not sent");
  },

  view(_dial, io) {
    const live = io.liveSpeed();

    return {
      // The position's time, not the raw one: it is the frame a turn is heading for while
      // the move is under way, where telemetry reads 0.
      value: formatReplayTime(io.position()?.time),
      caption: formatSpeedDisplay(live.speed, live.slowMotion),
      sides: { left: true, right: true },
    };
  },
};
