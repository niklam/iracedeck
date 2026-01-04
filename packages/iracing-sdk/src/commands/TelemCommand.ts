/**
 * TelemCommand - Telemetry recording commands for iRacing
 *
 * You can call this any time, but telemetry only records when driver is in their car
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, TelemCommandMode } from "./constants.js";

/**
 * Telemetry recording commands
 */
export class TelemCommand extends BroadcastCommand {
  private static _instance: TelemCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
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
    this.logger.info("Stop");

    return this.sendBroadcast(BroadcastMsg.TelemCommand, TelemCommandMode.Stop);
  }

  /**
   * Start telemetry recording
   */
  start(): boolean {
    this.logger.info("Start");

    return this.sendBroadcast(BroadcastMsg.TelemCommand, TelemCommandMode.Start);
  }

  /**
   * Write current telemetry file to disk and start a new one
   */
  restart(): boolean {
    this.logger.info("Restart");

    return this.sendBroadcast(BroadcastMsg.TelemCommand, TelemCommandMode.Restart);
  }
}
