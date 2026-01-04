/**
 * ReplayCommand - Replay control commands for iRacing
 *
 * Note: Replay commands only work when you are out of your car (spectating/replay)
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, ReplayPosMode, ReplaySearchMode, ReplayStateMode } from "./constants.js";

/**
 * Replay control commands
 */
export class ReplayCommand extends BroadcastCommand {
  private static _instance: ReplayCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ReplayCommand {
    if (!ReplayCommand._instance) {
      ReplayCommand._instance = new ReplayCommand();
    }

    return ReplayCommand._instance;
  }

  /**
   * Set replay playback speed
   * @param speed Playback speed (negative for reverse)
   * @param slowMotion Enable slow motion mode
   */
  setPlaySpeed(speed: number, slowMotion: boolean = false): boolean {
    this.logger.info(`SetPlaySpeed: speed=${speed}, slowMotion=${slowMotion}`);

    return this.sendBroadcast(BroadcastMsg.ReplaySetPlaySpeed, speed, slowMotion ? 1 : 0);
  }

  /**
   * Set replay play position
   * @param mode Position mode (Begin, Current, End)
   * @param frameNumber Frame number (60 frames per second)
   */
  setPlayPosition(mode: ReplayPosMode, frameNumber: number): boolean {
    const frameHigh = (frameNumber >> 16) & 0xffff;
    const frameLow = frameNumber & 0xffff;
    this.logger.info(`SetPlayPosition: mode=${ReplayPosMode[mode]}, frame=${frameNumber}`);

    return this.sendBroadcast(BroadcastMsg.ReplaySetPlayPosition, mode, frameLow, frameHigh);
  }

  /**
   * Search replay for events
   * @param mode Search mode
   */
  search(mode: ReplaySearchMode): boolean {
    this.logger.info(`Search: mode=${ReplaySearchMode[mode]}`);

    return this.sendBroadcast(BroadcastMsg.ReplaySearch, mode);
  }

  /**
   * Set replay state
   * @param mode Replay state mode
   */
  setState(mode: ReplayStateMode): boolean {
    this.logger.info(`SetState: mode=${ReplayStateMode[mode]}`);

    return this.sendBroadcast(BroadcastMsg.ReplaySetState, mode);
  }

  /**
   * Search replay by session time
   * @param sessionNum Session number
   * @param sessionTimeMs Session time in milliseconds
   */
  searchSessionTime(sessionNum: number, sessionTimeMs: number): boolean {
    const timeHigh = (sessionTimeMs >> 16) & 0xffff;
    const timeLow = sessionTimeMs & 0xffff;
    this.logger.info(`SearchSessionTime: session=${sessionNum}, timeMs=${sessionTimeMs}`);

    return this.sendBroadcast(BroadcastMsg.ReplaySearchSessionTime, sessionNum, timeLow, timeHigh);
  }

  // ========== Convenience methods ==========

  /**
   * Play replay at normal speed
   */
  play(): boolean {
    return this.setPlaySpeed(1);
  }

  /**
   * Pause replay
   */
  pause(): boolean {
    return this.setPlaySpeed(0);
  }

  /**
   * Fast forward at 2x speed
   */
  fastForward(): boolean {
    return this.setPlaySpeed(2);
  }

  /**
   * Fast forward at specified speed
   * @param speed Playback speed multiplier
   */
  fastForwardAt(speed: number): boolean {
    return this.setPlaySpeed(speed);
  }

  /**
   * Rewind at 2x speed
   */
  rewind(): boolean {
    return this.setPlaySpeed(-2);
  }

  /**
   * Rewind at specified speed
   * @param speed Playback speed multiplier (positive number, will be negated)
   */
  rewindAt(speed: number): boolean {
    return this.setPlaySpeed(-Math.abs(speed));
  }

  /**
   * Play in slow motion
   */
  slowMotion(): boolean {
    return this.setPlaySpeed(1, true);
  }

  /**
   * Go to start of replay
   */
  goToStart(): boolean {
    return this.search(ReplaySearchMode.ToStart);
  }

  /**
   * Go to end of replay
   */
  goToEnd(): boolean {
    return this.search(ReplaySearchMode.ToEnd);
  }

  /**
   * Go to previous session
   */
  prevSession(): boolean {
    return this.search(ReplaySearchMode.PrevSession);
  }

  /**
   * Go to next session
   */
  nextSession(): boolean {
    return this.search(ReplaySearchMode.NextSession);
  }

  /**
   * Go to previous lap
   */
  prevLap(): boolean {
    return this.search(ReplaySearchMode.PrevLap);
  }

  /**
   * Go to next lap
   */
  nextLap(): boolean {
    return this.search(ReplaySearchMode.NextLap);
  }

  /**
   * Go to previous frame
   */
  prevFrame(): boolean {
    return this.search(ReplaySearchMode.PrevFrame);
  }

  /**
   * Go to next frame
   */
  nextFrame(): boolean {
    return this.search(ReplaySearchMode.NextFrame);
  }

  /**
   * Go to previous incident
   */
  prevIncident(): boolean {
    return this.search(ReplaySearchMode.PrevIncident);
  }

  /**
   * Go to next incident
   */
  nextIncident(): boolean {
    return this.search(ReplaySearchMode.NextIncident);
  }

  /**
   * Erase replay tape
   */
  eraseTape(): boolean {
    return this.setState(ReplayStateMode.EraseTape);
  }
}
