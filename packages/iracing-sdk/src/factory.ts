/**
 * Factory functions for creating SDK instances with wired dependencies
 *
 * These provide convenient creation of fully-configured SDK objects.
 * For testing, instantiate classes directly with mock dependencies.
 */
import { IRacingNative } from "@iracedeck/iracing-native";
import { ILogger, silentLogger } from "@iracedeck/logger";

import {
  CameraCommand,
  ChatCommand,
  FFBCommand,
  PitCommand,
  ReplayCommand,
  TelemCommand,
  TextureCommand,
  VideoCaptureCommand,
} from "./commands/index.js";
import type { INativeSDK } from "./interfaces.js";
import { IRacingSDK } from "./IRacingSDK.js";
import { SDKController } from "./SDKController.js";

/**
 * All command instances, pre-wired with the native SDK
 */
export interface Commands {
  camera: CameraCommand;
  chat: ChatCommand;
  ffb: FFBCommand;
  pit: PitCommand;
  replay: ReplayCommand;
  telem: TelemCommand;
  texture: TextureCommand;
  videoCapture: VideoCaptureCommand;
}

/**
 * Complete SDK bundle with all components wired together
 */
export interface SDKBundle {
  sdk: IRacingSDK;
  controller: SDKController;
  commands: Commands;
}

/**
 * Hooks the host may inject into the commands (issue #977).
 */
export interface SDKFactoryOptions {
  /**
   * Runs synchronously immediately before a command types keystrokes into
   * iRacing — today that is `ChatCommand.sendMessage` alone. deck-core passes
   * its focus-before-input function here; this package cannot import it.
   */
  beforeKeystrokes?: () => void;
}

/**
 * Create command instances with shared native SDK and scoped loggers
 *
 * @param native Native SDK shared by every command
 * @param logger Optional logger (defaults to silentLogger)
 * @param options Optional host-injected hooks (see {@link SDKFactoryOptions})
 */
export function createCommands(
  native: INativeSDK,
  logger: ILogger = silentLogger,
  options: SDKFactoryOptions = {},
): Commands {
  return {
    camera: new CameraCommand(native, logger.createScope("CameraCommand")),
    chat: new ChatCommand(native, logger.createScope("ChatCommand"), options.beforeKeystrokes),
    ffb: new FFBCommand(native, logger.createScope("FFBCommand")),
    pit: new PitCommand(native, logger.createScope("PitCommand")),
    replay: new ReplayCommand(native, logger.createScope("ReplayCommand")),
    telem: new TelemCommand(native, logger.createScope("TelemCommand")),
    texture: new TextureCommand(native, logger.createScope("TextureCommand")),
    videoCapture: new VideoCaptureCommand(native, logger.createScope("VideoCaptureCommand")),
  };
}

/**
 * Create a complete SDK bundle with all components wired together
 *
 * @param logger Optional logger (defaults to silentLogger)
 * @param options Optional host-injected hooks (see {@link SDKFactoryOptions})
 * @returns SDKBundle with sdk, controller, and all commands
 *
 * @example
 * // Basic usage
 * const { sdk, controller, commands } = createSDK();
 * controller.subscribe("myAction", (telemetry, connected) => { ... });
 * commands.pit.fuel(50);
 *
 * @example
 * // With logging
 * const { sdk, controller, commands } = createSDK(myLogger);
 */
export function createSDK(logger: ILogger = silentLogger, options: SDKFactoryOptions = {}): SDKBundle {
  const native = new IRacingNative();
  const sdk = new IRacingSDK(native, logger.createScope("IRacingSDK"));
  const controller = new SDKController(sdk, logger.createScope("SDKController"));
  const commands = createCommands(native, logger, options);

  return { sdk, controller, commands };
}
