/**
 * Lap-time contracts + vocabulary — the best lap (issue #555; scripted since
 * #1065) and every lap (issue #1163).
 *
 * **Which of them speaks.** On a lap the player completes, at most one of the
 * three lap-time callouts speaks: the fastest lap of the race
 * (`fastest-lap.ts`, #1571), the best lap, then every lap, in that order of
 * precedence. Each contract here adds `owner(lap) === <own>` to its
 * `where:`, where `owner` is the {@link LapOwnerResolver} `registerPitCrew`
 * builds from the three opt-ins and the active voice's script, over
 * `playerLapOwner` in `lap-announcement.ts` — one rule, decided on the
 * payload, never by which line reaches the bus first.
 *
 * **Every lap (`pit-crew.lap-time-last`, #1163).** "Last lap was one
 * forty five point two thirty seven" — in practice, qualifying and race, at
 * `WEIGHT.CHATTER`, queueable, in its own family. It is silent on an out lap
 * or an in lap (a lap that does not describe pace), on the final lap of a
 * race and under a caution exactly as the best lap is; an invalid lap is
 * still spoken. Its `speakGate` drops a lap time that waited out a busy line
 * once the player has completed another lap (`lapStillCurrent`). The readout
 * is the compact form to the thousandth (`lap-time-readout.ts`), each clip
 * that leads into another cut per onset class of the word after it; the
 * bundled script's shape:
 *   {{lapTime.lastIntro}}      "Last lap was" (plus alternates), by the class
 *                              of the time's first word
 *   {{lapTime.compactMinute}}  CONDITIONAL on `lapTime.compactHasMinute`
 *   {{lapTime.compactSecond}}
 *   {{lapTime.compactPoint}}   "point two", by the class of the pair
 *   {{lapTime.compactPair}}    "thirty seven" — ends the line
 *
 * **The best lap (`pit-crew.lap-time-best`, #555).** Fires on `lap.completed` when the driver sets a new session best (`isBest`)
 * or completes their first valid lap of the session (`isFirstValid`). The
 * intro selector picks `"first-good-lap"` for the first-valid case and
 * `"best-lap-yet"` for every subsequent improvement, driven straight off the
 * payload's `isFirstValid` flag.
 *
 * The code below decides WHETHER a lap is worth a readout and how it is
 * scheduled; WHAT is read out lives in the active voice's `callouts.json`
 * under the same id (`scenarios["pit-crew.lap-time-best"]`), paired at
 * `setScripts` time. The bundled script's shape:
 *   [radio open]
 *   {{lapTime.intro}}             best-lap-yet  OR  first-good-lap
 *   {{lapTime.minute}}            CONDITIONAL on `lapTime.hasMinuteComponent`
 *                                 — skipped for sub-1-min laps
 *   {{lapTime.second}}            whole-second component, with trailing comma
 *   {{lapTime.decimal}}           "point N seconds." — terminates the readout
 *   [radio close]
 *
 * The minute clause is the #1064 spec's boundary case: dropping the minute is
 * a real convention in racing (the assumed minute is understood), so whether
 * a voice keeps the hard `if` or writes `{ optional: ["{{lapTime.minute}}"] }`
 * for a terser register is the pack's decision, not this file's. The bundled
 * script keeps the hard `if` — the assumed minute only holds where it is 1,
 * and an 8:32.4 lap read as "thirty-two four" is nonsense.
 *
 * No leading pause: the translator now triggers `lap.completed` on
 * `LapLastLapTime` updating (which iRacing publishes after the S/F crossing
 * has been registered), so the natural lag of the time-refresh + scenario
 * scheduling already provides the post-line breathing room the pause used
 * to give artificially.
 *
 * Snapshot-at-fire-time (session-start pattern, issue #542): the var resolvers
 * read from a closure-bound `getSnapshot` so deferred replays speak the same
 * frozen lap data. The snapshot is the `lap.completed` event payload itself
 * — the plugin caches the latest one and exposes a getter. Lap events are
 * well-separated in time, so the cache-overwrite race between back-to-back
 * fires is not a practical concern. That is why the vocabulary, not the
 * contract, takes the resolver; the contract's builder keeps only the
 * race-finished gate its `where:` reads.
 *
 * Clip scope derives from the manifest (issues #835/#836): each component
 * resolver returns a pool reference — split and resolved through the shared
 * `lap-time-readout.ts` (#1163, #1571), whose full form this is — and a lap time whose minute component has
 * no clip for the active voice aborts the whole readout at expansion — never
 * partial readouts, no hardcoded bounds.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, LAP_TIME_CALLOUTS } from "@iracedeck/callout-settings";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import type { UnderCautionResolver } from "./caution.js";
import { type LapOwnerResolver, lapStillCurrent, playerLapOwner } from "./lap-announcement.js";
import {
  compactHasMinute,
  compactLeadClass,
  compactMinuteRef,
  compactPairRef,
  compactPointRef,
  compactSecondRef,
  fullDecimalRef,
  fullHasMinute,
  fullMinuteRef,
  fullSecondRef,
} from "./lap-time-readout.js";

/**
 * Resolver for the most recent `lap.completed` payload. Returns `null` when no
 * lap has completed yet — the contract then skips the callout entirely via its
 * `where:` short-circuit.
 */
export type LapCompletedSnapshotResolver = () => LapCompletedSnapshot | null;

/** Snapshot the var resolvers read — exactly the `lap.completed` event payload. */
export type LapCompletedSnapshot = SimEventOf<"lap.completed">["data"];

const LAP_TIME_GROUP_INTRO = "lap-time-intro";

/** The every-lap call's intro group (#1163): "Last lap was", plus alternates, one set per onset class (`intro-<c>`). */
const LAP_TIME_LAST_GROUP = "lap-time-last";

/** Whether the lap has a non-zero minute component (≥1 minute), in #555's full form. */
function hasMinuteComponent(snapshot: LapCompletedSnapshot | null): boolean {
  if (!snapshot) return false;

  return fullHasMinute(snapshot.lapTime);
}

/**
 * Register the vocabulary the lap-time script references (issue #1065): the
 * four readout components as vars and the minute gate as a condition. Every
 * resolver reads the `lap.completed` snapshot through `getSnapshot` at
 * expansion time. Names and descriptions are the public API of the format;
 * the descriptions feed the generated reference (#1066).
 */
export function registerLapTimeVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond">,
  getSnapshot: LapCompletedSnapshotResolver,
): void {
  engine.defineVar(
    "lapTime.intro",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      // Drive intro selection straight off the explicit `isFirstValid` flag
      // rather than inferring it from companion fields (e.g. presence of
      // `previousBestLapTime`). Keeps the behavior independent of how the
      // emitter happens to populate the optional fields.
      return poolRef(LAP_TIME_GROUP_INTRO, s.isFirstValid ? "first-good-lap" : "best-lap-yet");
    },
    "The opening line of the lap-time readout: first-good-lap on the driver's first valid lap of the session, best-lap-yet on every later improvement. Draws from the lap-time-intro clip group.",
  );

  engine.defineVar(
    "lapTime.minute",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      return fullMinuteRef(s.lapTime);
    },
    "The whole-minute part of the lap time, as one clip per minute value; nothing for a lap under a minute. Draws from the lap-time-minute clip group — a minute the voice has no clip for aborts the readout.",
  );

  engine.defineVar(
    "lapTime.second",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      return fullSecondRef(s.lapTime);
    },
    "The whole-second part of the lap time (0 to 59), one clip per value with a trailing comma. Draws from the lap-time-second clip group.",
  );

  engine.defineVar(
    "lapTime.decimal",
    () => {
      const s = getSnapshot();

      if (!s) return null;

      return fullDecimalRef(s.lapTime);
    },
    'The tenths of a second (0 to 9), spoken as "point N seconds" — the clip that ends the readout. Draws from the lap-time-decimal clip group.',
  );

  engine.defineCond(
    "lapTime.hasMinuteComponent",
    () => hasMinuteComponent(getSnapshot()),
    "The lap is a minute or longer, so the minute word is spoken before the seconds. A pack may drop the minute with optional for a terse register; the assumed minute only holds where it is 1.",
  );

  // The every-lap call's vocabulary (#1163): its intro and the compact
  // readout to the thousandth. Each reads the fire's own `lap.completed`
  // payload, falling back to the snapshot for a fire with no lap event.
  const lapOf = (ctx: ScenarioContext): LapCompletedSnapshot | null =>
    ctx.event?.event === "lap.completed"
      ? ((ctx.data as LapCompletedSnapshot | null | undefined) ?? null)
      : getSnapshot();

  engine.defineVar(
    "lapTime.lastIntro",
    (ctx) => {
      const lap = lapOf(ctx);
      const lead = lap ? compactLeadClass(lap.lapTime, "thousandths") : null;

      return lead === null ? null : poolRef(LAP_TIME_LAST_GROUP, `intro-${lead}`);
    },
    'The opening of the every-lap readout ("Last lap was"), from the lap-time-last clip group: lap-time-last/intro-<c>, c the onset class of the first word of the time to the thousandth (intro-w for 1:45.237, intro-f for 58.041, intro-z for 0.9). Nothing for a fire with no lap behind it.',
  );

  engine.defineVar(
    "lapTime.compactMinute",
    (ctx) => {
      const lap = lapOf(ctx);

      return lap ? compactMinuteRef(lap.lapTime, "thousandths") : null;
    },
    "The minute of the lap time read the way a timing screen does, to the thousandth, from the lap-time-compact-minute clip group: base <m>-<c>, c the onset class of the seconds word that follows (lap-time-compact-minute/1-f for 1:45.237, 1-oh for 1:05.237, 1-t for 1:23.400). Nothing under a minute; a minute the voice has no clip for aborts the readout.",
  );

  engine.defineVar(
    "lapTime.compactSecond",
    (ctx) => {
      const lap = lapOf(ctx);

      return lap ? compactSecondRef(lap.lapTime, "thousandths") : null;
    },
    'The seconds of the lap time in the compact form, to the thousandth: after a minute, 0 to 9 from the lap-time-compact-second clip group (00 to 09, "oh five") and 10 to 59 from the lap-time-second clip group; under a minute, lap-time-second (0 to 59) throughout.',
  );

  engine.defineVar(
    "lapTime.compactPoint",
    (ctx) => {
      const lap = lapOf(ctx);

      return lap ? compactPointRef(lap.lapTime) : null;
    },
    'The first digit after the point, spoken with the point ("point two"), from the lap-time-compact-point clip group: base <d>-<c>, c the onset class of the pair that follows (lap-time-compact-point/2-th for 1:45.237, 0-oh for .007, 0-n for .019).',
  );

  engine.defineVar(
    "lapTime.compactPair",
    (ctx) => {
      const lap = lapOf(ctx);

      return lap ? compactPairRef(lap.lapTime) : null;
    },
    'The last two digits of the thousandths, which end the readout, from the lap-time-compact-pair clip group: 00 to 99 ("oh seven", "thirty seven"; lap-time-compact-pair/37 for 1:45.237).',
  );

  engine.defineCond(
    "lapTime.compactHasMinute",
    (ctx) => {
      const lap = lapOf(ctx);

      return lap !== null && compactHasMinute(lap.lapTime, "thousandths");
    },
    "The lap, rounded to the thousandth, is a minute or longer, so the compact readout speaks lapTime.compactMinute before the seconds.",
  );

  engine.defineCond(
    "lapTime.wasInvalid",
    (ctx) => lapOf(ctx)?.lapIsValid === false,
    "The sim flagged the lap invalid (a track-limits cut, say). The every-lap call still reads it; a pack may add a word for it.",
  );
}

/**
 * The gates that silence a lap whole, shared by both contracts here and
 * applied to each alike, so a lap one of them owns is never handed to the
 * other by a gate: a full-course caution (#1127), the lap that ends one (R16),
 * and the final lap of a race, where race-end has the floor (#569).
 */
function lapSilencedWhole(
  data: LapCompletedSnapshot,
  getRaceFinishedFired: () => boolean,
  getUnderFullCourseCaution: UnderCautionResolver,
): boolean {
  if (getUnderFullCourseCaution()) return true;

  if (data.wasCaution === true) return true;

  return data.sessionType === "race" && getRaceFinishedFired();
}

/**
 * The owner #555 reads when no resolver is wired (tests that build the
 * contract alone): the best lap on, the other two off — the precedence as it
 * was before #1163 and #1571.
 */
const BEST_LAP_ONLY_OWNER: LapOwnerResolver = (lap) =>
  playerLapOwner(lap, { fastestLap: false, bestLap: true, everyLap: false });

/**
 * Build the lap-time contract. The contract's `where:` reads the event
 * payload plus the race-finished gate, which is why this stays a builder:
 * `getRaceFinishedFired` suppresses the callout on the final lap of a race
 * (issue #569) — race-end is the only thing the engineer should say when the
 * driver crosses S/F under the checkered. Without this gate the best-lap
 * announcement would fire alongside the race result on a PB final lap and the
 * two would queue head-to-tail. Default `() => false` (race never ends)
 * preserves legacy behavior for tests that don't supply a closure.
 *
 * `getUnderFullCourseCaution` silences the callout while a full-course
 * caution is out (issue #1127): a pace lap under caution can register as a
 * new "best" lap time by virtue of being timed at all, and "That was your
 * best lap yet" over a 44-second pace lap is nonsense — the caution sequence
 * (`caution.ts`) owns everything the engineer says while the yellow is out.
 * Read at EVENT time, same as the race-finished gate, and not again at speak
 * time. The fire can still wait: a heavier fire queues behind a lighter line
 * in flight, queueable or not, so a best lap set under green can be read out
 * a few seconds into a caution thrown just after it (found in issue #1171).
 * That is left as it is, because the readout is the frozen time of a lap run
 * under green — late, but true. The position readout reads the LIVE order
 * when it speaks, which is why its gate asks the caution again and this one
 * has no gate. Default `() => false` preserves legacy behavior for tests and
 * the harness that don't supply a closure.
 *
 * `getLapOwner` is the precedence (#1163, #1571): the best lap speaks only on
 * a lap it owns, so a lap that set the fastest lap of the race past its grace
 * is the fastest-lap call's, and with the best-lap call off or unscripted a
 * best lap falls to the every-lap call. Default: the best lap alone.
 *
 * Holds the fixed `id`, the full `when` block, and the channel/bus/base/family
 * defaults (weight is left at the default `WEIGHT.NORMAL`); the readout's
 * components are the vocabulary's ({@link registerLapTimeVocabulary}).
 */
export function buildLapTimeContract(
  getRaceFinishedFired: () => boolean = () => false,
  getUnderFullCourseCaution: UnderCautionResolver = () => false,
  getLapOwner: LapOwnerResolver = BEST_LAP_ONLY_OWNER,
): ScenarioContract {
  return {
    id: "pit-crew.lap-time-best",
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        // Full-course caution — a pace lap is not a lap time (issue #1127).
        if (getUnderFullCourseCaution()) return false;

        const data = ev.data as LapCompletedSnapshot;

        // …and neither is the lap that ENDS one, which completes seconds after
        // the green with the gate above already open (second review, R16).
        if (data.wasCaution === true) return false;

        // Race finished — defer to race-end (issue #569). The diff sets the
        // latch synchronously before publishing `lap.completed`, so by the
        // time this where: runs the latch reads true on the final lap.
        if (data.sessionType === "race" && getRaceFinishedFired()) return false;

        // Fire on the new-PB case (`isBest`) AND the first-valid-lap case
        // (`isFirstValid`) so an emitter that only marks the latter without
        // setting `isBest` still surfaces the announcement. Whether the
        // components are speakable derives from the clips that exist — a
        // missing component clip aborts at expansion (issues #835/#836).
        if (!((data.isBest || data.isFirstValid) && Number.isFinite(data.lapTime) && data.lapTime > 0)) return false;

        // The precedence (#1163, #1571): a lap the fastest-lap call owns is
        // not read out twice.
        return getLapOwner(data) === "best-lap";
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "lap-time",
    description:
      "You cross the line with a new session-best lap, or your first valid lap of the session — except on the final lap of a race (race-end speaks) or under a caution (a pace lap is not a lap time).",
  };
}

/** What the every-lap contract reads besides its event (#1163). */
export type LapTimeLastContractDeps = {
  getRaceFinishedFired: () => boolean;
  getUnderFullCourseCaution: UnderCautionResolver;
  getLapOwner: LapOwnerResolver;
  getLapCompletedSnapshot: LapCompletedSnapshotResolver;
};

/**
 * Build the every-lap contract (#1163): "Last lap was one forty-five point
 * two three seven." on every lap the player completes that no higher
 * lap-time call owns, except an out or in lap, the final lap of a race and a
 * lap under or ending a caution. Its `speakGate` admits the line only while
 * no newer `lap.completed` has fired, read from the plugin's snapshot, so a
 * lap time that waited out a busy line is dropped rather than read a lap
 * late (#1138's cooldown-free re-check). A fire with no lap event behind it
 * (an imperative one) is admitted.
 */
export function buildLapTimeLastContract(deps: LapTimeLastContractDeps): ScenarioContract {
  return {
    id: "pit-crew.lap-time-last",
    when: {
      event: "lap.completed",
      where: (ev) => {
        if (ev.event !== "lap.completed") return false;

        const data = ev.data as LapCompletedSnapshot;

        if (lapSilencedWhole(data, deps.getRaceFinishedFired, deps.getUnderFullCourseCaution)) return false;

        // A lap out of the pits or into them does not describe pace.
        if (data.isOutLap === true || data.isInLap === true) return false;

        if (!(Number.isFinite(data.lapTime) && data.lapTime > 0)) return false;

        return deps.getLapOwner(data) === "every-lap";
      },
    },
    speakGate: {
      description:
        "The driver has not completed another lap since this one, so a lap time that waited out a busy radio is dropped rather than read a lap late.",
      admit: (ctx) => {
        if (ctx.event?.event !== "lap.completed") return true;

        return lapStillCurrent((ctx.data as LapCompletedSnapshot).lap, deps.getLapCompletedSnapshot());
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CHATTER,
    queueable: true,
    family: "lap-time-last",
    description:
      "You complete a lap that no other lap-time callout speaks for, except an out or in lap, the final lap of a race (race-end speaks) or a lap under a caution.",
  };
}

/**
 * Stable identifier for each lap-time callout: `best-lap` (issue #555, the
 * new-PB and first-valid-lap cases alike — the intro selector handles the
 * distinction) and `every-lap` (issue #1163).
 */
export type LapTimeCalloutId = CalloutIdOf<typeof LAP_TIME_CALLOUTS>;

export const SCENARIO_ID_TO_LAP_TIME_ID: Record<string, LapTimeCalloutId> = {
  "pit-crew.lap-time-best": "best-lap",
  "pit-crew.lap-time-last": "every-lap",
};

export const LAP_TIME_SCENARIO_IDS: readonly string[] = ["pit-crew.lap-time-best", "pit-crew.lap-time-last"];

/**
 * The `(group, base)` sources the bundled scripts address directly: none.
 * Every clip of both readouts is a var's — the every-lap intro too, since it
 * is chosen by the onset class of the time it leads into (#1163). The
 * `lapTime.*` vars draw from `lap-time-last`, the four `lap-time-*` groups
 * and the five `lap-time-compact-*` groups by value, and their descriptions
 * name the groups.
 */
export const LAP_TIME_CLIP_SOURCES: readonly { group: string; base: string }[] = [];
