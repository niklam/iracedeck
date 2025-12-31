/**
 * CameraCommand - Camera control commands for iRacing
 *
 * Note: Camera commands only work when you are out of your car (spectating/replay)
 */

import streamDeck from '@elgato/streamdeck';
import { BroadcastCommand } from './BroadcastCommand';
import { BroadcastMsg, CameraFocusMode } from './constants';
import { CameraState, addFlag, removeFlag } from '../types';

/**
 * Camera control commands
 */
export class CameraCommand extends BroadcastCommand {
	private static _instance: CameraCommand;

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): CameraCommand {
		if (!CameraCommand._instance) {
			CameraCommand._instance = new CameraCommand();
		}
		return CameraCommand._instance;
	}

	/**
	 * Switch camera by car position
	 * @param position Car position (1-based) or CameraFocusMode for special focus
	 * @param group Camera group number
	 * @param camera Camera number within group
	 */
	switchPos(position: number | CameraFocusMode, group: number, camera: number): boolean {
		streamDeck.logger.info(`[CameraCommand] SwitchPos: position=${position}, group=${group}, camera=${camera}`);
		return this.sendBroadcast(BroadcastMsg.CamSwitchPos, position, group, camera);
	}

	/**
	 * Switch camera by driver car number
	 * @param carNumber Driver's car number or CameraFocusMode for special focus
	 * @param group Camera group number
	 * @param camera Camera number within group
	 */
	switchNum(carNumber: number | CameraFocusMode, group: number, camera: number): boolean {
		streamDeck.logger.info(`[CameraCommand] SwitchNum: carNumber=${carNumber}, group=${group}, camera=${camera}`);
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
		streamDeck.logger.info(`[CameraCommand] SetState: state=${state} (0x${state.toString(16)})`);
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
}
