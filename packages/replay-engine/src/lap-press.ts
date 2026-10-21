/**
 * The press machinery Jump to Fastest Lap and Jump to Race Start share
 * (#1467, out of `ReplayControl`): the one in-flight slot, the press's replay
 * jump and its claim on the cursor, the wait before a camera switch of its
 * own, and the jump to a frame with its log lines. One replay, one press: the
 * slot is module state, where it was one per action instance. Every line goes
 * to the engine's `ReplayControl` scope, so the log reads as it did.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { now } from "./engine-clock.js";
import { waitForReplayJumpsToSettle } from "./replay-command-gate.js";
import type { ReplayCursorClaim } from "./replay-cursor.js";
import { engineEnv, engineLogger, engineReads } from "./replay-engine-env.js";
import {
  beginReplayJump,
  describeReplayJump,
  type ReplayJump,
  type ReplayJumpApplied,
  type ReplayJumpOutcome,
  runReplayJump,
} from "./replay-jump-playback.js";
import { formatSpeedDisplay } from "./replay-speed-format.js";

/**
 * Thrown inside a Jump to Fastest Lap or Jump to Race Start press — the walk
 * or a record jump — when a replay command, any action's, took the cursor;
 * {@link holdLapPressSlot} catches it.
 */
export class FastestLapPressCancelled extends Error {
  constructor(
    readonly by: string,
    noun: "walk" | "jump" = "walk",
  ) {
    super(`${noun} cancelled by ${by}`);
    this.name = "FastestLapPressCancelled";
  }
}

// The walks claim the replay cursor under the engine's FASTEST_LAP_WALK_OWNER
// and RACE_START_WALK_OWNER (`lap-walk-owners.ts`), the two owners a camera
// switch cancels.

/** The owner name a record jump claims the replay cursor under while it waits for the landing (#1275). */
export const FASTEST_LAP_RECORD_JUMP_OWNER = "jump-to-fastest-lap record jump";

/** What opens the log lines of a Jump to Fastest Lap press, where a shared step writes them. */
export const FASTEST_LAP_LOG_LABEL = "Jump to fastest lap";

/** The owner name a Jump to Race Start press claims the replay cursor under for its single waited jump. */
export const RACE_START_JUMP_OWNER = "jump-to-race-start jump";

/** What opens the log lines of a Jump to Race Start press. */
export const RACE_START_LOG_LABEL = "Jump to race start";

/** How a press that holds the in-flight slot names itself: on the replay cursor, and in the log. */
export type LapPressIdentity = {
  owner: string;
  noun: "walk" | "jump";
  /** What opens the press's log lines. */
  label: string;
};

/** The press in the slot: the origin token it was pressed under, and its claim on the cursor. */
export type ActiveLapPress = { readonly origin: string; readonly claim: ReplayCursorClaim };

/**
 * The one in-flight Jump to Fastest Lap or Jump to Race Start press — two
 * keys would otherwise run two walks against one cursor. A second press of
 * either while it stands is dropped before any command is sent. Any replay
 * command — Replay Control's other modes, Replay Markers' jumps — cancels it
 * through the shared cursor claim, and the walk unwinds at its next await
 * without sending anything more. A cancelled walk no longer holds the slot: a
 * new press walks while the old one unwinds.
 */
let activeLapPress: ActiveLapPress | null = null;

/** The engine's `ReplayControl` scope: the presses and walks log where `ReplayControl` did. */
export function lapPressLogger(): ILogger {
  return engineLogger("ReplayControl");
}

/** The session info the SDK holds now, read from the controller. */
export function readSessionInfo(): unknown {
  return engineEnv().controller?.getSessionInfo();
}

/**
 * Whether a replay is on screen, from the controller's debounced replay state
 * (#1324): the read the presses and walks take before they send, as they took
 * it from the action's controller.
 */
export function replayOnScreen(): boolean {
  return engineEnv().controller?.getReplayState().inReplay ?? false;
}

/** A press that has not been cancelled holds the slot; one unwinding after a cancel does not. */
export function isLapPressInFlight(): boolean {
  return activeLapPress !== null && activeLapPress.claim.cancelledBy === null;
}

/** The origin token of the press in the slot, for the ignored press's debug line. */
export function activeLapPressOrigin(): string | undefined {
  return activeLapPress?.origin;
}

/** @internal For tests: the press in the slot, cancelled or not. */
export function _activeLapPress(): ActiveLapPress | null {
  return activeLapPress;
}

/** @internal For tests: an empty slot. */
export function _resetLapPress(): void {
  activeLapPress = null;
}

/**
 * Run one Jump to Fastest Lap or Jump to Race Start press — a walk or a
 * record jump — holding the replay cursor and the in-flight slot for its
 * whole duration, so any replay command cancels it and a second press of
 * either mode is ignored. The press starts as a replay jump
 * (`beginReplayJump`, #1276): the speed the replay has now is captured before
 * `run` sends anything, which is what the **Replay jump playback** setting's
 * `remember` restores at the end. The press signals a cancellation by
 * throwing {@link FastestLapPressCancelled}.
 *
 * The jump is opened with the replay command gate under the press's origin
 * token (#1430). `target.frame` is the frame a record jump is going to, known
 * at the press, and `target.afterLanding` its own step once landed: the gate
 * records the frame as where the replay is headed before the pause, and runs
 * the step on the read-back when a key took the cursor in the meantime. A
 * walk, whose frame is found as it goes, passes neither.
 */
export async function holdLapPressSlot(
  origin: string,
  press: LapPressIdentity,
  run: (jump: ReplayJump) => Promise<void>,
  target: { frame?: number; afterLanding?: (landing: TelemetryData) => boolean } = {},
): Promise<void> {
  const { owner, noun, label } = press;
  const jump = beginReplayJump(
    owner,
    engineReads().readTelemetry(),
    (by) => {
      lapPressLogger().info(`${label}: ${noun} cancelled by ${by}`);
    },
    now(),
    { origin, frame: target.frame, afterLanding: target.afterLanding },
  );
  const { claim } = jump;

  activeLapPress = { origin, claim };

  try {
    await run(jump);
  } catch (error) {
    if (error instanceof FastestLapPressCancelled) {
      lapPressLogger().debug(`${label}: ${error.message}; cursor left where that command put it`);
    } else {
      lapPressLogger().error(`${label}: ${noun} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    jump.end();

    // A cancelled press may unwind after a newer one took the slot.
    if (activeLapPress?.claim === claim) activeLapPress = null;
  }
}

/**
 * Waits until no jump is under way before a camera switch a press makes for
 * itself outside a jump's landing step: the walk's switch onto the car it
 * searches on, Jump to Race Start's borrow of the pole car, and the camera
 * going back after a search that gave up (#1430). iRacing drops a camera
 * change that arrives during a seek, and a search on the car on screen
 * finds another car's lap. A wait that runs out is logged and lets the
 * switch go anyway. Throws {@link FastestLapPressCancelled} when another
 * command took the cursor meanwhile: that command's own effect stands, the
 * camera included.
 */
export async function waitToSwitchCamera(claim: ReplayCursorClaim, label: string): Promise<void> {
  const settled = await waitForReplayJumpsToSettle(claim);

  if (settled === "superseded") throw new FastestLapPressCancelled(claim.cancelledBy ?? "unknown");

  if (settled === "gave-up") lapPressLogger().debug(`${label}: a jump was still under way; camera switched anyway`);
}

/**
 * Jump to an absolute frame through the shared sequence
 * (`replay-jump-playback.ts`, #1276): pause a moving replay and wait for the
 * pause to show, seek and wait for `ReplayFrameNum` to read `frame` — iRacing
 * searches a long jump in steps and any command arriving mid-search cuts it
 * short (#1275) — then `afterLanding`, then the speed the **Replay jump
 * playback** setting asks for. Every speed it sends is the engine's speed
 * state's (the gate records it), and the keys redraw from its change
 * subscription.
 *
 * `jump` comes from `beginReplayJump`, called at the press before any
 * command; the caller ends it. `label` opens every log line, so each mode
 * that jumps reads as itself in the log. `afterLanding` is the mode's own
 * command once the cursor has landed (a camera switch); returning false
 * stops the jump paused on the frame, and that step logs why.
 *
 * Never throws for a jump that stopped short or was cancelled: the outcome
 * says which. A stopped jump has sent nothing more and is logged here, so
 * the replay is paused where it stopped whatever the setting says. A
 * cancelled one is the caller's to report.
 */
export async function runJumpToFrame(
  jump: ReplayJump,
  options: { frame: number; label: string; afterLanding?: (landing: TelemetryData) => boolean },
): Promise<ReplayJumpOutcome> {
  const { frame, label, afterLanding } = options;
  const outcome = await runReplayJump(jump, {
    frame,
    readTelemetry: () => engineReads().readTelemetry(),
    afterLanding,
  });

  if (outcome.kind === "landed") {
    reportReplayJumpSpeed(label, outcome);
  } else if (outcome.kind === "stopped") {
    logReplayJumpStopped(label, frame, outcome);
  }

  return outcome;
}

/**
 * Report a speed command a jump could not send. A speed it did send is
 * already the engine's speed state's (the gate records it), so the icons and
 * the Play key follow it without waiting for telemetry: the keys redraw from
 * the speed state's change subscription.
 */
export function reportReplayJumpSpeed(label: string, applied: ReplayJumpApplied): void {
  if (applied.command === "failed") {
    lapPressLogger().warn(`${label}: speed command failed; replay left paused on the frame`);
    lapPressLogger().debug(`Replay still at ${formatSpeedDisplay(applied.speed.speed, applied.speed.slowMotion)}`);
  }
}

/** One warning for a jump that stopped short, the details at debug. A failed `afterLanding` step is logged by that step. */
export function logReplayJumpStopped(
  label: string,
  frame: number,
  outcome: Extract<ReplayJumpOutcome, { kind: "stopped" }>,
): void {
  if (outcome.reason === "after-landing-failed") return;

  const report = describeReplayJump(outcome, frame);

  lapPressLogger().warn(`${label}: ${report.warn}`);
  lapPressLogger().debug(`${label}: ${report.detail}`);
}
