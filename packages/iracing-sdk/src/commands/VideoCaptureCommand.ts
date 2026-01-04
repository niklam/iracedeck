/**
 * VideoCaptureCommand - Video capture commands for iRacing
 */
import { BroadcastCommand } from "./BroadcastCommand.js";
import { BroadcastMsg, VideoCaptureMode } from "./constants.js";

/**
 * Video capture commands
 */
export class VideoCaptureCommand extends BroadcastCommand {
  private static _instance: VideoCaptureCommand;

  private constructor() {
    super();
  }

  /**
   * Get the singleton instance
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
    this.logger.info("Screenshot");

    return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.TriggerScreenShot);
  }

  /**
   * Start video capture
   */
  start(): boolean {
    this.logger.info("Start");

    return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.StartVideoCapture);
  }

  /**
   * Stop video capture
   */
  stop(): boolean {
    this.logger.info("Stop");

    return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.EndVideoCapture);
  }

  /**
   * Toggle video capture on/off
   */
  toggle(): boolean {
    this.logger.info("Toggle");

    return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.ToggleVideoCapture);
  }

  /**
   * Show video timer in upper left corner
   */
  showTimer(): boolean {
    this.logger.info("Show timer");

    return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.ShowVideoTimer);
  }

  /**
   * Hide video timer
   */
  hideTimer(): boolean {
    this.logger.info("Hide timer");

    return this.sendBroadcast(BroadcastMsg.VideoCapture, VideoCaptureMode.HideVideoTimer);
  }
}
