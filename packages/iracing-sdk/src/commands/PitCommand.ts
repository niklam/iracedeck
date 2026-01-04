/**
 * PitCommand - Pit service commands for iRacing
 *
 * Note: Pit commands only work when the driver is in the car
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, PitCommandMode } from "./constants.js";

/**
 * Pit service commands
 */
export class PitCommand extends BroadcastCommand {
  private static _instance: PitCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): PitCommand {
    if (!PitCommand._instance) {
      PitCommand._instance = new PitCommand();
    }

    return PitCommand._instance;
  }

  /**
   * Clear all pit checkboxes
   */
  clear(): boolean {
    this.logger.info("Clear all");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.Clear);
  }

  /**
   * Request windshield tearoff
   */
  windshield(): boolean {
    this.logger.info("Windshield tearoff");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.WS);
  }

  /**
   * Clear windshield checkbox
   */
  clearWindshield(): boolean {
    this.logger.info("Clear windshield");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.ClearWS);
  }

  /**
   * Request fuel
   * @param liters Amount of fuel to add (0 = use existing amount)
   */
  fuel(liters: number = 0): boolean {
    this.logger.info(`Fuel: ${liters}L`);

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.Fuel, liters);
  }

  /**
   * Clear fuel checkbox
   */
  clearFuel(): boolean {
    this.logger.info("Clear fuel");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.ClearFuel);
  }

  /**
   * Request left front tire change
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  leftFront(pressureKpa: number = 0): boolean {
    this.logger.info(`Left front: ${pressureKpa}kPa`);

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.LF, pressureKpa);
  }

  /**
   * Request right front tire change
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  rightFront(pressureKpa: number = 0): boolean {
    this.logger.info(`Right front: ${pressureKpa}kPa`);

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.RF, pressureKpa);
  }

  /**
   * Request left rear tire change
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  leftRear(pressureKpa: number = 0): boolean {
    this.logger.info(`Left rear: ${pressureKpa}kPa`);

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.LR, pressureKpa);
  }

  /**
   * Request right rear tire change
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  rightRear(pressureKpa: number = 0): boolean {
    this.logger.info(`Right rear: ${pressureKpa}kPa`);

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.RR, pressureKpa);
  }

  /**
   * Clear tire pit checkboxes
   */
  clearTires(): boolean {
    this.logger.info("Clear tires");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.ClearTires);
  }

  /**
   * Request fast repair
   */
  fastRepair(): boolean {
    this.logger.info("Fast repair");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.FR);
  }

  /**
   * Clear fast repair checkbox
   */
  clearFastRepair(): boolean {
    this.logger.info("Clear fast repair");

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.ClearFR);
  }

  /**
   * Change tire compound
   * @param compound Tire compound index
   */
  tireCompound(compound: number): boolean {
    this.logger.info(`Tire compound: ${compound}`);

    return this.sendBroadcast(BroadcastMsg.PitCommand, PitCommandMode.TC, compound);
  }

  // ========== Convenience methods ==========

  /**
   * Request all four tires
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  allTires(pressureKpa: number = 0): boolean {
    const lf = this.leftFront(pressureKpa);
    const rf = this.rightFront(pressureKpa);
    const lr = this.leftRear(pressureKpa);
    const rr = this.rightRear(pressureKpa);

    return lf && rf && lr && rr;
  }

  /**
   * Request front tires only
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  frontTires(pressureKpa: number = 0): boolean {
    const lf = this.leftFront(pressureKpa);
    const rf = this.rightFront(pressureKpa);

    return lf && rf;
  }

  /**
   * Request rear tires only
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  rearTires(pressureKpa: number = 0): boolean {
    const lr = this.leftRear(pressureKpa);
    const rr = this.rightRear(pressureKpa);

    return lr && rr;
  }

  /**
   * Request left side tires only
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  leftTires(pressureKpa: number = 0): boolean {
    const lf = this.leftFront(pressureKpa);
    const lr = this.leftRear(pressureKpa);

    return lf && lr;
  }

  /**
   * Request right side tires only
   * @param pressureKpa Tire pressure in kPa (0 = use existing pressure)
   */
  rightTires(pressureKpa: number = 0): boolean {
    const rf = this.rightFront(pressureKpa);
    const rr = this.rightRear(pressureKpa);

    return rf && rr;
  }
}
