/**
 * Replay Control dial — Frame Jog (#1317): one frame per detent, for finding
 * the exact frame of a contact. A rotation mode of the dial surface
 * (`replay-control-dial-mode.ts`), which owns the in-replay guard, the press
 * gestures and every push to the screen. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 */
import { ReplayPosMode } from "@iracedeck/iracing-sdk";

import type { ReplayDialMode, ReplayDialModeIo } from "./replay-control-dial-mode.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/** The replay-cursor owner every Frame Jog command is sent under. */
const CURSOR_OWNER = "dial-frame-jog";

/**
 * How a turn of several detents in one event is sent. `true` is the spec's
 * model: one `setPlayPosition(Current, ±n)`, on the reading that `Current` is
 * an offset from the frame on screen and that a negative one steps back.
 * Nothing else in the plugin sends that mode, and a negative offset goes out
 * as two's complement across the broadcast's two 16-bit halves, so #1317's
 * manual test is what confirms it: a fast spin each way, `ReplayFrameNum`
 * before and after against the logged ticks. `false` is the spec's fallback,
 * that many single frame steps.
 */
const MULTI_DETENT_AS_ONE_JUMP = true;

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
 * Moves the replay `ticks` frames (positive is forward) in one `io.send`: a
 * single detent as a frame step, several as one relative jump when
 * `asOneJump`, otherwise as that many steps, stopping at the first one that
 * does not go out. Returns whether everything was sent.
 */
export function sendFrameSteps(io: ReplayDialModeIo, ticks: number, asOneJump: boolean): boolean {
  const count = Math.abs(ticks);

  if (count > 1 && asOneJump) {
    return io.send(CURSOR_OWNER, (replay) => replay.setPlayPosition(ReplayPosMode.Current, ticks));
  }

  return io.send(CURSOR_OWNER, (replay) => {
    for (let step = 0; step < count; step++) {
      if (!(ticks > 0 ? replay.nextFrame() : replay.prevFrame())) return false;
    }

    return true;
  });
}

/**
 * The Frame Jog mode. Clockwise is the next frame, counter-clockwise the
 * previous one, uncapped: iRacing bounds a jump at the ends of the recording.
 * A turn while the replay plays sends two commands, the pause and then the
 * move, so the jog lands on a still frame whatever iRacing does to playback
 * on a frame step; the pause is the surface's tracked one, so Press resumes
 * the speed that was playing.
 */
export const frameJogMode: ReplayDialMode = {
  rotateDescription: "Next / previous frame",

  rotate(ticks, _dial, io) {
    const playing = io.liveSpeed().speed !== 0;

    io.logger.debug(`Frame jog: ticks=${ticks}, playing=${playing}`);

    if (playing && !io.pause(CURSOR_OWNER)) {
      io.logger.warn("Frame jog skipped: the replay could not be paused");

      return;
    }

    sendFrameSteps(io, ticks, MULTI_DETENT_AS_ONE_JUMP);
  },

  view(_dial, io) {
    const live = io.liveSpeed();

    return {
      label: "FRAME",
      value: formatReplayTime(io.telemetry()?.ReplaySessionTime),
      caption: formatSpeedDisplay(live.speed, live.slowMotion),
      sides: { left: true, right: true },
    };
  },
};
