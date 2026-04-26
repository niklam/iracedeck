/**
 * @iracedeck/audio-service
 *
 * Multi-channel audio mixer singleton layered over `@iracedeck/audio-native`.
 * Provides bus routing, a voice-sequence engine, and device selection on top
 * of the raw miniaudio bindings.
 */
export {
  _resetAudio,
  AudioBus,
  AudioChannel,
  getAudio,
  type IAudioService,
  initializeAudio,
  isAudioInitialized,
  type PlaybackObserver,
} from "./audio-service.js";
