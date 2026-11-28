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
 * - **A fresh read beside the ticks.** The controller dispatches each
 *   `SessionTick` once, and in a paused replay the tick stands still while
 *   iRacing goes on moving the camera to another car, so the subscription
 *   never hears that change. While a run is on, one
 *   {@link AUTO_GROUP_POLL_MS} interval also reads the camera fresh
 *   (`getCurrentTelemetry()`) into the same car-change step: a tick and a
 *   read that see the same car are one change, never two. The interval
 *   starts with the subscription, survives a replace as it does, and ends on
 *   a stop.
 * - **The send** goes once, when the timer fires, through the replay engine's
 *   `requestCameraSwitch` with `interruptsWalks: false`; its target is worked
 *   out when it goes out, from the camera as it is then, and it keeps the
 *   car (`switchNum` with its `CarNumberRaw`), so it cannot trigger the run
 *   again. **It never takes the car from iRacing's director** (#1656): when
 *   the SDK's `CameraCommand.focusModeInEffect()` reads a director focus
 *   (the plugin's last camera switch was Focus on Leader, Incident or Most
 *   Exciting, and no switch to a car or Next / Previous Car key tap came
 *   after it), the switch is `switchPos(<that focus>, group, 0)` instead. On
 *   the sim a `switchNum` to the very car on camera stopped the director (3
 *   car changes in 30 s before it, none after), while `switchPos` with the
 *   focus changed the group, kept the car, and left the director choosing
 *   the next one, whose change is a trigger like any other. The read is the
 *   SDK's, at the send, since every switch from any action passes there; a
 *   focus turned on from iRacing's own camera screen is not seen, so there
 *   the switch names the car and takes it over, and one ended there still
 *   reads as in effect, so there the switch hands the car back to the
 *   director. It is dropped if the run was stopped or replaced while it waited,
 *   or if a later car change arrived meanwhile: that change has its own timer
 *   and its own send, so each change ends in at most one switch. It is
 *   dropped too when the fresh read at the send finds the camera on another
 *   car than the change it answers, before any tick or read reported that:
 *   the read is then the new change, with its own settle time.
 * - **A user's switch comes first** (decision 4): the send is a yielding one
 *   (`yields: true`), and the engine's camera-switch waiter keeps the rule:
 *   it never takes the waiting slot from a user's switch, gives it up to any
 *   user's switch, and waits out a lap press (Jump to Fastest Lap / Race
 *   Start) or a paced search. The send also says how long ago the car
 *   change that armed the timer happened (`triggeredMsAgo`), so the waiter
 *   drops it when a user's own switch went out since then: a Cycle Camera
 *   or Change Camera press inside the settle time is not overwritten. A
 *   user's switch that changes the car is a later trigger of its own. A
 *   change is seen late, by up to {@link AUTO_GROUP_POLL_MS} for one the
 *   fresh read notices, and by a whole paused stretch for one a tick first
 *   delivers when playback resumes: it happened somewhere after the last
 *   tick or read that still showed the old car. So the send also says how
 *   long ago that read was (`earliestTriggerMsAgo`), and the waiter drops it,
 *   too, for a user's switch of the angle only that went out since then: an
 *   angle the user picked after the camera moved is not overwritten. The car
 *   change itself stays dated at the read that saw it (`triggeredMsAgo`), for
 *   a tick and a fresh read alike: dating it from the read before would put a
 *   user's Next Car before its own car change, and drop the automatic switch
 *   that answers it. The run reads none of the engine's state.
 * - **A focus switch's echo is no trigger.** A car change within
 *   {@link AUTO_GROUP_FOCUS_ECHO_MS} after the run's own
 *   `switchPos(<focus>, group, 0)` went out, with the focus still in effect,
 *   is recorded as the new car and arms nothing: if iRacing re-picks the car
 *   on that switch (measured not to under Most Exciting, unmeasured under
 *   Leader and Incident), it would otherwise retrigger the run every settle
 *   time. A user's switch to a car in that second ends the focus, so it still
 *   triggers.
 * - **An unsettled replay exit holds a focus switch.** While the replay
 *   state holds a replay the tick no longer shows (`isReplayExitUnsettled`:
 *   a seek's blip, or the replay left with iRacing's own control, which the
 *   SDK hears of only when the exit grace runs out), a switch that would
 *   send the director focus waits and tries again a settle time later, as
 *   the same car change: a focus sent in the replay must not turn the
 *   director on live, and naming the car would stop a director still
 *   choosing in the replay.
 */
import { getCommands, getController } from "@iracedeck/deck-iracing";
import {
  CameraFocusMode,
  type CameraGroup,
  type DirectorFocusMode,
  getCameraGroupsFromSessionInfo,
  getCarNumberRawFromSessionInfo,
  isReplayExitUnsettled,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { requestCameraSwitch } from "@iracedeck/replay-engine";

import { autoGroupCandidates, type AutoGroupPick, pickAutoGroup } from "./auto-group-pick.js";
import { normalizeSessionGroups } from "./camera-groups.js";

/** How long the camera's car has to stay put before the group switch goes out (spec decision 3). */
export const AUTO_GROUP_SETTLE_MS = 250;

/** The run's telemetry subscription id: plugin-wide, apart from every action context's. */
export const AUTO_GROUP_SUBSCRIBER_ID = "camera-auto-group";

/**
 * How often a running automation reads the camera fresh, for the car changes
 * no tick delivers (a paused replay's frozen `SessionTick`). It is the delay
 * such a change can wait before its settle time starts, so a paused-replay
 * switch goes out at most 450 ms after the car change rather than 250 ms;
 * shorter buys little against the 250 ms settle, and it costs five native
 * reads a second beside the controller's own hundred.
 */
export const AUTO_GROUP_POLL_MS = 200;

/**
 * How long after the run's own `switchPos(<focus>, group, 0)` a car change is
 * taken as that switch's echo rather than a trigger (#1656). Whether iRacing
 * re-picks the car when a director focus is sent with a new group is measured
 * for Most Exciting only (it does not); under Leader or Incident a re-pick
 * would change `CamCarIdx`, and the run would switch the group again, and
 * again, every settle time. iRacing applies a broadcast within a frame or
 * two, and a frozen tick's change is read within {@link AUTO_GROUP_POLL_MS},
 * so an echo lands well inside a second even with a late frame. The director
 * itself re-picks at its own pace (3 car changes in 30 s, measured under Most
 * Exciting), so a real change inside the window is rare; one missed costs a
 * single group switch, where an echo taken as a trigger is a loop.
 */
export const AUTO_GROUP_FOCUS_ECHO_MS = 1_000;

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

/**
 * What the switch keeps while it changes the group: the director focus in
 * effect (sent as `switchPos(<focus>, group, 0)`), or else the camera's car
 * (`switchNum(<its CarNumberRaw>, group, 0)`).
 */
type AutoGroupKeep = { readonly focus: DirectorFocusMode } | { readonly carNumberRaw: number };

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
  /** When (`Date.now()`) the car change that armed the timer last was seen; null before the first. */
  changedAt: number | null;
  /**
   * The earliest that car change can have been (`Date.now()`): the last tick
   * or fresh read that still showed the old car, whichever saw the change;
   * null before the first.
   */
  changedSince: number | null;
  /** When (`Date.now()`) a tick or fresh read last showed a car; null until the first. */
  lastSeenAt: number | null;
  /**
   * When (`Date.now()`) the run last sent its switch as
   * `switchPos(<focus>, group, 0)`; null until it does. A car change inside
   * {@link AUTO_GROUP_FOCUS_ECHO_MS} after it is that switch's echo.
   */
  focusSentAt: number | null;
  /**
   * Counts the car changes seen: a switch asked for at one count is the
   * answer to that change only, and is dropped once a later one arrives.
   */
  trigger: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let active: Run | null = null;

/** The fresh-read interval, standing while a run is on: one for the module, like the subscription. */
let poll: ReturnType<typeof setInterval> | null = null;

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
    changedAt: null,
    changedSince: null,
    lastSeenAt: null,
    focusSentAt: null,
    trigger: 0,
    timer: null,
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

  startPoll();

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
  run.logger.info("Auto group settings updated");
  run.logger.debug(`Auto group settings updated: pick ${pick}, groups: ${names.join(", ") || "(none)"}`);

  return true;
}

/** Stops the automation, if one runs: the timer is cleared and the telemetry subscription ends. */
export function stopAutoGroup(): void {
  const run = active;

  if (run === null) return;

  clearTimer(run);
  stopPoll();
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
 * timer and the fresh-read interval and leaves the listeners, as a plugin
 * start never registers them twice. Tells no listener and ends no subscription.
 */
export function _resetAutoGroup(): void {
  if (active !== null) clearTimer(active);

  stopPoll();
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

function startPoll(): void {
  stopPoll();
  poll = setInterval(onPoll, AUTO_GROUP_POLL_MS);
}

function stopPoll(): void {
  if (poll !== null) clearInterval(poll);

  poll = null;
}

/** One telemetry tick: into the car-change step. */
function onTick(telemetry: TelemetryData | null): void {
  observe(telemetry);
}

/**
 * The fresh read, for a car change under a frozen tick. A read that throws
 * changes nothing: the next one, or the next tick, tries again.
 */
function onPoll(): void {
  if (active === null) return;

  let telemetry: TelemetryData | null;

  try {
    telemetry = getController().getCurrentTelemetry();
  } catch {
    return;
  }

  observe(telemetry);
}

/**
 * The car-change step every read goes through, tick or fresh: records the
 * camera's car and when it was seen, and arms the timer when it changed.
 * Comparing with the car last seen, whichever read saw it, is what keeps a
 * tick and a fresh read of the same change from arming twice. A change is
 * dated at the read that saw it (`changedAt`, what a user's switch of the car
 * is weighed against) and can have happened as early as the last read, tick
 * or fresh, that still showed the old car (`changedSince`, what a user's
 * switch of the angle is weighed against). A read with no car shows nothing,
 * so it moves neither time. A change inside {@link AUTO_GROUP_FOCUS_ECHO_MS}
 * of the run's own focus switch is that switch's echo: the new car is
 * recorded and nothing is armed.
 */
function observe(telemetry: TelemetryData | null): void {
  const run = active;

  if (run === null || telemetry === null) return;

  const car = telemetry.CamCarIdx;

  if (typeof car !== "number" || !Number.isInteger(car) || car < 0) return;

  const at = Date.now();
  const previousSeenAt = run.lastSeenAt;

  run.lastSeenAt = at;

  if (run.lastCar === null) {
    run.lastCar = car;

    return;
  }

  if (car === run.lastCar) return;

  const previousCar = run.lastCar;

  run.lastCar = car;

  if (isFocusEcho(run, at)) {
    run.logger.debug(
      `Auto group: car ${previousCar} -> ${car} ${at - (run.focusSentAt ?? at)} ms after its own focus switch, taken as that switch's echo, nothing armed`,
    );

    return;
  }

  run.changedAt = at;
  run.changedSince = previousSeenAt ?? at;
  run.trigger++;
  arm(run);
}

/**
 * Whether a car change seen at `at` is the echo of the run's own focus switch:
 * inside {@link AUTO_GROUP_FOCUS_ECHO_MS} after it, with the director focus
 * still in effect. A switch to a car or a Next / Previous Car tap since then
 * has ended the focus, so the user's own pick in that second is a trigger.
 */
function isFocusEcho(run: Run, at: number): boolean {
  if (run.focusSentAt === null || at - run.focusSentAt >= AUTO_GROUP_FOCUS_ECHO_MS) return false;

  return getCommands().camera.focusModeInEffect() !== null;
}

/**
 * The camera's car stayed put for the settle time: asks for the switch, once,
 * as a yielding one, so the engine's waiter puts any switch the user asks for
 * first and holds this one through a lap press or a paced search. It says how
 * long ago the car change was, measured rather than taken as the settle time,
 * since a timer can fire late: a user's switch that went out since then
 * drops it. It answers this car change only: a later one while it waits
 * (behind a replay hold, say) drops it, since that change arms a timer of
 * its own and this one would otherwise switch the new car's group before
 * the new car settled, and then again.
 */
function settle(run: Run): void {
  run.timer = null;

  if (run !== active) return;

  if (autoGroupTargets(run, true).length === 0) return;

  const trigger = run.trigger;
  // The car this change settled on: the timer is armed only once one is seen.
  const car = run.lastCar;

  if (car === null) return;

  void requestCameraSwitch(() => sendAuto(run, trigger, car), {
    by: "camera-controls auto-group",
    yields: true,
    triggeredMsAgo: msAgo(run.changedAt),
    earliestTriggerMsAgo: msAgo(run.changedSince),
    interruptsWalks: false,
    label: "Camera controls",
    name: "auto group",
    asked: "camera moved to another car",
    surface: "the auto group",
    stillValid: () => answersCurrent(run, trigger),
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

/** Whether a switch asked for at `trigger` still answers the run's latest car change. */
function answersCurrent(run: Run, trigger: number): boolean {
  return run === active && run.trigger === trigger;
}

/**
 * The switch, worked out from the camera as it is when it goes out, for the
 * car the change it answers settled on (`car`) only. A switch that waited
 * behind a replay jump can find the camera on another car that no tick or
 * fresh read has reported yet, so `answersCurrent` still passes: switching
 * that car's group would skip its settle time. The read is then taken as the
 * new car change, which arms its own timer and sends its own switch.
 */
function sendAuto(run: Run, trigger: number, car: number): void {
  if (!answersCurrent(run, trigger)) return;

  const controller = getController();
  const telemetry = controller.getCurrentTelemetry();
  const carIdx = telemetry?.CamCarIdx;

  if (!telemetry || typeof carIdx !== "number" || carIdx < 0) {
    run.logger.debug("Auto group: no camera car to switch, nothing sent");

    return;
  }

  if (carIdx !== car) {
    run.logger.debug(
      `Auto group: the camera moved from car ${car} to ${carIdx} before the switch went out, nothing sent`,
    );
    observe(telemetry);

    return;
  }

  // The director focus, read as the switch goes out (#1656): with Focus on
  // Leader, Incident or Most Exciting in charge, the switch names that focus
  // rather than the car, so iRacing changes the group and goes on picking the
  // cars; naming the car (on the sim, even the car already on camera) hands
  // the car to the user and stops the director. With no focus in effect it
  // keeps the car by its number, as before.
  const camera = getCommands().camera;
  const focus = camera.focusModeInEffect();
  let keep: AutoGroupKeep;

  if (focus !== null && isReplayExitUnsettled(controller.getReplayState())) {
    // A focus sent in the replay may be one the user has just left with
    // iRacing's own control, which the SDK hears of only when the exit grace
    // runs out: sent now, the focus would turn the director on live. Nor can
    // the car be named, since this may be a seek's blip with the director
    // still choosing. The switch waits for the state to settle, as the same
    // car change: a replay tick keeps the focus, the grace running out ends
    // it (the `replay-left` boundary) and the car is named.
    run.logger.debug("Auto group: the replay may just have been left, the switch waits for the replay state to settle");
    arm(run);

    return;
  }

  if (focus !== null) {
    keep = { focus };
  } else {
    const sessionInfo = controller.getSessionInfo();
    const carNumberRaw = sessionInfo ? getCarNumberRawFromSessionInfo(sessionInfo, carIdx) : null;

    if (carNumberRaw === null) {
      run.logger.info("Auto group switch skipped: the camera's car has no car number");
      run.logger.debug(`carIdx: ${carIdx}`);

      return;
    }

    keep = { carNumberRaw };
  }

  const currentGroup = typeof telemetry.CamGroupNumber === "number" ? telemetry.CamGroupNumber : null;
  const target = pickAutoGroup(autoGroupTargets(run, false), currentGroup, run.pick, run.lastPicked);

  if (target === null) {
    run.logger.debug(`Auto group: no other group to switch to (camera in group ${currentGroup}), nothing sent`);

    return;
  }

  // In order moves on only once the switch went out: a send that failed
  // (false) or threw (the waiter logs it) leaves the place in the list, so
  // the next car change offers the same group again rather than skipping it.
  const success =
    "focus" in keep
      ? camera.switchPos(keep.focus, target.groupNum, 0)
      : camera.switchNum(keep.carNumberRaw, target.groupNum, 0);
  const sent =
    "focus" in keep
      ? `switchPos(${CameraFocusMode[keep.focus]}), keeping the director focus`
      : `switchNum(carNumberRaw ${keep.carNumberRaw}), keeping the car`;

  if (success) run.lastPicked = target.groupName;

  if (success && "focus" in keep) run.focusSentAt = Date.now();

  run.logger.info(success ? "Camera group switched automatically" : "Automatic camera group switch failed");
  run.logger.debug(`Result: ${success}, ${sent}, group: ${target.groupNum} (${target.groupName}), pick: ${run.pick}`);
}

/** How long ago (`Date.now()`) `at` was, never negative; undefined for no time. */
function msAgo(at: number | null): number | undefined {
  return at === null ? undefined : Math.max(0, Date.now() - at);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
