/**
 * BroadcastCommand - Base class for all iRacing broadcast commands
 *
 * Provides the core messaging functionality that all command classes inherit.
 */
import { broadcastMsg } from "@iracedeck/iracing-native";

import { getLogger, Logger } from "../logger.js";
import { BroadcastMsg } from "./constants.js";

/**
 * Base class for iRacing broadcast commands
 */
export abstract class BroadcastCommand {
  protected logger: Logger;

  protected constructor(loggerScope: string) {
    this.logger = getLogger().createScope(loggerScope);
  }

  /**
   * Send a raw broadcast message to iRacing
   * @param msg Broadcast message type
   * @param var1 First parameter
   * @param var2 Second parameter
   * @param var3 Third parameter
   */
  protected sendBroadcast(msg: BroadcastMsg, var1: number = 0, var2: number = 0, var3: number = 0): boolean {
    this.logger.debug(`Sending: msg=${BroadcastMsg[msg]}, var1=${var1}, var2=${var2}, var3=${var3}`);
    broadcastMsg(msg, var1, var2, var3);

    return true; // broadcastMsg doesn't return status, assume success
  }
}
