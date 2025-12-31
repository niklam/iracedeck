/**
 * TextureCommand - Texture reload commands for iRacing
 */

import streamDeck from '@elgato/streamdeck';
import { BroadcastCommand } from './BroadcastCommand';
import { BroadcastMsg, ReloadTexturesMode } from './constants';

/**
 * Texture reload commands
 */
export class TextureCommand extends BroadcastCommand {
	private static _instance: TextureCommand;

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): TextureCommand {
		if (!TextureCommand._instance) {
			TextureCommand._instance = new TextureCommand();
		}
		return TextureCommand._instance;
	}

	/**
	 * Reload all textures
	 */
	reloadAll(): boolean {
		streamDeck.logger.info('[TextureCommand] Reload all');
		return this.sendBroadcast(BroadcastMsg.ReloadTextures, ReloadTexturesMode.All);
	}

	/**
	 * Reload textures for a specific car
	 * @param carIdx Car index
	 */
	reloadCar(carIdx: number): boolean {
		streamDeck.logger.info(`[TextureCommand] Reload car: ${carIdx}`);
		return this.sendBroadcast(BroadcastMsg.ReloadTextures, ReloadTexturesMode.CarIdx, carIdx);
	}
}
