/**
 * CameraCommand - Camera control commands for iRacing
 *
 * Note: Camera commands only work when you are out of your car (spectating/replay)
 *
 * Scope limit (issue #852): `CamSwitchPos` / `CamSwitchNum` change WHAT is
 * focused and WHICH camera group is active. Their third argument is documented
 * as a camera number, but iRacing does not act on it — verified on hardware
 * across three dispatch shapes, with the focused camera never moving. There is
 * therefore no SDK command that steps a sub-camera; iRacing exposes that only
 * as its own "Next / Previous Sub Camera" key bindings. Pass `0` for the camera
 * argument (as the official SDK sample does) and do not build a sub-camera
 * feature on it.
 *
 * **The director focus in effect (#1656).** A switch whose target is one of
 * the director's focus modes ({@link DIRECTOR_FOCUS_MODES}: Focus on Leader,
 * Incident or Most Exciting) hands the choice of car to iRacing, which goes
 * on re-picking it. A switch to a car or a position takes it back: measured
 * on the sim with Focus on Most Exciting on, `switchNum(<the camera's car>,
 * group, 0)` stopped the director (3 car changes in 30 s before, 0 after),
 * while `switchPos(FocusAtExiting, group, 0)` changed the group and left the
 * director choosing (2 car changes in the 30 s after). iRacing reports none of
 * this in telemetry, so this class keeps it: every `CamSwitchPos` /
 * `CamSwitchNum` the plugin sends passes here, and each records its target. A
 * director focus sets it; any other target (a car, a position,
 * `FocusAtDriver`, and so the `cycle*` helpers too, which target the camera's
 * car) clears it. {@link CameraCommand.focusModeInEffect} reads it, so a
 * switch that should only change the camera group (Camera Controls' Auto
 * Group) can send the mode's own target and keep the director. Two things
 * change the car without passing here, and they bound it: iRacing's Next /
 * Previous Car key bindings, which the plugin taps as keystrokes and so
 * reports with {@link CameraCommand.forgetFocusMode}; and iRacing's own camera
 * screen, which the plugin never sees, so a director focus turned on there is
 * not known here, and one ended there still reads as in effect. It is
 * run-scoped: a new instance (a plugin start) has none.
 *
 * It lives here, not in an action, because this class is the one choke point
 * every switch passes: a record kept beside it would have to be told by each
 * car-changing send (Camera Controls, Replay Control, Race Admin, the replay
 * engine's lap presses), and the one a later change forgot would leave the
 * director focus reading as in effect after the user picked a car.
 */
import { ILogger } from "@iracedeck/logger";

import type { INativeSDK } from "../interfaces.js";
import { addFlag, CameraState, removeFlag } from "../types.js";
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, CameraFocusMode } from "./constants.js";

/**
 * A focus target that hands the choice of car to iRacing's director, which
 * keeps re-picking it until a switch to a car or a position takes it back.
 */
export type DirectorFocusMode =
  CameraFocusMode.FocusAtIncident | CameraFocusMode.FocusAtLeader | CameraFocusMode.FocusAtExiting;

/** The director's focus modes. `FocusAtDriver` (0) is not one: it targets a car. */
export const DIRECTOR_FOCUS_MODES: readonly DirectorFocusMode[] = Object.freeze([
  CameraFocusMode.FocusAtIncident,
  CameraFocusMode.FocusAtLeader,
  CameraFocusMode.FocusAtExiting,
]);

/** Whether a switch target is one of the director's focus modes rather than a car or a position. */
export function isDirectorFocusMode(target: number): target is DirectorFocusMode {
  return (DIRECTOR_FOCUS_MODES as readonly number[]).includes(target);
}

/**
 * Camera control commands
 */
export class CameraCommand extends BroadcastCommand {
  /** The director focus the last switch targeted; null since a switch to a car or a position (file header). */
  private focusMode: DirectorFocusMode | null = null;

  constructor(native: INativeSDK, logger?: ILogger) {
    super(native, logger);
  }

  /**
   * Switch camera by car position
   * @param position Car position (1-based) or CameraFocusMode for special focus
   * @param group Camera group number
   * @param camera Camera number within group
   */
  switchPos(position: number | CameraFocusMode, group: number, camera: number): boolean {
    this.logger.info(`SwitchPos: position=${position}, group=${group}, camera=${camera}`);

    return this.sendSwitch(BroadcastMsg.CamSwitchPos, position, group, camera);
  }

  /**
   * Switch camera by driver car number
   * @param carNumber Driver's car number or CameraFocusMode for special focus
   * @param group Camera group number
   * @param camera Camera number within group
   */
  switchNum(carNumber: number | CameraFocusMode, group: number, camera: number): boolean {
    this.logger.info(`SwitchNum: carNumber=${carNumber}, group=${group}, camera=${camera}`);

    return this.sendSwitch(BroadcastMsg.CamSwitchNum, carNumber, group, camera);
  }

  /**
   * The director focus in effect: the focus mode the plugin's last camera
   * switch targeted, or null when there was none since the plugin started,
   * or a switch to a car or a position (or a Next / Previous Car key tap,
   * {@link forgetFocusMode}) came after it. A focus turned on or ended on
   * iRacing's own camera screen is not seen (the file header).
   */
  focusModeInEffect(): DirectorFocusMode | null {
    return this.focusMode;
  }

  /**
   * Records that the camera's car was picked by a route that does not pass
   * this class (iRacing's Next / Previous Car key bindings, tapped as
   * keystrokes), so no director focus is in effect any more. Sends nothing.
   */
  forgetFocusMode(): void {
    this.setFocusMode(null, "a car key binding was tapped");
  }

  /**
   * Sends a `CamSwitchPos` / `CamSwitchNum` and records its target. A target
   * that is not a director focus clears the record before the send, so even a
   * send that throws counts as a car the user picked; a director focus is
   * recorded only once its send went out, so a failed one leaves the record as
   * it was. Either way a doubt ends in the record reading "no focus", which
   * costs the director its turn at worst, never a car the user picked.
   */
  private sendSwitch(msg: BroadcastMsg, target: number, group: number, camera: number): boolean {
    const focus = isDirectorFocusMode(target) ? target : null;

    if (focus === null) this.setFocusMode(null, `switch to target ${target}`);

    const sent = this.sendBroadcast(msg, target, group, camera);

    if (sent && focus !== null) this.setFocusMode(focus, `switch to target ${target}`);

    return sent;
  }

  private setFocusMode(mode: DirectorFocusMode | null, why: string): void {
    if (mode === this.focusMode) return;

    this.logger.debug(`Director focus: ${describeFocus(this.focusMode)} -> ${describeFocus(mode)} (${why})`);
    this.focusMode = mode;
  }

  /**
   * Set camera state flags
   * Use the CameraState enum flags with addFlag/removeFlag helpers to build the state
   * @param state Camera state bitfield (CameraState flags)
   *
   * @example
   * // Hide UI
   * camera.setState(addFlag(currentState, CameraState.UIHidden));
   *
   * @example
   * // Show UI (remove UIHidden flag)
   * camera.setState(removeFlag(currentState, CameraState.UIHidden));
   */
  setState(state: number): boolean {
    this.logger.info(`SetState: state=${state} (0x${state.toString(16)})`);

    return this.sendBroadcast(BroadcastMsg.CamSetState, state);
  }

  /**
   * Hide the iRacing UI
   * @param currentState Current CamCameraState from telemetry
   */
  hideUI(currentState: number | undefined): boolean {
    const newState = addFlag(currentState, CameraState.UIHidden);

    return this.setState(newState);
  }

  /**
   * Show the iRacing UI (clear UIHidden flag)
   * @param currentState Current CamCameraState from telemetry
   */
  showUI(currentState: number | undefined): boolean {
    const newState = removeFlag(currentState, CameraState.UIHidden);

    return this.setState(newState);
  }

  /**
   * Focus on the race leader
   * @param group Camera group number
   * @param camera Camera number within group
   */
  focusOnLeader(group: number, camera: number): boolean {
    return this.switchPos(CameraFocusMode.FocusAtLeader, group, camera);
  }

  /**
   * Focus on the last incident
   * @param group Camera group number
   * @param camera Camera number within group
   */
  focusOnIncident(group: number, camera: number): boolean {
    return this.switchPos(CameraFocusMode.FocusAtIncident, group, camera);
  }

  /**
   * Focus on the car the iRacing director rates as most exciting in the moment.
   * Replay only.
   *
   * Note: the underlying SDK enum is `CameraFocusMode.FocusAtExiting`, which
   * mirrors the upstream typo in `irsdk_csFocusAtExiting`. The behavior is
   * iRacing's "Most Exciting" director focus, not pit-lane related.
   *
   * @param group Camera group number
   * @param camera Camera number within group
   */
  focusOnMostExciting(group: number, camera: number): boolean {
    return this.switchPos(CameraFocusMode.FocusAtExiting, group, camera);
  }

  /**
   * Cycle to the next or previous camera group.
   * iRacing wraps automatically when the value goes out of range.
   * @param currentCarIdx Current car index from telemetry (CamCarIdx)
   * @param currentGroup Current camera group from telemetry (CamGroupNumber)
   * @param direction 1 for next, -1 for previous
   */
  cycleCamera(currentCarIdx: number, currentGroup: number, direction: 1 | -1): boolean {
    this.logger.info("Cycle camera group");
    this.logger.debug(`carIdx=${currentCarIdx}, group=${currentGroup}, direction=${direction}`);

    return this.switchPos(currentCarIdx, currentGroup + direction, 0);
  }

  /**
   * Cycle to the next or previous car.
   * Pass 0 for group and camera to keep current camera settings.
   * iRacing wraps automatically when the value goes out of range.
   * @param currentCarIdx Current car index from telemetry (CamCarIdx)
   * @param direction 1 for next, -1 for previous
   */
  cycleCar(currentCarIdx: number, direction: 1 | -1): boolean {
    this.logger.info("Cycle car");
    this.logger.debug(`carIdx=${currentCarIdx}, direction=${direction}`);

    return this.switchPos(currentCarIdx + direction, 0, 0);
  }

  /**
   * Cycle to the next or previous driving camera.
   * Semantically identical to cycleCamera — both cycle camera groups.
   * The distinction exists for user clarity (driving cameras are specific camera groups).
   * @param currentCarIdx Current car index from telemetry (CamCarIdx)
   * @param currentGroup Current camera group from telemetry (CamGroupNumber)
   * @param direction 1 for next, -1 for previous
   */
  cycleDrivingCamera(currentCarIdx: number, currentGroup: number, direction: 1 | -1): boolean {
    this.logger.info("Cycle driving camera");
    this.logger.debug(`carIdx=${currentCarIdx}, group=${currentGroup}, direction=${direction}`);

    return this.switchPos(currentCarIdx, currentGroup + direction, 0);
  }
}

function describeFocus(mode: DirectorFocusMode | null): string {
  return mode === null ? "none" : CameraFocusMode[mode];
}
