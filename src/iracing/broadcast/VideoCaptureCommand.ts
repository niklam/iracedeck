/**
 * VideoCaptureCommand - Video capture commands for iRacing
 */

import streamDeck from '@elgato/streamdeck';
import { BroadcastCommand } from './BroadcastCommand';
import { BroadcastMsg, VideoCaptureMode } from './constants';

/**
 * Video capture commands
 */
export class VideoCaptureCommand extends BroadcastCommand {
	private static _instance: VideoCaptureCommand;

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): VideoCaptureCommand {
		if (!VideoCaptureCommand._instance) {
			VideoCaptureCommand._instance = new VideoCaptureCommand();
		}
		return VideoCaptureCommand._instance;
	}

	/**
	 * Take a screenshot
	 */
	screenshot(): boolean {
		streamDeck.logger.info('[VideoCaptureCommand] Screenshot');
		return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.TriggerScreenShot);
	}

	/**
	 * Start video capture
	 */
	start(): boolean {
		streamDeck.logger.info('[VideoCaptureCommand] Start');
		return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.StartVideoCapture);
	}

	/**
	 * Stop video capture
	 */
	stop(): boolean {
		streamDeck.logger.info('[VideoCaptureCommand] Stop');
		return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.EndVideoCapture);
	}

	/**
	 * Toggle video capture on/off
	 */
	toggle(): boolean {
		streamDeck.logger.info('[VideoCaptureCommand] Toggle');
		return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.ToggleVideoCapture);
	}

	/**
	 * Show video timer in upper left corner
	 */
	showTimer(): boolean {
		streamDeck.logger.info('[VideoCaptureCommand] Show timer');
		return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.ShowVideoTimer);
	}

	/**
	 * Hide video timer
	 */
	hideTimer(): boolean {
		streamDeck.logger.info('[VideoCaptureCommand] Hide timer');
		return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.HideVideoTimer);
	}
}
