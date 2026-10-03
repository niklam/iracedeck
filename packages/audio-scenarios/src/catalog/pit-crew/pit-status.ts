/**
 * Pit-service status contracts (issue #479) and their positioning-error
 * repeat nags (issue #951); scripted since #1065.
 *
 * Eight contracts — one per non-`None` `PlayerCarPitSvStatus` target —
 * fire on `pitService.statusChanged` filtered by `data.to`. The translator
 * already suppresses `* → None` so the silent idle state never reaches
 * the bus.
 *
 * A ninth, {@link PIT_STATUS_NOTHING_TO_DO_CONTRACT} (issue #1180), releases
 * the driver from a stop that ended with nothing done: iRacing never reports
 * Complete then, so it fires on `pitService.stopEmpty` instead. It shares the
 * family, but lives outside `PIT_STATUS_CONTRACTS` because it has no clip pool
 * of its own, and it queues behind a busy radio rather than being dropped.
 *
 * **The in-progress hold (issue #1180).** On that empty stop the status reads
 * InProgress for a single tick, and the translator mirrors it, so the
 * in-progress line waits {@link PIT_STATUS_IN_PROGRESS_HOLD_MS} and is dropped
 * at speak time if the live status has left InProgress — otherwise the driver
 * would hear "Pit stop in progress." cut off by the release. The hold lives
 * here, on the consumer, so `pitService.statusChanged` keeps mirroring the sim.
 *
 * The code below decides WHEN a status line fires and how it is scheduled;
 * WHAT is said lives in the active voice's `callouts.json` under the same ids
 * (`scenarios["pit-crew.pit-status-in-progress"]`, …), where the bundled
 * script addresses each line directly as `pool:pit-status/<id>`. The only
 * vocabulary this family registers is the five `pitStatus.still*` conditions
 * ({@link registerPitStatusVocabulary}), published for packs since the nags'
 * own gate moved onto the contracts (#1138); no bundled entry branches on
 * anything.
 *
 * **Family preemption.** All nine share `family: "pit-status"` so a rapid
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
 * **The re-check is the contract's, not the script's** (issue #1138). Each
 * nag carries a `speakGate` the engine asks after the active voice's script
 * has expanded and before the ops take the bus, so a nag that waited behind a
 * longer line is dropped once the driver has corrected — in EVERY voice,
 * whatever its script says. It was a `{ "if": "pitStatus.stillTooFarLeft",
 * … }` around the whole body until #1138, which held only for a pack that
 * kept the `if`; the bundled entry is the clip alone now. The condition stays
 * registered ({@link registerPitStatusVocabulary}) so a pack MAY still write
 * that `if` — belt and braces, changing nothing here — which is why it has to
 * stay a pure read.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { getLatestTelemetry, PIT_STATUS_MOVEMENT_SPEED_MPS } from "@iracedeck/sim-events-iracing";

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
 * How long the in-progress line waits before it decides to speak (issue
 * #1180). With nothing queued iRacing reports InProgress for a single tick
 * (0.02 s in the 2026-09-19 capture) and drops straight back to None, while a
 * real stop's InProgress lasts seconds (19 s in the same capture). A
 * quarter-second is long enough for the empty stop's status to have closed,
 * so its speak-time gate drops the line, and short enough that nobody hears
 * the delay on a real stop.
 */
export const PIT_STATUS_IN_PROGRESS_HOLD_MS = 250;

/**
 * The statuses that describe an uncorrected parking error — the ones the
 * translator repeats. Single-sourced here so the transition contracts, their
 * repeat siblings and the `pitStatus.still*` conditions can never disagree
 * about which subjects those are. `cond` is the name the condition is
 * published under; `still` is the phrase both it and the nag's `speakGate`
 * describe themselves with; `description` and `repeatDescription` are the
 * reference's (#1066) one sentence on when the transition line and its nag
 * fire.
 *
 * @internal Exported for testing — the test enumerates the conditions from it.
 */
export const POSITIONING_SUBJECTS: readonly {
  readonly id: string;
  readonly target: PitSvStatus;
  readonly cond: string;
  readonly still: string;
  readonly description: string;
  readonly repeatDescription: string;
}[] = [
  {
    id: "too-far-left",
    target: PitSvStatus.TooFarLeft,
    cond: "pitStatus.stillTooFarLeft",
    still: "too far left",
    description: "You stop in the pit lane too far left of your box for the crew to work on the car.",
    repeatDescription:
      "You stay parked too far left of your box after the first correction, about every two seconds while the car is at rest.",
  },
  {
    id: "too-far-right",
    target: PitSvStatus.TooFarRight,
    cond: "pitStatus.stillTooFarRight",
    still: "too far right",
    description: "You stop in the pit lane too far right of your box for the crew to work on the car.",
    repeatDescription:
      "You stay parked too far right of your box after the first correction, about every two seconds while the car is at rest.",
  },
  {
    id: "too-far-forward",
    target: PitSvStatus.TooFarForward,
    cond: "pitStatus.stillTooFarForward",
    still: "too far forward",
    description: "You overshoot your box marks and stop too far forward for the crew to work on the car.",
    repeatDescription:
      "You stay parked past your box marks after the first correction, about every two seconds while the car is at rest.",
  },
  {
    id: "too-far-back",
    target: PitSvStatus.TooFarBack,
    cond: "pitStatus.stillTooFarBack",
    still: "too far back",
    description: "You stop short of your box marks, too far back for the crew to work on the car.",
    repeatDescription:
      "You stay parked short of your box marks after the first correction, about every two seconds while the car is at rest.",
  },
  {
    id: "bad-angle",
    target: PitSvStatus.BadAngle,
    cond: "pitStatus.stillBadAngle",
    still: "at a bad angle",
    description: "You stop across your box at an angle the crew cannot work at.",
    repeatDescription:
      "You stay parked across your box at a bad angle after the first correction, about every two seconds while the car is at rest.",
  },
];

function pitStatusContract(
  id: string,
  target: PitSvStatus,
  description: string,
  extra: Partial<ScenarioContract> = {},
): ScenarioContract {
  return {
    id: `pit-crew.pit-status-${id}`,
    description,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "pit-status",
    when: {
      event: "pitService.statusChanged",
      where: (e) => (e as SimEventOf<"pitService.statusChanged">).data.to === target,
    },
    ...extra,
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
 * The contract's `speakGate` (issue #1138) is where that is asked: after the
 * script expands, before the bus take, on the first fire and on every
 * deferred replay. Read live, so it answers about the status NOW rather than
 * the one the event carried. Unknown telemetry means play: a callout is never
 * suppressed by absent data (#574), which also keeps the scenario harness
 * able to audition every nag without iRacing running.
 *
 * A pure read, used twice — as the gate and as the registered condition a
 * pack may wrap its own body in.
 */
function stillMisalignedAs(target: PitSvStatus): boolean {
  const telemetry = getLatestTelemetry() as TelemetryData | null;

  if (telemetry === null) return true;

  const status = telemetry.PlayerCarPitSvStatus;

  return status === undefined || status === target;
}

/**
 * The in-progress line's speak-time gate (issue #1180): the live
 * `PlayerCarPitSvStatus` still reads InProgress once the
 * {@link PIT_STATUS_IN_PROGRESS_HOLD_MS} hold has run out. An empty stop has
 * closed to None by then, so its line is dropped and only the release is
 * heard. Unknown telemetry, or a missing status, means play (#574) — the
 * {@link stillMisalignedAs} rule, which also keeps the scenario harness's
 * bus-event button firable.
 */
function stillInProgress(): boolean {
  const telemetry = getLatestTelemetry() as TelemetryData | null;

  if (telemetry === null) return true;

  const status = telemetry.PlayerCarPitSvStatus;

  return status === undefined || status === PitSvStatus.InProgress;
}

/**
 * The release's speak-time gate (issue #1180): the car is still stopped in its
 * box with no service under way — on the pit-stall surface, at rest (the
 * translator's {@link PIT_STATUS_MOVEMENT_SPEED_MPS}, signed speed), and the
 * status still None. The release is queueable, so it can wait behind a busy
 * radio; once the driver has pulled away, or a new stop has begun, "go" is
 * old news. Each missing field, and missing telemetry, admits (#574).
 */
function stillStoppedInBox(): boolean {
  const telemetry = getLatestTelemetry() as TelemetryData | null;

  if (telemetry === null) return true;

  const { PlayerTrackSurface: surface, Speed: speed, PlayerCarPitSvStatus: status } = telemetry;

  if (surface !== undefined && surface !== TrkLoc.InPitStall) return false;

  if (speed !== undefined && Math.abs(speed) > PIT_STATUS_MOVEMENT_SPEED_MPS) return false;

  return status === undefined || status === PitSvStatus.None;
}

function pitStatusRepeatContract(
  id: string,
  target: PitSvStatus,
  description: string,
  still: string,
): ScenarioContract {
  return {
    id: `pit-crew.pit-status-${id}-repeat`,
    description,
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
    speakGate: {
      description: `The car is still ${still} in the pit box when the nag comes to speak, or telemetry is unavailable.`,
      admit: () => stillMisalignedAs(target),
    },
  };
}

/**
 * Register the vocabulary the pit-status family publishes (issue #1065):
 * one `pitStatus.still<Error>` condition per positioning error — the same
 * pure read each nag's `speakGate` asks. Five conditions rather than one
 * case, because each asks a different question ("is the car still in MY
 * error"), and a pack may write an `if` on one without touching the others.
 *
 * Since #1138 the bundled voice references none of them: the engine already
 * asks the question at speak time, so a pack that wraps a nag's body in its
 * condition changes nothing about the bundled behaviour, and one that does
 * not is held to the same pacing anyway. They stay published so a pack CAN
 * go silent on its own terms — say, only nagging about the left/right pair.
 * Descriptions feed the generated reference (#1066).
 */
export function registerPitStatusVocabulary(engine: Pick<IScenarioEngine, "defineCond">): void {
  for (const { target, cond, still } of POSITIONING_SUBJECTS) {
    engine.defineCond(
      cond,
      () => stillMisalignedAs(target),
      `The car is still ${still} in the pit box according to live telemetry, or telemetry is unavailable. The engine already asks this at speak time — it is the nag's own gate — so wrapping a nag's body in it changes nothing; it is here for a pack that wants a nag silent on its own terms. Unknown telemetry counts as still wrong, never as fixed.`,
    );
  }
}

export const PIT_STATUS_CONTRACTS: readonly ScenarioContract[] = [
  pitStatusContract(
    "in-progress",
    PitSvStatus.InProgress,
    "You are stopped in your pit box and the crew begins working on the car.",
    {
      // Held, then re-checked (issue #1180): a stop with nothing to do reads
      // InProgress for one tick, and this line must not start only to be cut
      // off by the release.
      triggerDelay: PIT_STATUS_IN_PROGRESS_HOLD_MS,
      speakGate: {
        description:
          "The crew is still working on the car a quarter-second after the stop began, or telemetry is unavailable.",
        admit: stillInProgress,
      },
    },
  ),
  pitStatusContract(
    "complete",
    PitSvStatus.Complete,
    "The crew completes every queued service on your car in the pit box.",
  ),
  ...POSITIONING_SUBJECTS.map(({ id, target, description }) => pitStatusContract(id, target, description)),
  pitStatusContract(
    "cant-fix-that",
    PitSvStatus.CantFixThat,
    "You stop in your pit box with damage the crew cannot repair.",
  ),
];

/**
 * The release after a stop with nothing to do (issue #1180). iRacing never
 * reports Complete when no service is queued — InProgress drops straight back
 * to None — so the translator publishes `pitService.stopEmpty` instead, and
 * this line releases the driver. Same family as the status lines, so a later
 * status still preempts it. Kept OUT of {@link PIT_STATUS_CONTRACTS}: that
 * list derives one `pool:pit-status/<base>` per contract for
 * {@link PIT_STATUS_CLIP_SOURCES}, and this one has no pool of its own — the
 * bundled voices script it onto `pool:pit-status/complete`, and a pack may
 * give it its own line.
 *
 * Queueable, with a speak-time gate: it fires at the busiest radio moment of
 * the stop (the count-in, a limiter or opponent-pit line), and a release
 * dropped behind one of those would be the original silence again. The gate
 * drops it once the car has left the box, so a late "go" is never heard on
 * the way out.
 */
export const PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID = "pit-crew.pit-status-nothing-to-do";

export const PIT_STATUS_NOTHING_TO_DO_CONTRACT: ScenarioContract = {
  id: PIT_STATUS_NOTHING_TO_DO_SCENARIO_ID,
  description: "You stop in your pit box with no service queued, so the crew has nothing to do and you can leave.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "pit-status",
  when: { event: "pitService.stopEmpty" },
  queueable: true,
  speakGate: {
    description: "The car is still stopped in its pit box with no service under way, or telemetry is unavailable.",
    admit: stillStoppedInBox,
  },
};

/** The terse "still uncorrected" nags (issue #951) — one per positioning error. */
export const PIT_STATUS_REPEAT_CONTRACTS: readonly ScenarioContract[] = POSITIONING_SUBJECTS.map(
  ({ id, target, repeatDescription, still }) => pitStatusRepeatContract(id, target, repeatDescription, still),
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
