/**
 * Replay Control dial — what the three stepping modes share (#801): Lap and
 * Session, which step through the replay record and fall back to iRacing's
 * search, and Incident, which is the search alone. Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("Lap and Session: one jump per turn", "The display").
 *
 * A Lap or Session turn of `ticks` detents is one walk of `|ticks|` entries
 * through the record and **one** waited jump to the entry it reaches; a turn
 * made while that jump is still under way walks on from where it is headed,
 * because the surface measures the walk from the replay's pending target. A
 * record that runs out part-way jumps as far as it reaches and drops the rest.
 * A record with nothing that way — no store, no car, a gap, the end of what
 * it holds — hands the whole turn to the paced search
 * (`replay-search-queue.ts`), and so does every turn made while that search
 * is working for the same target: the cursor is between searches, with no
 * landing to step from.
 */
import type { ReplayPosition } from "@iracedeck/replay-engine";

import type { DialSideMarks } from "../../shared/dial-box.js";
import type { ReplayDialMode, ReplayDialStepIo } from "./replay-control-dial-mode.js";
import { listRecord, type RecordListing, type RecordStepSpec, stepRecordListing } from "./replay-record-step.js";
import type { ReplaySearchTarget } from "./replay-search-queue.js";

/**
 * @internal Exported for testing
 *
 * Formats `ReplaySessionTime` (seconds) as `m:ss`, the replay time a stepping
 * mode shows: Incident's value and Lap's caption. Minutes are not folded into
 * hours; a missing, non-finite or negative time reads as nothing.
 */
export function formatReplayClock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";

  const whole = Math.floor(seconds);

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * @internal Exported for testing
 *
 * The caption of a stepping mode: what the paced search has left while it
 * works for `target`, `+3` or `-2`, and otherwise what `otherwise` gives, the
 * mode's own caption (null keeps what the box showed, as a null value does).
 * `otherwise` is called only when no count replaces it, so a caption that
 * reads the record (Session's lap of the session) costs nothing while a count
 * shows. A record jump has no count: it is one step however far it goes.
 */
export function stepCaption(
  io: ReplayDialStepIo,
  target: ReplaySearchTarget,
  otherwise: () => string | null,
): string | null {
  const pending = io.pendingSearch(target);

  if (pending !== null && pending !== 0) return pending > 0 ? `+${pending}` : `${pending}`;

  return otherwise();
}

/** Where a turn steps through the record, each way. */
export interface RecordStepPair {
  readonly next: RecordStepSpec;
  readonly previous: RecordStepSpec;
}

/**
 * @internal Exported for testing
 *
 * The side marks of a mode that steps through the record, from its list
 * already read (`listing`): a side is dim only when the record has entries
 * and none lies that way from `frame`. Every other miss — no store, no car on
 * camera, outside the record, a gap — leaves it lit, since iRacing's search
 * may still move. With no position both are lit.
 */
export function recordSides(
  position: ReplayPosition | null,
  listing: RecordListing,
  steps: RecordStepPair,
): DialSideMarks {
  if (position === null) return { left: true, right: true };

  const lit = (step: RecordStepSpec): boolean => {
    const found = stepRecordListing(listing, position.frame, step.direction);

    return found.hit || found.reason !== "nothing that way";
  };

  return { left: lit(steps.previous), right: lit(steps.next) };
}

/** What makes a record-stepping mode one of its own. */
export interface RecordStepModeConfig {
  readonly label: string;
  readonly rotateDescription: string;
  readonly target: Extract<ReplaySearchTarget, "lap" | "session">;
  /** The replay-cursor owner its jumps and searches go out under. */
  readonly owner: string;
  /** What opens its log lines. */
  readonly logLabel: string;
  readonly steps: RecordStepPair;
  /** The value slot, from the mode's list read once for the view; null when this reading cannot say (a tick read mid-seek). */
  value(io: ReplayDialStepIo, position: ReplayPosition | null, listing: RecordListing): string | null;
  /**
   * The caption while the paced search is not counting for this mode, from the
   * same list; null when this reading cannot say, and the box keeps what it
   * showed.
   */
  caption(io: ReplayDialStepIo, position: ReplayPosition | null, listing: RecordListing): string | null;
}

/**
 * @internal Exported for testing
 *
 * A Lap or Session mode: the record step, else the paced search (see the
 * module header). Nothing is sent outside a replay, which the surface
 * guarantees by calling a mode only while one is on screen.
 */
export function createRecordStepMode(config: RecordStepModeConfig): ReplayDialMode<ReplayDialStepIo> {
  const { target, owner, logLabel, steps } = config;

  return {
    label: config.label,
    rotateDescription: config.rotateDescription,

    rotate(ticks, _dial, io) {
      if (io.isSearchRunning(target)) {
        io.logger.info(`${logLabel}: added to the search under way`);
        io.logger.debug(`${logLabel}: ticks=${ticks}; the search is working for ${target}, so the record is not asked`);
        io.queueSearch(owner, target, ticks);

        return;
      }

      const wanted = Math.abs(ticks);
      const step = ticks > 0 ? steps.next : steps.previous;
      const found = io.recordStep(step, wanted);

      if (!found.hit) {
        io.logger.info(`${logLabel}: stepping by iRacing's search`);
        io.logger.debug(
          `${logLabel}: ticks=${ticks}, record MISS (${found.reason}); the whole turn goes to the search`,
        );
        io.queueSearch(owner, target, ticks);

        return;
      }

      io.logger.info(`${logLabel}: jumping by the record`);
      io.logger.debug(
        `${logLabel}: ticks=${ticks}, record HIT (${found.what}); ${found.steps} of ${wanted} steps to frame ${found.frame}` +
          (found.steps < wanted ? "; the record ran out, the rest is dropped" : ""),
      );

      return io.recordJump(owner, found.frame);
    },

    view(_dial, io) {
      const position = io.position();
      // One read of the list for the value and both side marks: every store
      // listing allocates and sorts the whole list, and a view runs every tick.
      const listing = listRecord(steps.next.list, io.recordSource());

      return {
        value: config.value(io, position, listing),
        caption: stepCaption(io, target, () => config.caption(io, position, listing)),
        // The caption line is kept whether or not the caption has anything to
        // say, so the value keeps its size and place when the count comes and goes.
        reserveCaption: true,
        sides: recordSides(position, listing, steps),
      };
    },
  };
}
