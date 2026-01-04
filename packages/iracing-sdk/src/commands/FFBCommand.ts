/**
 * FFBCommand - Force feedback commands for iRacing
 *
 * You can call this any time
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, FFBCommandMode } from "./constants.js";

/**
 * Force feedback commands
 */
export class FFBCommand extends BroadcastCommand {
  private static _instance: FFBCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): FFBCommand {
    if (!FFBCommand._instance) {
      FFBCommand._instance = new FFBCommand();
    }

    return FFBCommand._instance;
  }

  /**
   * Set force feedback maximum force
   * @param forceNm Maximum force in Newton-meters
   */
  setMaxForce(forceNm: number): boolean {
    // Convert float to two 16-bit integers
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setFloat32(0, forceNm, true); // little-endian
    const low = view.getUint16(0, true);
    const high = view.getUint16(2, true);
    this.logger.info(`SetMaxForce: ${forceNm}Nm`);

    return this.sendBroadcast(BroadcastMsg.FFBCommand, FFBCommandMode.MaxForce, low, high);
  }
}
