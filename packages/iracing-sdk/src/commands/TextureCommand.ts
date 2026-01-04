/**
 * TextureCommand - Texture reload commands for iRacing
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, ReloadTexturesMode } from "./constants.js";

/**
 * Texture reload commands
 */
export class TextureCommand extends BroadcastCommand {
  private static _instance: TextureCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
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
    this.logger.info("Reload all");

    return this.sendBroadcast(BroadcastMsg.ReloadTextures, ReloadTexturesMode.All);
  }

  /**
   * Reload textures for a specific car
   * @param carIdx Car index
   */
  reloadCar(carIdx: number): boolean {
    this.logger.info(`Reload car: ${carIdx}`);

    return this.sendBroadcast(BroadcastMsg.ReloadTextures, ReloadTexturesMode.CarIdx, carIdx);
  }
}
