/**
 * Auto Group on Car Change's run (#1656, spec decisions 2–5 of
 * `docs/superpowers/specs/2026-11-08-issue-1656-auto-camera-group-on-car-change.md`):
 * the one automation the plugin runs at a time, owned by the key or dial
 * context that started it.
 *
 * - **Run-scoped.** Module state only: never persisted, off at every plugin
 *   start. It survives its owner leaving the screen (a profile switch), and
 *   ends only with {@link toggleAutoGroup} on the active owner, a replace by
 *   another owner, or {@link stopAutoGroup}.
 * - **The trigger** is the camera's car (`CamCarIdx`) changing, from any
 *   source. The run watches the SDK controller under its own plugin-wide id
 *   ({@link AUTO_GROUP_SUBSCRIBER_ID}), not an action context's, since it
 *   outlives the context. The first car seen after a start or a replace is
 *   only recorded; a tick with no telemetry (iRacing gone) changes nothing.
 *   Each change (re)arms one {@link AUTO_GROUP_SETTLE_MS} timer, so a burst
 *   of changes ends in one switch.
 * - **The send** goes through the replay engine's `requestCameraSwitch` with
 *   `interruptsWalks: false`; its target is worked out when it goes out, from
 *   the car the camera is on then, and it keeps that car (`switchNum` with
 *   its `CarNumberRaw`), so it cannot trigger the run again. It is dropped if
 *   the run was stopped or replaced while it waited behind a jump.
 * - **A user's switch comes first** (plan decision 1): when the timer fires
 *   while a camera switch is waiting behind a jump, a lap press (Jump to
 *   Fastest Lap / Race Start) is in flight or a paced search is running, the
 *   timer is re-armed instead, since the engine's one waiting slot would
 *   otherwise give the user's switch up for this one.
 */
import { getCommands, getController } from "@iracedeck/deck-iracing";
import {
  type CameraGroup,
  getCameraGroupsFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  isCameraSwitchWaiting,
  isLapPressInFlight,
  pendingReplaySearch,
  requestCameraSwitch,
} from "@iracedeck/replay-engine";

import { autoGroupCandidates, type AutoGroupPick, pickAutoGroup } from "./auto-group-pick.js";
import { normalizeSessionGroups } from "./camera-groups.js";

/** How long the camera's car has to stay put before the group switch goes out (spec decision 3). */
export const AUTO_GROUP_SETTLE_MS = 250;

/** The run's telemetry subscription id: plugin-wide, apart from every action context's. */
export const AUTO_GROUP_SUBSCRIBER_ID = "camera-auto-group";

/** What starts a run: its owner, the list and pick order it runs with, and where its lines are logged. */
export interface AutoGroupStart {
  /** The key or dial context that asked. */
  readonly owner: string;
  /** The ticked group names (`autoGroupNames`). */
  readonly names: readonly string[];
  readonly pick: AutoGroupPick;
  /** The owner's logger; the run's lines go there. */
  readonly logger: ILogger;
}

/** What a toggle did. */
export type AutoGroupToggleResult = "started" | "replaced" | "stopped";

/** Hears the owner change: the new owner on a start or a replace, null on a stop. */
export type AutoGroupChangeListener = (owner: string | null) => void;

/** The one running automation. The object is its own identity: a replace makes a new one. */
interface Run {
  readonly owner: string;
  names: readonly string[];
  pick: AutoGroupPick;
  readonly logger: ILogger;
  /** The car last seen, or null until the first tick with one after the start or replace. */
  lastCar: number | null;
  /** The name of the group picked last, for In order. */
  lastPicked: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** What the send is waiting behind (plan decision 1), logged once when it starts waiting; null when not waiting. */
  waitingFor: string | null;
}

let active: Run | null = null;

/** Module wiring, registered by the action once: {@link _resetAutoGroup} leaves it. */
const listeners = new Set<AutoGroupChangeListener>();

/**
 * Turns the automation on or off for `start.owner`: off when it is the active
 * owner, otherwise on with its list and pick order, replacing any run of
 * another owner (which keeps the telemetry subscription and starts over from
 * the next car seen).
 */
export function toggleAutoGroup(start: AutoGroupStart): AutoGroupToggleResult {
  const current = active;

  if (current !== null && current.owner === start.owner) {
    stopAutoGroup();

    return "stopped";
  }

  const run: Run = {
    owner: start.owner,
    names: [...start.names],
    pick: start.pick,
    logger: start.logger,
    lastCar: null,
    lastPicked: null,
    timer: null,
    waitingFor: null,
  };

  if (current !== null) {
    clearTimer(current);
    active = run;
    run.logger.info("Auto group handed to another control");
    run.logger.debug(`Auto group owner ${current.owner} -> ${run.owner}`);
    notify(run.owner, run.logger);

    return "replaced";
  }

  active = run;

  try {
    // Delivers the current tick at once, which records the car.
    getController().subscribe(AUTO_GROUP_SUBSCRIBER_ID, onTick);
  } catch (err) {
    active = null;
    throw err;
  }

  run.logger.info("Auto group on");
  run.logger.debug(`Auto group owner ${run.owner}, pick ${run.pick}, groups: ${run.names.join(", ") || "(none)"}`);
  notify(run.owner, run.logger);

  return "started";
}

/**
 * Applies the owner's edited list and pick order to the running automation
 * (plan decision 5), keeping where In order has got to. Any other context's
 * edit is ignored. Returns whether it applied.
 */
export function updateAutoGroupSettings(owner: string, names: readonly string[], pick: AutoGroupPick): boolean {
  const run = active;

  if (run === null || run.owner !== owner) return false;

  run.names = [...names];
  run.pick = pick;
  run.logger.debug(`Auto group settings updated: pick ${pick}, groups: ${names.join(", ") || "(none)"}`);

  return true;
}

/** Stops the automation, if one runs: the timer is cleared and the telemetry subscription ends. */
export function stopAutoGroup(): void {
  const run = active;

  if (run === null) return;

  clearTimer(run);
  active = null;

  try {
    getController().unsubscribe(AUTO_GROUP_SUBSCRIBER_ID);
  } catch (err) {
    run.logger.warn(`Auto group: ending its telemetry subscription failed: ${describeError(err)}`);
  }

  run.logger.info("Auto group off");
  notify(null, run.logger);
}

/** The context that owns the running automation, or null when it is off. */
export function autoGroupOwner(): string | null {
  return active?.owner ?? null;
}

/** Whether `contextId` owns the running automation (its key or dial draws on). */
export function isAutoGroupOwner(contextId: string): boolean {
  return active !== null && active.owner === contextId;
}

/** Hears every start, replace and stop. Returns the unsubscribe. */
export function onAutoGroupChange(listener: AutoGroupChangeListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * @internal For tests: the plugin-start state, nothing running. Clears the
 * timer and leaves the listeners, as a plugin start never registers them twice.
 * Tells no listener and ends no subscription.
 */
export function _resetAutoGroup(): void {
  if (active !== null) clearTimer(active);

  active = null;
}

function notify(owner: string | null, logger: ILogger): void {
  for (const listener of [...listeners]) {
    try {
      listener(owner);
    } catch (err) {
      logger.warn(`Auto group: a change listener threw: ${describeError(err)}`);
    }
  }
}

function clearTimer(run: Run): void {
  if (run.timer !== null) clearTimeout(run.timer);

  run.timer = null;
}

function arm(run: Run): void {
  clearTimer(run);
  run.timer = setTimeout(() => settle(run), AUTO_GROUP_SETTLE_MS);
}

/** One telemetry tick: records the camera's car, and arms the timer when it changed. */
function onTick(telemetry: TelemetryData | null): void {
  const run = active;

  if (run === null || telemetry === null) return;

  const car = telemetry.CamCarIdx;

  if (typeof car !== "number" || !Number.isInteger(car) || car < 0) return;

  if (run.lastCar === null) {
    run.lastCar = car;

    return;
  }

  if (car === run.lastCar) return;

  run.lastCar = car;
  arm(run);
}

/** Whether a switch the user asked for is waiting, or a replay walk or search is under way: then the run waits. */
function replayBusy(): string | null {
  if (isCameraSwitchWaiting()) return "a camera switch is waiting for a replay jump";

  if (isLapPressInFlight()) return "a lap press is under way";

  if (pendingReplaySearch() !== null) return "a replay search is under way";

  return null;
}

/** The camera's car stayed put for the settle time: asks for the switch. */
function settle(run: Run): void {
  run.timer = null;

  if (run !== active) return;

  const busy = replayBusy();

  if (busy !== null) {
    if (run.waitingFor !== busy) run.logger.debug(`Auto group: ${busy}, the switch waits`);

    run.waitingFor = busy;
    arm(run);

    return;
  }

  run.waitingFor = null;

  if (autoGroupTargets(run, true).length === 0) return;

  void requestCameraSwitch(() => sendAuto(run), {
    by: "camera-controls auto-group",
    interruptsWalks: false,
    label: "Camera controls",
    name: "auto group",
    asked: "camera moved to another car",
    surface: "the auto group",
    stillValid: () => run === active,
    logger: run.logger,
  });
}

/**
 * The candidates in the current session, read now; empty when nothing can be
 * picked. With `log`, the names skipped are logged at debug (once per trigger,
 * when the timer fires, not again when the switch goes out).
 */
function autoGroupTargets(run: Run, log: boolean): CameraGroup[] {
  const sessionInfo = getController().getSessionInfo();
  const sessionGroups = sessionInfo ? normalizeSessionGroups(getCameraGroupsFromSessionInfo(sessionInfo)) : [];
  const { groups, missing, ambiguous } = autoGroupCandidates(run.names, sessionGroups);

  if (!log) return groups;

  if (missing.length > 0 && sessionGroups.length > 0) {
    run.logger.debug(`Auto group: not in this session's camera groups: ${missing.join(", ")}`);
  }

  if (ambiguous.length > 0) {
    run.logger.debug(`Auto group: matches more than one camera group, skipped: ${ambiguous.join(", ")}`);
  }

  if (groups.length === 0) run.logger.debug("Auto group: no group of the list is in this session, nothing sent");

  return groups;
}

/** The switch, worked out from the camera as it is when it goes out. */
function sendAuto(run: Run): void {
  if (run !== active) return;

  const controller = getController();
  const telemetry = controller.getCurrentTelemetry();
  const carIdx = telemetry?.CamCarIdx;

  if (!telemetry || typeof carIdx !== "number" || carIdx < 0) {
    run.logger.debug("Auto group: no camera car to switch, nothing sent");

    return;
  }

  const sessionInfo = controller.getSessionInfo();
  const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, carIdx) : null;

  if (carNumberRaw === null) {
    run.logger.info("Auto group switch skipped: the camera's car has no car number");
    run.logger.debug(`carIdx: ${carIdx}`);

    return;
  }

  const currentGroup = typeof telemetry.CamGroupNumber === "number" ? telemetry.CamGroupNumber : null;
  const target = pickAutoGroup(autoGroupTargets(run, false), currentGroup, run.pick, run.lastPicked);

  if (target === null) {
    run.logger.debug(`Auto group: no other group to switch to (camera in group ${currentGroup}), nothing sent`);

    return;
  }

  run.lastPicked = target.groupName;

  const success = getCommands().camera.switchNum(carNumberRaw, target.groupNum, 0);

  run.logger.info("Camera group switched automatically");
  run.logger.debug(
    `Result: ${success}, carNumberRaw: ${carNumberRaw}, group: ${target.groupNum} (${target.groupName}), pick: ${run.pick}`,
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
