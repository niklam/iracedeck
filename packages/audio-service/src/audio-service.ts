/**
 * Audio Service Singleton — Multi-Channel Mixer (miniaudio)
 *
 * Provides a multi-channel audio mixer via the miniaudio native engine.
 * Four independent channels can play simultaneously:
 *   Channel 0 (Ambient) — pit lane background noise loop
 *   Channel 1 (SFX)     — walkie-talkie open/close ticks
 *   Channel 2 (Voice)   — engineer messages, reminders, toggles
 *   Channel 3 (Radar) — directional radar ticks
 *
 * Also provides a voice sequence engine that chains audio clips with
 * random connector words ("and", "also", "plus") between them.
 *
 * Usage:
 * 1. Call initializeAudio() once at plugin startup with an AudioNative instance
 * 2. Call getAudio().init() to set up the audio subsystem (the OS audio
 *    device only exists while something plays — created on demand and
 *    released after an idle window, since even an idle stream makes
 *    Windows block PC sleep, issue #849)
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
import { existsSync } from "node:fs";
import path from "node:path";

// ─── Channel enum ────────────────────────────────────────────────────────────

export enum AudioChannel {
  Ambient = 0,
  SFX = 1,
  Voice = 2,
  Radar = 3,
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
  /** Directional radar calls; independent from engineer audio. */
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
  [AudioChannel.Radar]: AudioBus.Alerts,
};

const CHANNEL_MIX_RATIO: Readonly<Record<AudioChannel, number>> = {
  [AudioChannel.Ambient]: 0.8,
  [AudioChannel.SFX]: 0.7,
  [AudioChannel.Voice]: 1.0,
  [AudioChannel.Radar]: 1.0,
};

// ─── Perceptual volume curve (#531) ──────────────────────────────────────────

/**
 * Power exponent for the perceptual volume curve. miniaudio's
 * `ma_sound_set_volume` interprets its argument as a linear amplitude factor,
 * but human loudness perception is roughly logarithmic — at exponent 1 the
 * upper half of a 0–1 slider only spans ~6 dB and feels "the same" to the
 * ear. An exponent of 2.5 spreads the audible range across the whole slider
 * (slider 50 → 0.18 amp ≈ −15 dB, 75 → 0.49 ≈ −6 dB, 100 → 1.0 = 0 dB).
 *
 * Applied at the public volume setters so every caller (sliders, ducking,
 * voice/radar bus writes) gets perceptual scaling for free. `CHANNEL_MIX_RATIO`
 * stays in linear amplitude — those constants are internal balance, not a
 * user-facing control.
 */
const PERCEPTUAL_EXPONENT = 2.5;

// ─── Idle device stop (#849) ─────────────────────────────────────────────────

/**
 * How long every channel must stay idle before the playback device is
 * released. A WASAPI stream makes Windows hold a SYSTEM power request
 * that blocks PC sleep even while the stream is merely initialized, not
 * running — so the device only exists around actual playback. The delay
 * debounces clip chaining (voice-sequence connectors, radar tick trains,
 * the pit-box count-in's ~1 s gaps) so a burst of related clips doesn't
 * churn the device between them.
 *
 * @internal Exported for testing
 */
export const IDLE_STOP_DELAY_MS = 5000;

function toPerceivedAmplitude(linear: number): number {
  return Math.pow(linear, PERCEPTUAL_EXPONENT);
}

/**
 * Clamp a user-facing volume to [0, 1], coercing non-finite inputs (`NaN`,
 * `±Infinity`) to 0. Defends the curve and the native layer from a malformed
 * caller — `Math.max(0, Math.min(1, NaN))` is `NaN`, which would propagate
 * through `Math.pow` to `ma_sound_set_volume` with undefined results.
 */
function clampVolume01(volume: number): number {
  if (!Number.isFinite(volume)) return 0;

  return Math.max(0, Math.min(1, volume));
}

// ─── Voice sequence state ────────────────────────────────────────────────────

enum VoiceSeqState {
  Idle,
  PlayingMessage,
  PlayingConnector,
}

// ─── Playback observer ───────────────────────────────────────────────────────

/**
 * Persistent observer for playback start/complete events across all channels.
 *
 * Distinct from {@link IAudioService.onChannelComplete}: that API is a
 * one-shot per-channel callback used internally by callers that need to
 * chain plays. The observer here is a single non-mutating subscription
 * intended for monitoring (logging, telemetry, dev-tool live readouts) —
 * it fires for every clip on every channel and never gets cleared by the
 * audio engine.
 *
 * Both callbacks are optional so observers can subscribe to just starts or
 * just completions without nullable shims at the call site.
 */
export interface PlaybackObserver {
  /**
   * Fired after the native engine has accepted a play call. `filePath` is
   * the absolute filesystem path the native layer received (after base-
   * path resolution), so observers can correlate with the source clip.
   */
  onStart?(channel: AudioChannel, filePath: string): void;
  /** Fired when a clip finishes playing on the given channel. */
  onComplete?(channel: AudioChannel): void;
}

/**
 * One directory a manifest-relative clip path may resolve against (issue #1034).
 *
 * `clips` is what makes a root's contribution AUTHORISED rather than merely
 * present. A voice pack is a folder somebody else assembled, and the scanner
 * already decides which of its files it is willing to serve — everything under
 * a voice the pack actually owns, and nothing else. Without that list here, the
 * resolver would fall back to "first root that HAS the file", and a pack could
 * serve a clip belonging to another pack, or a bundled clip the plugin happens
 * not to ship, simply by placing a file at the right relative path. It would
 * never appear in the settings list or the collision problems, because the
 * scanner drops those files rather than reporting them.
 *
 * Omit `clips` for an UNRESTRICTED root: only the plugin's own `assets/audio`,
 * whose contents are the bundle itself and are not third-party.
 */
export type AudioRoot = {
  /** Absolute directory. */
  dir: string;
  /** POSIX paths relative to {@link dir}; omit to allow anything inside it. */
  clips?: readonly string[];
};

/** A bare string is an unrestricted root — shorthand for `{ dir }`. */
export type AudioRootInput = string | AudioRoot;

// ─── Public interface ────────────────────────────────────────────────────────

export interface IAudioService {
  /**
   * Initialize the audio engine. Call once after initializeAudio(). No
   * OS audio device exists until the first play (#849).
   */
  init(): boolean;

  /** Destroy the audio engine. Call on shutdown. */
  destroy(): void;

  /** Play an audio file on a specific channel. Returns true on success. */
  playOnChannel(channel: AudioChannel, filePath: string, loop?: boolean): boolean;

  /**
   * Replace the ordered list of audio roots. Called after a voice-pack scan:
   * each installed pack is its own root (issue #1034), so the list grows and
   * shrinks as packs are installed and removed. A pack root carries the clip
   * list the scanner admitted from it — see {@link AudioRoot}.
   */
  setRoots(roots: readonly AudioRootInput[]): void;

  /** @internal Test seam for the file-existence probe; production uses `existsSync`. */
  setFileProbe(probe: (absolutePath: string) => boolean): void;

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
  getAudioDevices(): Array<{ index: number; name: string; id: string; isDefault: boolean }>;

  /** Switch to a specific audio output device. -1 for system default. Returns true on success. */
  setAudioDevice(deviceIndex: number): boolean;

  /**
   * Switch to a device looked up by its stable `id` from
   * {@link getAudioDevices}. Use this for any persisted selection — `id`
   * survives device-list reordering, replug, and OS audio reconfiguration.
   * Returns false if the id isn't in the current enumeration.
   */
  setAudioDeviceById(deviceId: string): boolean;

  /**
   * Register (or clear, with `null`) a persistent observer that fires
   * every time a clip starts or finishes on any channel. There is one
   * observer at a time — the harness and any other monitor share. Pass
   * `null` to remove the current observer.
   */
  setPlaybackObserver(observer: PlaybackObserver | null): void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/** A root with its clip allow-list resolved once, at `setRoots` time. */
type NormalizedRoot = {
  dir: string;
  /** `null` means unrestricted — the plugin's own bundled assets. */
  clips: ReadonlySet<string> | null;
};

/**
 * Clip paths are POSIX in the manifest and in a pack's scanned list, but a
 * caller could hand us a Windows-separated one. Compare on one spelling so an
 * allow-list lookup can never miss for a separator.
 */
function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeRoots(roots: readonly AudioRootInput[]): NormalizedRoot[] {
  return roots.map((root) =>
    typeof root === "string"
      ? { dir: root, clips: null }
      : { dir: root.dir, clips: root.clips === undefined ? null : new Set(root.clips.map(toPosix)) },
  );
}

class AudioService implements IAudioService {
  private logger: ILogger;
  private native: AudioNative;
  private roots: readonly NormalizedRoot[];
  /** Memo of logical path -> resolved absolute path. Successful probes only. */
  private readonly resolvedCache = new Map<string, string>();
  private fileProbe: (absolutePath: string) => boolean = (absolutePath) => existsSync(absolutePath);
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

  // Per-channel "is something currently playing on this channel" tracker. Set
  // when a play call succeeds, cleared on any teardown path (natural end,
  // manual stop, voice-sequence end). Gates `notifyPlaybackEnd` so we don't
  // emit synthetic completions on already-idle channels and don't double-fire
  // when the native engine echoes an end callback after a manual stop.
  private channelActive: boolean[] = [false, false, false, false];

  // Persistent observer for clip start/complete on any channel.
  private playbackObserver: PlaybackObserver | null = null;

  // Playback-device run state (#849). The device only exists around
  // actual playback; once released, the OS holds no audio stream and the
  // PC can sleep. `deviceRunning` tracks what we asked the native layer
  // to do; `idleStopTimer` is the pending debounced release.
  private deviceRunning = false;
  private idleStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(logger: ILogger, native: AudioNative, roots: readonly AudioRootInput[]) {
    this.logger = logger;
    this.native = native;
    this.roots = normalizeRoots(roots);

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
    // Drain active channels through the public path so observers see each
    // channel transition to idle before the native engine goes away.
    // `stopAllChannels` calls `cancelVoiceSequence` and clears
    // `channelActive` per channel — the explicit `fill(false)` is a belt-
    // and-suspenders reset for any future code path that bypasses
    // `stopAllChannels`.
    if (this.engineReady) this.stopAllChannels();

    this.cancelVoiceSequence();
    this.channelActive.fill(false);
    this.cancelIdleStop();
    this.deviceRunning = false;
    this.native.destroyAudioEngine();
    this.engineReady = false;
    this.logger.info("Audio engine destroyed");
  }

  // ── Channel operations ──

  playOnChannel(channel: AudioChannel, filePath: string, loop = false): boolean {
    if (!this.engineReady) return false;

    const resolved = this.resolvePath(filePath);
    this.logger.debug(`Play ch${channel}: ${resolved}${loop ? " (loop)" : ""}`);

    const ok = this.native.playOnChannel(channel, resolved, loop, this.channelVolumes[channel]);

    if (!ok) return false;

    // False when the playback device failed to start — the queued sound
    // has been unloaded and the play did not actually happen.
    return this.notifyPlaybackStart(channel, resolved);
  }

  /**
   * Resolve a clip path against the service's configured base path. Absolute
   * paths pass through unchanged, so callers that build their own absolute
   * paths (e.g. the radar engine) still work. Callers passing manifest-
   * relative paths (e.g. the scenario interpreter emitting
   * `sfx/IRD-tick-open.mp3`) are resolved against the ordered root list so the
   * native layer receives a filesystem path it can actually open.
   *
   * With more than one root (issue #1034 — each installed voice pack is its own
   * root) containment alone cannot choose between them, because a relative path
   * is "inside" every root. A root is therefore consulted only for the clips it
   * is AUTHORISED to serve: a pack root carries the list the scanner admitted
   * from it, and only the plugin's own assets directory is unrestricted.
   *
   * File presence alone would not do, and that is the whole point of the
   * allow-list. The scanner already refuses a pack's claim on a voice another
   * pack or the bundle owns — but it enforces that by dropping those files from
   * the pack's clip list, not by removing them from disk. A pack that simply
   * PLACES a file at `voice/<someone-else>/…` would otherwise win resolution
   * whenever it sorted earlier, silently substituting another pack's audio, or a
   * bundled clip the plugin happens not to ship — and it would appear in no
   * settings row and no collision problem, because the scanner dropped it.
   *
   * When no root is both authorised and holds the file, we return the first
   * authorised root's resolution rather than throwing: the native layer then
   * fails to open it exactly as it did before packs existed, so a missing clip
   * stays one behaviour rather than two.
   *
   * Only successful probes are memoised, so a clip that appears later — a pack
   * installed mid-session — is found on its next play with no invalidation.
   *
   * Rejects paths that escape every root via `..` segments. Because pack roots
   * are siblings under one parent, containment alone would let `../<other>/…`
   * pop out of one pack and back into another; the allow-list is what actually
   * refuses that, since no such path is in any pack's scanned clip list. The
   * scenario DSL only emits manifest slugs, so a rejection means a scenario
   * author or a malformed manifest tried to reach outside the audio directories
   * entirely — a bug worth failing loud on.
   */
  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;

    if (this.roots.length === 0) return filePath;

    const cached = this.resolvedCache.get(filePath);

    if (cached !== undefined) return cached;

    const logical = toPosix(filePath);
    let firstResolved: string | null = null;

    for (const root of this.roots) {
      if (root.clips !== null && !root.clips.has(logical)) continue;

      const base = path.resolve(root.dir);
      const resolved = path.resolve(base, filePath);
      const rel = path.relative(base, resolved);

      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;

      if (firstResolved === null) firstResolved = resolved;

      if (this.fileProbe(resolved)) {
        this.resolvedCache.set(filePath, resolved);

        return resolved;
      }
    }

    if (firstResolved === null) {
      throw new Error(`Audio clip path escapes every audio root: ${filePath}`);
    }

    return firstResolved;
  }

  setRoots(roots: readonly AudioRootInput[]): void {
    this.roots = normalizeRoots(roots);
    // A path that resolved to the fallback before a pack arrived must be
    // re-probed, so the memo cannot survive a root change.
    this.resolvedCache.clear();
    this.logger.debug(`Audio roots: ${this.roots.map((root) => root.dir).join(", ") || "(none)"}`);
  }

  setFileProbe(probe: (absolutePath: string) => boolean): void {
    this.fileProbe = probe;
    this.resolvedCache.clear();
  }

  stopChannel(channel: AudioChannel): void {
    // Stopping the Voice channel mid-sequence must reset the voice-
    // sequence state machine. Otherwise a deferred native end callback
    // can hit `handleVoiceEnd` and schedule the next connector or message
    // even though the caller asked us to stop. `stopAllChannels` already
    // does this; this is the same defence for the per-channel API.
    if (channel === AudioChannel.Voice) this.cancelVoiceSequence();

    this.native.stopChannel(channel);
    this.channelCallbacks[channel] = null;

    // Manual stop: native engine doesn't fire its end callback, so notify
    // observers explicitly. Looping channels (Ambient) would otherwise stay
    // "active" forever in any monitor that tracks start/complete. Gated on
    // `channelActive` so already-idle channels don't emit synthetic
    // completions, and a deferred native end callback after a manual stop
    // doesn't double-fire (handleChannelEnd checks the same flag).
    if (this.channelActive[channel]) {
      this.channelActive[channel] = false;
      this.notifyPlaybackEnd(channel);
    }
  }

  stopAllChannels(): void {
    this.cancelVoiceSequence();
    this.native.stopAllChannels();

    for (let i = 0; i < 4; i++) {
      this.channelCallbacks[i] = null;

      if (this.channelActive[i]) {
        this.channelActive[i] = false;
        this.notifyPlaybackEnd(i as AudioChannel);
      }
    }
  }

  setChannelVolume(channel: AudioChannel, volume: number): void {
    // Clamp before the curve — `Math.pow(negative, fractional)` would be NaN
    // for non-integer exponents; clamping first also means an over-1 input
    // still resolves to 1.0 (curve(1) = 1). `clampVolume01` also coerces
    // non-finite inputs (NaN, ±Infinity) to 0 so they can't reach the engine.
    const clamped = clampVolume01(volume);
    const perceived = toPerceivedAmplitude(clamped);
    this.channelVolumes[channel] = perceived;
    this.native.setChannelVolume(channel, perceived);
  }

  setBusVolume(bus: AudioBus, volume: number): void {
    const clamped = clampVolume01(volume);
    // Store the user-facing linear value so `getBusVolume` reflects what the
    // slider was set to, not the curved internal amplitude.
    this.busVolumes[bus] = clamped;

    const perceived = toPerceivedAmplitude(clamped);

    // Recompute effective channel volumes for every channel routed to this
    // bus. Mix ratio stays linear — it's pre-tuned channel balance, not a
    // user-facing control.
    for (const channelStr of Object.keys(CHANNEL_BUS_MAP)) {
      const channel = Number(channelStr) as AudioChannel;

      if (CHANNEL_BUS_MAP[channel] !== bus) continue;

      const effective = perceived * CHANNEL_MIX_RATIO[channel];
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

  getAudioDevices(): Array<{ index: number; name: string; id: string; isDefault: boolean }> {
    return this.native.getAudioDevices();
  }

  setAudioDevice(deviceIndex: number): boolean {
    // Stop all active playback before switching. Use the public method so
    // observers see each channel transition to idle — bypassing this and
    // hitting `native.stopAllChannels()` directly would leave looping
    // channels (Ambient) showing as "active" forever in any monitor.
    this.stopAllChannels();

    const ok = this.native.setAudioDevice(deviceIndex);

    // The native switch tears the engine down itself, but the "already on
    // this device" fast path keeps the old engine as-is — release
    // explicitly so a switch never leaves a device alive while idle
    // (#849). Nothing is playing (channels drained above), and the next
    // play recreates the device.
    this.cancelIdleStop();
    this.native.stopAudioEngine();
    this.deviceRunning = false;

    if (ok) {
      this.logger.info("Audio output device switched");
      this.logger.debug(`Device index: ${deviceIndex}`);
    } else {
      this.logger.error("Failed to switch audio output device");
      this.logger.debug(`Failed device index: ${deviceIndex}`);
    }

    return ok;
  }

  setAudioDeviceById(deviceId: string): boolean {
    // Stop all active playback before switching. Same reasoning as
    // `setAudioDevice` — go through the public method so observers see
    // every channel go idle.
    this.stopAllChannels();

    const ok = this.native.setAudioDeviceById(deviceId);

    // Same post-switch stop as `setAudioDevice` — see the comment there.
    this.cancelIdleStop();
    this.native.stopAudioEngine();
    this.deviceRunning = false;

    if (ok) {
      this.logger.info("Audio output device switched by id");
      this.logger.debug(`Device id: ${deviceId}`);
    } else {
      // The native layer returns false when the id is malformed or isn't
      // in the current enumeration (stale / unplugged / legacy value) —
      // the switch itself can't fail anymore, since it only records the
      // selection and the engine is recreated lazily at the next play
      // (#849). Caller decides how to recover (typically fall back to
      // system default).
      this.logger.warn("Audio output device id not found in current enumeration");
      this.logger.debug(`Device id: ${deviceId}`);
    }

    return ok;
  }

  setPlaybackObserver(observer: PlaybackObserver | null): void {
    this.playbackObserver = observer;
  }

  // ── Internal ──

  private handleChannelEnd(channel: number): void {
    // Notify "complete" BEFORE the voice-sequence engine schedules the next
    // clip. Otherwise the observer sees [start clip2, complete Voice] in
    // that order and any monitor flips the channel back to idle even
    // though the next clip is already playing (#448 audio activity bug).
    // Gated on `channelActive` so a deferred native end callback after a
    // manual stop doesn't double-fire.
    if (this.channelActive[channel]) {
      this.channelActive[channel] = false;
      this.notifyPlaybackEnd(channel as AudioChannel);
    }

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

  /**
   * Start the playback device if it isn't running, and cancel any pending
   * idle stop. Called from the playback-start chokepoint so every play
   * site keeps the device state in sync. A failed start is logged and
   * left for the next play to retry — `deviceRunning` stays false.
   *
   * @returns true when the device is running after the call
   */
  private ensureDeviceRunning(): boolean {
    this.cancelIdleStop();

    if (this.deviceRunning) return true;

    if (this.native.startAudioEngine()) {
      this.deviceRunning = true;
      this.logger.info("Audio device started");

      return true;
    }

    this.logger.error("Failed to start audio playback device");

    return false;
  }

  private cancelIdleStop(): void {
    if (this.idleStopTimer) {
      clearTimeout(this.idleStopTimer);
      this.idleStopTimer = null;
    }
  }

  /**
   * Arm the debounced device release once every channel is idle. The
   * timer re-checks at expiry — a clip that started meanwhile cancels it
   * via `ensureDeviceRunning`, and the guard covers any path that missed
   * the cancel. The native stop tears the whole engine down (an
   * initialized-but-stopped stream still blocks PC sleep, #849), which
   * also releases any loaded sounds — safe, because the release is only
   * armed when no channel is active.
   */
  private maybeScheduleIdleStop(): void {
    if (!this.deviceRunning) return;

    if (this.channelActive.some((active) => active)) return;

    this.cancelIdleStop();
    this.idleStopTimer = setTimeout(() => {
      this.idleStopTimer = null;

      if (!this.deviceRunning || this.channelActive.some((active) => active)) return;

      if (this.native.stopAudioEngine()) {
        this.deviceRunning = false;
        this.logger.info("Audio device stopped (idle)");
      } else {
        // The native stream may still be alive — keep `deviceRunning` set
        // and re-arm so the release is retried while idle, instead of
        // permanently leaving a sleep-blocking stream behind.
        this.logger.warn("Failed to stop idle audio playback device; retrying");
        this.maybeScheduleIdleStop();
      }
    }, IDLE_STOP_DELAY_MS);
  }

  /**
   * Single chokepoint for "a clip just started" — every play site
   * (including the voice-sequence engine paths that go through
   * `native.playOnChannel` directly) funnels through here, keeping the
   * device lifecycle and `channelActive` in sync with reality.
   *
   * The device is started BEFORE the channel is marked active or
   * observers are notified: when the start fails, the queued sound is
   * unloaded (it would otherwise blast out whenever a later play manages
   * to start the device) and false is returned so the caller can report
   * the play as failed. `stopChannel` also cancels an in-flight voice
   * sequence when the failing channel is Voice, so the sequence engine
   * can't stall waiting for an end callback that will never come.
   *
   * @returns true when playback is genuinely under way
   */
  private notifyPlaybackStart(channel: AudioChannel, filePath: string): boolean {
    if (!this.ensureDeviceRunning()) {
      this.stopChannel(channel);

      return false;
    }

    this.channelActive[channel] = true;

    const observer = this.playbackObserver;

    if (observer?.onStart) {
      try {
        observer.onStart(channel, filePath);
      } catch (err) {
        this.logger.warn(`Playback observer onStart threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return true;
  }

  private notifyPlaybackEnd(channel: AudioChannel): void {
    // Every deactivation path (natural end, manual stop, stop-all) funnels
    // through here with `channelActive` already cleared — the right moment
    // to arm the debounced device stop when this was the last active
    // channel. A follow-up clip (voice-sequence chaining, radar ticks)
    // cancels it synchronously via `ensureDeviceRunning`.
    this.maybeScheduleIdleStop();

    const observer = this.playbackObserver;

    if (!observer?.onComplete) return;

    try {
      observer.onComplete(channel);
    } catch (err) {
      this.logger.warn(`Playback observer onComplete threw: ${err instanceof Error ? err.message : String(err)}`);
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
      const resolved = this.resolvePath(connector);
      const ok = this.native.playOnChannel(
        AudioChannel.Voice,
        resolved,
        false,
        this.channelVolumes[AudioChannel.Voice],
      );

      if (ok) this.notifyPlaybackStart(AudioChannel.Voice, resolved);
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
    const resolved = this.resolvePath(file);
    const ok = this.native.playOnChannel(AudioChannel.Voice, resolved, false, this.channelVolumes[AudioChannel.Voice]);

    if (ok) this.notifyPlaybackStart(AudioChannel.Voice, resolved);
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
 *
 * `roots` is the ordered list of directories a manifest-relative clip path is
 * resolved against (absolute paths pass through unchanged). The plugin passes
 * its own `assets/audio` — a bare string, so unrestricted — and `setRoots` later
 * appends one {@link AudioRoot} per installed voice pack, each carrying the clip
 * list the scanner admitted from it (issue #1034). The first root that is both
 * authorised for the clip and has the file wins. Pass an empty list to disable
 * resolution entirely (useful in tests that inject a fake AudioNative and don't
 * care where the path points).
 */
export function initializeAudio(
  logger: ILogger = silentLogger,
  native: AudioNative,
  roots: readonly AudioRootInput[] = [],
): IAudioService {
  if (audioService) {
    throw new Error("Audio service already initialized. initializeAudio() should only be called once.");
  }

  audioService = new AudioService(logger, native, roots);
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
