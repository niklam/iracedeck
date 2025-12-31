/**
 * TelemCommand - Telemetry recording commands for iRacing
 *
 * You can call this any time, but telemetry only records when driver is in their car
 */

import streamDeck from '@elgato/streamdeck';
import { BroadcastCommand } from './BroadcastCommand';
import { BroadcastMsg, TelemCommandMode } from './constants';

/**
 * Telemetry recording commands
 */
export class TelemCommand extends BroadcastCommand {
	private static _instance: TelemCommand;

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): TelemCommand {
		if (!TelemCommand._instance) {
			TelemCommand._instance = new TelemCommand();
		}
		return TelemCommand._instance;
	}

	/**
	 * Stop telemetry recording
	 */
	stop(): boolean {
		streamDeck.logger.info('[TelemCommand] Stop');
		return this.sendBroadcast(BroadcastMsg.TelemCommand, TelemCommandMode.Stop);
	}

	/**
	 * Start telemetry recording
	 */
	start(): boolean {
		streamDeck.logger.info('[TelemCommand] Start');
		return this.sendBroadcast(BroadcastMsg.TelemCommand, TelemCommandMode.Start);
	}

	/**
	 * Write current telemetry file to disk and start a new one
	 */
	restart(): boolean {
		streamDeck.logger.info('[TelemCommand] Restart');
		return this.sendBroadcast(BroadcastMsg.TelemCommand, TelemCommandMode.Restart);
	}
}
