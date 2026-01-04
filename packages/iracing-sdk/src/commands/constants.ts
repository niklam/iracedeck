/**
 * iRacing Broadcast API Constants
 * Re-exports from @iracedeck/iracing-native for convenience
 *
 * Remote control the sim by sending these windows messages
 * - Camera and replay commands only work when you are out of your car
 * - Pit commands only work when in your car
 */

export {
  // Broadcast message constant
  IRSDK_BROADCASTMSGNAME as IRSDK_BROADCAST_MSG_NAME,

  // Broadcast enums
  BroadcastMsg,
  ChatCommandMode,
  PitCommandMode,
  TelemCommandMode,
  ReplayStateMode,
  ReloadTexturesMode,
  ReplaySearchMode,
  ReplayPosMode,
  FFBCommandMode,
  CameraFocusMode,
  VideoCaptureMode,
} from "@iracedeck/iracing-native";
