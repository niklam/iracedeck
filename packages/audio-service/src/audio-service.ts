/**
 * Audio Service Singleton — Multi-Channel Mixer (miniaudio)
 *
 * Provides a multi-channel audio mixer via the miniaudio native engine.
 * Four independent channels can play simultaneously:
 *   Channel 0 (Ambient) — pit lane background noise loop
 *   Channel 1 (SFX)     — walkie-talkie open/close ticks
 *   Channel 2 (Voice)   — engineer messages, reminders, toggles
 *   Channel 3 (Spotter) — directional spotter ticks
 *
 * Also provides a voice sequence engine that chains audio clips with
 * random connector words ("and", "also", "plus") between them.
 *
 * Usage:
 * 1. Call initializeAudio() once at plugin startup with an AudioNative instance
 * 2. Call getAudio().init() to start the engine
 * 3. Use getAudio() in actions to play sounds on channels
 *
 * @example
 * import { AudioNative } from "@iracedeck/audio-native";
 * import { initializeAudio, getAudio } from "@iracedeck/audio-service";
 * const native = new AudioNative();
 * initializeAudio(logger, native);
 * getAudio().init();
 */
import type { AudioNative } from "@iracedeck/audio-native";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

// ─── Channel enum ────────────────────────────────────────────────────────────

export enum AudioChannel {
  Ambient = 0,
  SFX = 1,
  Voice = 2,
  Spotter = 3,
}

// ─── Bus system ──────────────────────────────────────────────────────────────

/**
 * Logical audio groups (busses). Channels are routed to exactly one bus.
 * Bus volume multiplies each channel's intrinsic mix ratio, so a single
 * `setBusVolume(Background, 0.2)` ducks both Ambient and SFX in one call
 * while preserving their relative balance.
 *
 * The native engine is unaware of busses — routing is computed at the JS
 * layer and pushed down as per-channel volumes.
 */
export enum AudioBus {
  /** Engineer voice (spoken messages, acks, greetings). */
  Voice = 0,
  /** Pit/track ambient loops + walkie ticks and non-voice SFX. */
  Background = 1,
  /** Directional spotter calls; independent from engineer audio. */
  Alerts = 2,
}

/**
 * Default channel routing. Edit here to re-route channels between busses.
 * The mix ratio is the channel's volume at bus = 1.0 (e.g. SFX and Ambient
 * are pre-attenuated so they sit under the voice when the bus is at full).
 */
const CHANNEL_BUS_MAP: Readonly<Record<AudioChannel, AudioBus>> = {
  [AudioChannel.Ambient]: AudioBus.Background,
  [AudioChannel.SFX]: AudioBus.Background,
  [AudioChannel.Voice]: AudioBus.Voice,
  [AudioChannel.Spotter]: AudioBus.Alerts,
};

const CHANNEL_MIX_RATIO: Readonly<Record<AudioChannel, number>> = {
  [AudioChannel.Ambient]: 0.8,
  [AudioChannel.SFX]: 0.7,
  [AudioChannel.Voice]: 1.0,
  [AudioChannel.Spotter]: 1.0,
};

// ─── Voice sequence state ────────────────────────────────────────────────────

enum VoiceSeqState {
  Idle,
  PlayingMessage,
  PlayingConnector,
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface IAudioService {
  /** Initialize the audio engine. Call once after initializeAudio(). */
  init(): boolean;

  /** Destroy the audio engine. Call on shutdown. */
  destroy(): void;

  /** Play an audio file on a specific channel. Returns true on success. */
  playOnChannel(channel: AudioChannel, filePath: string, loop?: boolean): boolean;

  /** Stop playback on a specific channel. */
  stopChannel(channel: AudioChannel): void;

  /** Stop all channels. */
  stopAllChannels(): void;

  /** Set per-channel volume (0.0–1.0). Bypasses the bus — for one-off nudges. */
  setChannelVolume(channel: AudioChannel, volume: number): void;

  /**
   * Set a bus's master volume (0.0–1.0). Re-applies to every channel in the
   * bus using that channel's intrinsic mix ratio. This is the preferred API
   * for volume sliders and ducking (e.g. lowering Background while Voice plays).
   */
  setBusVolume(bus: AudioBus, volume: number): void;

  /** Get a bus's current master volume. */
  getBusVolume(bus: AudioBus): number;

  /** Check if a channel is currently playing. */
  isChannelPlaying(channel: AudioChannel): boolean;

  /**
   * Register a one-shot completion callback for a channel.
   * Fires when the current sound on that channel finishes.
   * Overwrites any previous callback on that channel.
   */
  onChannelComplete(channel: AudioChannel, callback: () => void): void;

  /**
   * Play a sequence of audio files on the Voice channel with random
   * connector words inserted between them.
   *
   * @param files - Array of absolute file paths for the message clips
   * @param connectorPool - Optional array of absolute paths to connector clips
   */
  playVoiceSequence(files: string[], connectorPool?: string[]): void;

  /** Cancel any active voice sequence. */
  cancelVoiceSequence(): void;

  /**
   * Register a callback that fires when a voice sequence completes
   * (all messages + connectors have finished playing).
   */
  onVoiceSequenceComplete(callback: () => void): void;

  /** Seek a channel to a random position (for ambient variation between radio flows). */
  seekChannelRandom(channel: AudioChannel): void;

  /** Get list of available audio output devices. */
  getAudioDevices(): Array<{ index: number; name: string; isDefault: boolean }>;

  /** Switch to a specific audio output device. -1 for system default. Returns true on success. */
  setAudioDevice(deviceIndex: number): boolean;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class AudioService implements IAudioService {
  private logger: ILogger;
  private native: AudioNative;
  private engineReady = false;

  // Voice sequence state
  private voiceSeqState = VoiceSeqState.Idle;
  private voiceSeqFiles: string[] = [];
  private voiceSeqConnectors: string[] = [];
  private voiceSeqIndex = 0;
  private voiceSeqLastConnector = "";
  private voiceSeqCompleteCallback: (() => void) | null = null;

  // Per-channel volume state (persists across sound changes on the same channel)
  private channelVolumes: number[] = [1.0, 1.0, 1.0, 1.0];

  // Per-bus master volume (applied on top of each channel's intrinsic mix ratio)
  private busVolumes: number[] = [1.0, 1.0, 1.0];

  // Per-channel one-shot callbacks (managed at JS level, wrapping the native TSFN)
  private channelCallbacks: ((() => void) | null)[] = [null, null, null, null];

  constructor(logger: ILogger, native: AudioNative) {
    this.logger = logger;
    this.native = native;

    // Register persistent native end callbacks for all channels.
    // These dispatch to the JS-level one-shot callbacks.
    for (let ch = 0; ch < 4; ch++) {
      const channel = ch;
      this.native.setChannelEndCallback(channel, () => {
        this.handleChannelEnd(channel);
      });
    }
  }

  // ── Engine lifecycle ──

  init(): boolean {
    if (this.engineReady) return true;

    const ok = this.native.initAudioEngine();

    if (ok) {
      this.engineReady = true;
      this.logger.info("Audio engine initialized (miniaudio)");
    } else {
      this.logger.error("Failed to initialize audio engine");
    }

    return ok;
  }

  destroy(): void {
    this.cancelVoiceSequence();
    this.native.destroyAudioEngine();
    this.engineReady = false;
    this.logger.info("Audio engine destroyed");
  }

  // ── Channel operations ──

  playOnChannel(channel: AudioChannel, filePath: string, loop = false): boolean {
    if (!this.engineReady) return false;

    this.logger.debug(`Play ch${channel}: ${filePath}${loop ? " (loop)" : ""}`);

    return this.native.playOnChannel(channel, filePath, loop, this.channelVolumes[channel]);
  }

  stopChannel(channel: AudioChannel): void {
    this.native.stopChannel(channel);
    this.channelCallbacks[channel] = null;
  }

  stopAllChannels(): void {
    this.cancelVoiceSequence();
    this.native.stopAllChannels();

    for (let i = 0; i < 4; i++) this.channelCallbacks[i] = null;
  }

  setChannelVolume(channel: AudioChannel, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.channelVolumes[channel] = clamped;
    this.native.setChannelVolume(channel, clamped);
  }

  setBusVolume(bus: AudioBus, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.busVolumes[bus] = clamped;

    // Recompute effective channel volumes for every channel routed to this bus
    for (const channelStr of Object.keys(CHANNEL_BUS_MAP)) {
      const channel = Number(channelStr) as AudioChannel;

      if (CHANNEL_BUS_MAP[channel] !== bus) continue;

      const effective = clamped * CHANNEL_MIX_RATIO[channel];
      this.channelVolumes[channel] = effective;
      this.native.setChannelVolume(channel, effective);
    }
  }

  getBusVolume(bus: AudioBus): number {
    return this.busVolumes[bus];
  }

  isChannelPlaying(channel: AudioChannel): boolean {
    return this.native.isChannelPlaying(channel);
  }

  onChannelComplete(channel: AudioChannel, callback: () => void): void {
    this.channelCallbacks[channel] = callback;
  }

  // ── Voice sequence engine ──

  playVoiceSequence(files: string[], connectorPool?: string[]): void {
    if (files.length === 0) return;

    // Reset internal state without clearing the completion callback
    this.voiceSeqState = VoiceSeqState.Idle;

    this.voiceSeqFiles = files;
    this.voiceSeqConnectors = connectorPool ?? [];
    this.voiceSeqIndex = 0;
    this.voiceSeqLastConnector = "";

    this.logger.info("Voice sequence started");
    this.logger.debug(`Files: ${files.length}, connectors: ${this.voiceSeqConnectors.length}`);

    this.playNextMessage();
  }

  cancelVoiceSequence(): void {
    if (this.voiceSeqState !== VoiceSeqState.Idle) {
      this.logger.debug("Voice sequence cancelled");
    }

    this.voiceSeqState = VoiceSeqState.Idle;
    this.voiceSeqFiles = [];
    this.voiceSeqConnectors = [];
    this.voiceSeqIndex = 0;
    this.voiceSeqCompleteCallback = null;
    // Don't stop the Voice channel here — caller decides
  }

  onVoiceSequenceComplete(callback: () => void): void {
    this.voiceSeqCompleteCallback = callback;
  }

  // ── Device selection ──

  seekChannelRandom(channel: AudioChannel): void {
    this.native.seekChannelRandom(channel);
  }

  getAudioDevices(): Array<{ index: number; name: string; isDefault: boolean }> {
    return this.native.getAudioDevices();
  }

  setAudioDevice(deviceIndex: number): boolean {
    // Stop all active playback before switching
    this.cancelVoiceSequence();
    this.native.stopAllChannels();

    for (let i = 0; i < 4; i++) this.channelCallbacks[i] = null;

    const ok = this.native.setAudioDevice(deviceIndex);

    if (ok) {
      this.logger.info(`Audio output device switched to index ${deviceIndex}`);
    } else {
      this.logger.error(`Failed to switch audio output device to index ${deviceIndex}`);
    }

    return ok;
  }

  // ── Internal ──

  private handleChannelEnd(channel: number): void {
    // Voice channel has special handling for sequence engine
    if (channel === AudioChannel.Voice) {
      this.handleVoiceEnd();
    }

    // Fire and clear the one-shot callback
    const cb = this.channelCallbacks[channel];

    if (cb) {
      this.channelCallbacks[channel] = null;
      cb();
    }
  }

  private handleVoiceEnd(): void {
    if (this.voiceSeqState === VoiceSeqState.Idle) return;

    if (this.voiceSeqState === VoiceSeqState.PlayingConnector) {
      // Connector just finished → play next message
      this.voiceSeqState = VoiceSeqState.PlayingMessage;
      this.playCurrentMessage();

      return;
    }

    // Message just finished
    this.voiceSeqIndex++;

    if (this.voiceSeqIndex >= this.voiceSeqFiles.length) {
      // All messages played — sequence complete
      this.logger.debug("Voice sequence complete");
      this.voiceSeqState = VoiceSeqState.Idle;
      const cb = this.voiceSeqCompleteCallback;
      this.voiceSeqCompleteCallback = null;

      if (cb) cb();

      return;
    }

    // More messages to play — insert connector if available
    if (this.voiceSeqConnectors.length > 0) {
      const connector = this.pickConnector();
      this.voiceSeqState = VoiceSeqState.PlayingConnector;
      this.logger.debug(`Playing connector: ${connector}`);
      this.native.playOnChannel(AudioChannel.Voice, connector, false, this.channelVolumes[AudioChannel.Voice]);
    } else {
      // No connectors — play next message directly
      this.playCurrentMessage();
    }
  }

  private playNextMessage(): void {
    this.voiceSeqState = VoiceSeqState.PlayingMessage;
    this.playCurrentMessage();
  }

  private playCurrentMessage(): void {
    const file = this.voiceSeqFiles[this.voiceSeqIndex];
    this.logger.debug(`Playing message ${this.voiceSeqIndex + 1}/${this.voiceSeqFiles.length}: ${file}`);
    this.native.playOnChannel(AudioChannel.Voice, file, false, this.channelVolumes[AudioChannel.Voice]);
  }

  private pickConnector(): string {
    const pool = this.voiceSeqConnectors;

    if (pool.length === 0) return "";

    if (pool.length === 1) return pool[0];

    // Pick randomly, excluding last-used connector
    const candidates = pool.filter((c) => c !== this.voiceSeqLastConnector);
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    this.voiceSeqLastConnector = pick;

    return pick;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let audioService: AudioService | null = null;

/**
 * Initialize the audio service singleton with an AudioNative instance.
 * Call once at plugin startup, then call getAudio().init() to start the engine.
 */
export function initializeAudio(logger: ILogger = silentLogger, native: AudioNative): IAudioService {
  if (audioService) {
    throw new Error("Audio service already initialized. initializeAudio() should only be called once.");
  }

  audioService = new AudioService(logger, native);
  logger.info("Audio service initialized");

  return audioService;
}

/**
 * Get the audio service for playing sounds.
 */
export function getAudio(): IAudioService {
  if (!audioService) {
    throw new Error("Audio service not initialized. Call initializeAudio() first in your plugin entry point.");
  }

  return audioService;
}

/**
 * Check if the audio service has been initialized.
 */
export function isAudioInitialized(): boolean {
  return audioService !== null;
}

/**
 * Reset the audio service singleton (for testing purposes only).
 * @internal
 */
export function _resetAudio(): void {
  audioService = null;
}
