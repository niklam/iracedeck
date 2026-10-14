/**
 * Replay Control dial — Frame Jog (#1317): one frame per detent, for finding
 * the exact frame of a contact. A rotation mode of the dial surface
 * (`replay-control-dial-mode.ts`), which owns the in-replay guard, the press
 * gestures and every push to the screen. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * What a turn sends is the shared frame-move rule (`shared/replay-frame-move.ts`,
 * moved there in #1430 so a Frame Forward key and its repeat follow it too):
 * a single detent on a replay at rest is a frame step, and everything else —
 * several detents in one event, or any turn while the last move of any surface
 * has not read back — is one absolute jump to the frame the turn is heading
 * for. A turn made while a marker or fastest-lap jump is still landing
 * therefore steps from the frame that jump is going to and leaves the replay
 * paused there.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import { type FrameMove, planFrameMove } from "../../shared/replay-frame-move.js";
import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayDialMode } from "./replay-control-dial-mode.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/** The replay-cursor owner every Frame Jog command is sent under. */
const CURSOR_OWNER = "dial-frame-jog";

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
