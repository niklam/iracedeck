/**
 * CameraCommand - Camera control commands for iRacing
 *
 * Note: Camera commands only work when you are out of your car (spectating/replay)
 */
import { ILogger } from "@iracedeck/logger";

import type { INativeSDK } from "../interfaces.js";
import { addFlag, CameraState, removeFlag } from "../types.js";
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, CameraFocusMode } from "./constants.js";

/**
 * Camera control commands
 */
export class CameraCommand extends BroadcastCommand {
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

    return this.sendBroadcast(BroadcastMsg.CamSwitchPos, position, group, camera);
  }

  /**
   * Switch camera by driver car number
   * @param carNumber Driver's car number or CameraFocusMode for special focus
   * @param group Camera group number
   * @param camera Camera number within group
   */
  switchNum(carNumber: number | CameraFocusMode, group: number, camera: number): boolean {
    this.logger.info(`SwitchNum: carNumber=${carNumber}, group=${group}, camera=${camera}`);

    return this.sendBroadcast(BroadcastMsg.CamSwitchNum, carNumber, group, camera);
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
   * Focus on cars exiting pits
   * @param group Camera group number
   * @param camera Camera number within group
   */
  focusOnExiting(group: number, camera: number): boolean {
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
   * Cycle to the next or previous sub-camera within the current group.
   * iRacing wraps automatically when the value goes out of range.
   * @param currentCarIdx Current car index from telemetry (CamCarIdx)
   * @param currentGroup Current camera group from telemetry (CamGroupNumber)
   * @param currentCamera Current camera number from telemetry (CamCameraNumber)
   * @param direction 1 for next, -1 for previous
   */
  cycleSubCamera(currentCarIdx: number, currentGroup: number, currentCamera: number, direction: 1 | -1): boolean {
    this.logger.info("Cycle sub-camera");
    this.logger.debug(
      `carIdx=${currentCarIdx}, group=${currentGroup}, camera=${currentCamera}, direction=${direction}`,
    );

    return this.switchPos(currentCarIdx, currentGroup, currentCamera + direction);
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
