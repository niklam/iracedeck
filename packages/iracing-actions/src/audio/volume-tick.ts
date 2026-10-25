/**
 * The volume step tick (#1455): one short tick for every volume step made from
 * the deck, higher going up and lower going down, so a driver can count steps
 * by ear without looking at the deck.
 *
 * Deck feedback, not a Race Engineer callout: no bus event, no voice pack, no
 * setting, and neither the Race Engineer nor the radar switch gates it. It
 * plays on {@link AudioChannel.Feedback}, the mixer channel that belongs to no
 * bus, at a level passed per tick — so it never cuts, and is never cut by, a
 * callout, a radar tick or a pit-lane cue.
 *
 * Two kinds of caller:
 *   - iRaceDeck's own levels tick inside the step helpers in
 *     `audio-volume.ts`, once per step actually applied, at the new level.
 *   - iRacing's (Spotter, Master, Voice Chat) tick through
 *     {@link tickIRacingVolumeStep} after a binding tap that was sent, at the
 *     Radar Volume level, only while the sim is connected.
 *
 * Spec: docs/superpowers/specs/2026-10-18-issue-1455-volume-step-tick.md
 */
import { AudioChannel, getAudio } from "@iracedeck/audio-service";
import { getSimConnection } from "@iracedeck/deck-core";

import { readRadarVolume } from "./audio-levels.js";

/** Which way a volume step went. */
export type VolumeTickDirection = "up" | "down";

/**
 * The clip per direction, relative to the plugin's audio root. WAV, not MP3:
 * an MP3 frame's encoder delay and padding are the order of the whole tick,
 * which would make it late and its spacing uneven. `sfx/` is copied into the
 * plugins unchanged.
 */
export const VOLUME_TICK_CLIPS: Readonly<Record<VolumeTickDirection, string>> = {
  up: "sfx/IRD-volume-up.wav",
  down: "sfx/IRD-volume-down.wav",
};

/**
 * Lowest level a tick plays at, on the 0–100 scale. The service's perceptual
 * curve (exponent 2.5, #531) puts 10 % near −50 dB, inaudible in a car, which
 * is exactly where counting matters when turning something down. Below this
 * the tick plays at the floor; above it, it tracks the level. It also means a
 * Radar Volume of 0 does not silence the tick. Tuned by ear in the manual test.
 */
export const VOLUME_TICK_FLOOR = 20;

/**
 * Gap between the starts of two queued ticks, in ms: longer than a tick
 * (34 ms), so a fast dial spin is heard as a train of separate ticks rather
 * than one that replaces the last on the shared channel.
 */
export const VOLUME_TICK_SPACING_MS = 70;

/**
 * Most ticks that may wait behind the one playing; matches the dial's cap on
 * taps per rotate event. A backlog beyond it only builds above roughly 14
 * steps a second, where nobody is counting, and the OLDEST waiting ticks are
 * dropped, so the latest direction and level are always heard.
 */
export const VOLUME_TICK_MAX_QUEUED = 5;

/**
 * @internal Exported for testing
 *
 * The 0–100 level a tick plays at: the given level, clamped, and never below
 * {@link VOLUME_TICK_FLOOR}. A non-finite level plays at the floor.
 */
export function volumeTickLevel(level: number): number {
  if (!Number.isFinite(level)) return VOLUME_TICK_FLOOR;

  return Math.max(VOLUME_TICK_FLOOR, Math.min(100, level));
}

interface PendingTick {
  readonly direction: VolumeTickDirection;
  readonly level: number;
}

/** Ticks waiting for their slot, oldest first. */
let pending: PendingTick[] = [];
/** When the last tick started, from `performance.now()`: monotonic, so a wall-clock step cannot stall the queue. */
let lastPlayedAt = Number.NEGATIVE_INFINITY;
/** The timer that plays the next waiting tick, or null when none waits. */
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tick `count` steps in one direction, each at `level` (0–100). The first
 * plays at once unless a tick started less than {@link VOLUME_TICK_SPACING_MS}
 * ago; the rest wait their turn, spaced, in order, the backlog capped at
 * {@link VOLUME_TICK_MAX_QUEUED}. A count of zero or less ticks nothing.
 */
export function playVolumeTicks(direction: VolumeTickDirection, count: number, level: number): void {
  for (let i = 0; i < count; i++) enqueue({ direction, level });
}

/** One tick: {@link playVolumeTicks} with a count of one. */
export function playVolumeTick(direction: VolumeTickDirection, level: number): void {
  playVolumeTicks(direction, 1, level);
}

/**
 * The tick for one iRacing volume binding tap (Spotter Louder / Quieter,
 * Master or Voice Chat volume up / down). Call it only for a tap that was
 * sent (`tapBinding` returned true). It ticks at the Radar Volume level, the
 * slider every iRaceDeck tone follows, since iRacing exposes none of its own
 * levels — and only while the sim is connected, because the keystroke goes
 * out whether iRacing runs or not, and a tick for a key that reached no
 * simulator would be a false confirmation. iRacing's own limit cannot be
 * seen, so a press there still ticks.
 */
export function tickIRacingVolumeStep(direction: VolumeTickDirection): void {
  if (!getSimConnection().isConnected()) return;

  playVolumeTick(direction, readRadarVolume());
}

function enqueue(tick: PendingTick): void {
  if (timer === null && pending.length === 0 && performance.now() - lastPlayedAt >= VOLUME_TICK_SPACING_MS) {
    play(tick);

    return;
  }

  pending.push(tick);

  if (pending.length > VOLUME_TICK_MAX_QUEUED) pending.splice(0, pending.length - VOLUME_TICK_MAX_QUEUED);

  schedule();
}

function schedule(): void {
  if (timer !== null) return;

  timer = setTimeout(drain, Math.max(0, lastPlayedAt + VOLUME_TICK_SPACING_MS - performance.now()));
}

function drain(): void {
  timer = null;
  const next = pending.shift();

  if (!next) return;

  play(next);

  if (pending.length > 0) schedule();
}

function play(tick: PendingTick): void {
  lastPlayedAt = performance.now();

  try {
    getAudio().playOnChannelAtLevel(
      AudioChannel.Feedback,
      VOLUME_TICK_CLIPS[tick.direction],
      volumeTickLevel(tick.level) / 100,
    );
  } catch {
    // A tick must never break the step it reports on. The one throw here is
    // an audio service that is not initialized yet; a failed play itself
    // returns false and is logged by the service.
  }
}

/** @internal For tests: drops every waiting tick and forgets when the last one played. */
export function _resetVolumeTicks(): void {
  if (timer !== null) clearTimeout(timer);

  timer = null;
  pending = [];
  lastPlayedAt = Number.NEGATIVE_INFINITY;
}
