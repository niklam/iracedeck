/**
 * Pit-service status contracts (issue #479) and their positioning-error
 * repeat nags (issue #951); scripted since #1065.
 *
 * Eight contracts — one per non-`None` `PlayerCarPitSvStatus` target —
 * fire on `pitService.statusChanged` filtered by `data.to`. The translator
 * already suppresses `* → None` so the silent idle state never reaches
 * the bus.
 *
 * The code below decides WHEN a status line fires and how it is scheduled;
 * WHAT is said lives in the active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.pit-status-in-progress"]`, …), where the bundled
 * script addresses each line directly as `pool:pit-status/<id>`. The only
 * vocabulary this family registers is the five `pitStatus.still*` conditions
 * the repeat nags hang on ({@link registerPitStatusVocabulary}); the eight
 * transition lines branch on nothing.
 *
 * **Family preemption.** All eight share `family: "pit-status"` so a rapid
 * positioning correction (`TooFarLeft → TooFarRight`) supersedes the
 * in-flight callout cleanly — same mechanism the flag callouts use.
 *
 * **Cross-family weight.** Default weight (`WEIGHT.NORMAL`) means a meatball
 * flag (`WEIGHT.CRITICAL`) still wins the bus over these, and a positioning
 * callout cleanly outweighs an in-flight lower-weight pit-readback (#476).
 *
 * ## Repeat nags (issue #951)
 *
 * iRacing reports a positioning error once and then leaves the status
 * latched, so a driver who overshoots, backs up, and stops still short of the
 * box would otherwise sit unserved in silence. The translator therefore
 * re-emits `pitService.positioningRepeat { status }` every ~2 s while the
 * error persists and the car is at rest, and the five repeat contracts below
 * turn each one into a terse correction line.
 *
 * Three deliberate differences from the transition calls:
 *
 * - **Own family.** Same-family preemption ignores weight, so sharing
 *   `family: "pit-status"` would let the first nag chop the initial call
 *   mid-sentence. `family: "pit-status-repeat"` keeps the two apart and lets
 *   the weight ordering below arbitrate instead. Nags still replace each
 *   OTHER, which is exactly right — a newer nag is the same information,
 *   fresher.
 * - **Strictly lower weight** ({@link PIT_STATUS_REPEAT_WEIGHT}). A nag that
 *   arrives while any `WEIGHT.NORMAL`-or-above line is playing is dropped and
 *   simply retries on the next cadence tick, while a FRESH positioning error
 *   outranks a playing nag and speaks in full the moment it finishes.
 * - **Terse delivery.** No radio beep frame — the pit-box count-in
 *   precedent: at a 2 s cadence the beeps would drown the words. Since issue
 *   #1064 the engine applies the frame itself, so it is the nag's
 *   `frame: NO_FRAME` (`"none"`) that enforces this now.
 *
 * The bundled script wraps each nag's whole body in its `pitStatus.still*`
 * condition (`{ "if": "pitStatus.stillTooFarLeft", "then": [...] }`): the
 * body IS the whole callout, so an expansion to nothing is the intended
 * silence — the frame is not played around an empty body, and a pack keeps
 * that speak-time gate by keeping the `if`.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus, type TelemetryData } from "@iracedeck/iracing-sdk";
import { getLatestTelemetry } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { NO_FRAME } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/**
 * Explicit integer between `WEIGHT.CHATTER` (10) and `WEIGHT.NORMAL` (50) —
 * the #655 / #758 precedent for a callout that slots between named bands.
 *
 * Strictly BELOW the transition calls is the load-bearing part: at equal
 * weight a fresh positioning error arriving mid-nag would be dropped, and the
 * driver would never learn they over-corrected into a different error. Above
 * the CHATTER band so the pit-service readback can't bury a nag.
 */
export const PIT_STATUS_REPEAT_WEIGHT = 40;

/**
 * The statuses that describe an uncorrected parking error — the ones the
 * translator repeats. Single-sourced here so the transition contracts, their
 * repeat siblings and the `pitStatus.still*` conditions can never disagree
 * about which subjects those are. `cond` is the condition name the repeat
 * script wraps its body in; `still` is the phrase its description uses.
 *
 * @internal Exported for testing — the test enumerates the conditions from it.
 */
export const POSITIONING_SUBJECTS: readonly {
  readonly id: string;
  readonly target: PitSvStatus;
  readonly cond: string;
  readonly still: string;
}[] = [
  { id: "too-far-left", target: PitSvStatus.TooFarLeft, cond: "pitStatus.stillTooFarLeft", still: "too far left" },
  { id: "too-far-right", target: PitSvStatus.TooFarRight, cond: "pitStatus.stillTooFarRight", still: "too far right" },
  {
    id: "too-far-forward",
    target: PitSvStatus.TooFarForward,
    cond: "pitStatus.stillTooFarForward",
    still: "too far forward",
  },
  { id: "too-far-back", target: PitSvStatus.TooFarBack, cond: "pitStatus.stillTooFarBack", still: "too far back" },
  { id: "bad-angle", target: PitSvStatus.BadAngle, cond: "pitStatus.stillBadAngle", still: "at a bad angle" },
];

function pitStatusContract(id: string, target: PitSvStatus): ScenarioContract {
  return {
    id: `pit-crew.pit-status-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "pit-status",
    when: {
      event: "pitService.statusChanged",
      where: (e) => (e as SimEventOf<"pitService.statusChanged">).data.to === target,
    },
  };
}

/**
 * Speak-time validity check for a nag (the #669 furled precedent).
 *
 * `queueable: false` does NOT guarantee a nag is dropped when it can't play:
 * the engine sets it as the bus's PENDING fire whenever it outranks the
 * in-flight line without interrupting (`weight > runningWeight &&
 * interrupt !== true`), and a pending fire replays WITHOUT re-running
 * `where:`. A nag queued behind the long, CHATTER-weight pit-service readback
 * could therefore speak seconds later, after the driver had already corrected
 * — telling them to back up when they are sitting perfectly in the box.
 *
 * Script `if` conditions expand at speak time, deferred replays included, so
 * wrapping the whole sequence in one re-checks the LIVE status just before the
 * clip plays. Unknown telemetry means play: a callout is never suppressed by
 * absent data (#574), which also keeps the scenario harness able to audition
 * every nag without iRacing running.
 */
function stillMisalignedAs(target: PitSvStatus): boolean {
  const telemetry = getLatestTelemetry() as TelemetryData | null;

  if (telemetry === null) return true;

  const status = telemetry.PlayerCarPitSvStatus;

  return status === undefined || status === target;
}

function pitStatusRepeatContract(id: string, target: PitSvStatus): ScenarioContract {
  return {
    id: `pit-crew.pit-status-${id}-repeat`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: PIT_STATUS_REPEAT_WEIGHT,
    family: "pit-status-repeat",
    frame: NO_FRAME,
    when: {
      event: "pitService.positioningRepeat",
      where: (e) => (e as SimEventOf<"pitService.positioningRepeat">).data.status === target,
    },
  };
}

/**
 * Register the vocabulary the pit-status scripts reference (issue #1065):
 * one `pitStatus.still<Error>` condition per positioning error, each the
 * speak-time gate its repeat nag wraps its whole body in. Five conditions
 * rather than one case, because each nag asks a different question — "is the
 * car still in MY error" — and a pack keeps or drops each gate on its own.
 * Descriptions feed the generated reference (#1066).
 */
export function registerPitStatusVocabulary(engine: Pick<IScenarioEngine, "defineCond">): void {
  for (const { target, cond, still } of POSITIONING_SUBJECTS) {
    engine.defineCond(
      cond,
      () => stillMisalignedAs(target),
      `The car is still ${still} in the pit box according to live telemetry, or telemetry is unavailable. Wrap a repeat nag's whole body in it so a nag that waited behind a longer line stays silent once the driver has corrected; unknown telemetry counts as still wrong, never as fixed.`,
    );
  }
}

export const PIT_STATUS_CONTRACTS: readonly ScenarioContract[] = [
  pitStatusContract("in-progress", PitSvStatus.InProgress),
  pitStatusContract("complete", PitSvStatus.Complete),
  ...POSITIONING_SUBJECTS.map(({ id, target }) => pitStatusContract(id, target)),
  pitStatusContract("cant-fix-that", PitSvStatus.CantFixThat),
];

/** The terse "still uncorrected" nags (issue #951) — one per positioning error. */
export const PIT_STATUS_REPEAT_CONTRACTS: readonly ScenarioContract[] = POSITIONING_SUBJECTS.map(({ id, target }) =>
  pitStatusRepeatContract(id, target),
);

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const PIT_STATUS_SCENARIO_IDS: readonly string[] = PIT_STATUS_CONTRACTS.map((c) => c.id);

/** Repeat-contract ids, same purpose as {@link PIT_STATUS_SCENARIO_IDS}. */
export const PIT_STATUS_REPEAT_SCENARIO_IDS: readonly string[] = PIT_STATUS_REPEAT_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the pit-status scripts draw from — one
 * `pool:pit-status/<id>` per transition line and one `pool:pit-status/<id>-repeat`
 * per nag. The completeness tests read it: the bundled voice must ship at
 * least one clip for each, and the bundled script must reference exactly
 * this set. A `(group, base)` a script addresses is published — renaming a
 * base is a rename in every pack's script and every pack's clip folder.
 */
export const PIT_STATUS_CLIP_SOURCES: readonly { group: "pit-status"; base: string }[] = [
  ...PIT_STATUS_CONTRACTS.map((c) => ({
    group: "pit-status" as const,
    base: c.id.replace("pit-crew.pit-status-", ""),
  })),
  ...POSITIONING_SUBJECTS.map(({ id }) => ({ group: "pit-status" as const, base: `${id}-repeat` })),
];
