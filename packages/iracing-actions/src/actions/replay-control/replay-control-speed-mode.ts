/**
 * Replay Control dial — Speed Control (#1316): the replay speed on a ladder
 * the user shapes, from reverse through pause to fast-forward. A rotation mode
 * of the dial surface (`replay-control-dial-mode.ts`), which owns the
 * in-replay guard, the press gestures and every push to the screen. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 */
import type { ReplayDialMode } from "./replay-control-dial-mode.js";
import { formatPlayCaption, formatSpeedDisplay } from "./replay-speed-format.js";
import { buildLadder, canStep, walkLadder } from "./replay-speed-ladder.js";
import { rememberedSpeed } from "./replay-speed-state.js";

/** The replay-cursor owner every Speed Control turn is sent under. */
const CURSOR_OWNER = "dial-speed";

/** The dash box's label in this mode. */
export const SPEED_MODE_LABEL = "SPEED";

/**
 * The Speed Control mode. Clockwise is one stop up the signed ladder (toward
 * the fastest forward speed), counter-clockwise one stop down, `|ticks|` stops
 * for a fast spin and one `setPlaySpeed` per event, to the last stop reached.
 * The walk starts from the live speed — a turn out of pause plays at the
 * adjacent stop, never the remembered speed — and stops at the ladder's ends.
 */
export const speedMode: ReplayDialMode = {
  rotateDescription: "Replay speed",

  rotate(ticks, dial, io) {
    const live = io.liveSpeed();
    const target = walkLadder(buildLadder(dial.speedStops), live, ticks);
    const from = formatSpeedDisplay(live.speed, live.slowMotion);

    if (target === null) {
      io.logger.debug(`Dial speed: no stop that way from ${from} (ticks=${ticks}); nothing sent`);

      return;
    }

    const success = io.setSpeed(CURSOR_OWNER, target);
    io.logger.info("Dial replay speed set");
    io.logger.debug(
      `Result: ${success}, ticks=${ticks}, from=${from}, to=${formatSpeedDisplay(target.speed, target.slowMotion)}`,
    );
  },

  view(dial, io) {
    const live = io.liveSpeed();
    const ladder = buildLadder(dial.speedStops);
    // What Play/Pause would resume: one value for every dial, shown while paused.
    const resume = rememberedSpeed();

    return {
      label: SPEED_MODE_LABEL,
      value: formatSpeedDisplay(live.speed, live.slowMotion),
      caption: live.speed === 0 ? formatPlayCaption(resume.speed, resume.slowMotion) : "",
      // The same walk the rotation runs, so a mark cannot promise a turn the dial will not make.
      sides: { left: canStep(ladder, live, -1), right: canStep(ladder, live, 1) },
    };
  },
};
