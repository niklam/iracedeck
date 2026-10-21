/**
 * Replay Control dial — Speed Control (#1316): the replay speed on a ladder
 * the user shapes, from reverse through pause to fast-forward. A rotation mode
 * of the dial surface (`replay-control-dial-mode.ts`), which owns the
 * in-replay guard, the press gestures and every push to the screen. Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 */
import { formatPlayCaption, formatSpeedDisplay, rememberedSpeed } from "@iracedeck/replay-engine";

import type { ReplayDialMode, ReplaySpeed } from "./replay-control-dial-mode.js";
import type { SpeedStops } from "./replay-control-dial-settings.js";
import { buildLadder, canStep, walkLadder } from "./replay-speed-ladder.js";

/** The replay-cursor owner every Speed Control turn is sent under. */
const CURSOR_OWNER = "dial-speed";

/**
 * Built ladders, by the parsed `dial.speedStops` object each was built from.
 * `view` runs on every tick with the same settings object, and a settings
 * change arrives as a new one, so a dial builds its ladder once per settings
 * delivery instead of once per tick.
 */
const ladders = new WeakMap<SpeedStops, readonly ReplaySpeed[]>();

function ladderFor(stops: SpeedStops): readonly ReplaySpeed[] {
  let ladder = ladders.get(stops);

  if (!ladder) {
    ladder = buildLadder(stops);
    ladders.set(stops, ladder);
  }

  return ladder;
}

/**
 * The Speed Control mode. Clockwise is one stop up the signed ladder (toward
 * the fastest forward speed), counter-clockwise one stop down, `|ticks|` stops
 * for a fast spin and one `setPlaySpeed` per event, to the last stop reached.
 * The walk starts from the live speed — a turn out of pause plays at the
 * adjacent stop, never the remembered speed — and stops at the ladder's ends.
 */
export const speedMode: ReplayDialMode = {
  label: "SPEED",
  rotateDescription: "Replay speed",

  rotate(ticks, dial, io) {
    const live = io.liveSpeed();
    const target = walkLadder(ladderFor(dial.speedStops), live, ticks);
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
    const ladder = ladderFor(dial.speedStops);
    // What Play/Pause would resume: one value for every dial, shown while paused.
    const resume = rememberedSpeed();

    return {
      value: formatSpeedDisplay(live.speed, live.slowMotion),
      caption: live.speed === 0 ? formatPlayCaption(resume.speed, resume.slowMotion) : "",
      // The same walk the rotation runs, so a mark cannot promise a turn the dial will not make.
      sides: { left: canStep(ladder, live, -1), right: canStep(ladder, live, 1) },
    };
  },
};
