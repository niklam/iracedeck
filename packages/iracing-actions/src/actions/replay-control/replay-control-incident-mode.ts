/**
 * Replay Control dial — Incident (#801): the next / previous incident per
 * detent, always by iRacing's own incident search through the paced search
 * (`replay-search-queue.ts`), which sends one search at a time and waits for
 * each to land. A rotation mode of the dial surface
 * (`replay-control-dial-mode.ts`). Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("Incident").
 *
 * The search steps on from a pointer of iRacing's own, not from the cursor,
 * so a detent is one of iRacing's own steps, as the key is today. #1426
 * records incidents; stepping from the record is its follow-up's, for the keys
 * and the dial together.
 *
 * The box shows the replay time, `m:ss`, and no caption but the paced
 * search's count while it works for incidents (the maintainer's second test
 * round, 2026-10-18). With no count the caption is blank rather than absent,
 * so the time keeps its size and place when the count comes and goes.
 */
import type { ReplayDialMode, ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { BLANK_CAPTION, formatReplayClock, stepCaption } from "./replay-control-step-mode.js";

/** The replay-cursor owner every Incident turn's searches go out under. */
const CURSOR_OWNER = "dial-incident";

/** The Incident mode. Clockwise is the next incident, counter-clockwise the previous one. */
export const incidentMode: ReplayDialMode<ReplayDialStepIo> = {
  label: "INCIDENT",
  rotateDescription: "Next / previous incident",

  rotate(ticks, _dial, io) {
    io.logger.info("Dial incident: stepping by iRacing's search");
    io.logger.debug(`Dial incident: ticks=${ticks}`);
    io.queueSearch(CURSOR_OWNER, "incident", ticks);
  },

  view(_dial, io) {
    const position = io.position();

    return {
      // The position's time: a pending target's while a jump is under way, where
      // telemetry reads 0; null on a tick read mid-seek, and the box keeps its value.
      value: position === null ? null : formatReplayClock(position.time),
      caption: stepCaption(io, "incident", BLANK_CAPTION),
      sides: { left: true, right: true },
    };
  },
};
