/**
 * What a telemetry tick says about the replay, and how far playback carries a
 * frame (#1450): the measures the replay command gate (`replay-command-gate.ts`,
 * #1430) judges every jump and search by, and the Replay Control dial's paced
 * search (`replay-search-queue.ts`, #801) holds a reading by. Both import them
 * from here, so a retune — for a slower machine, say — moves the gate and the
 * runner together: the runner can then never hold a reading the gate calls
 * moving. A module of its own because the runner imports the gate, so the
 * measures in either would make the other reach into it.
 *
 * The numbers are the gate's, measured against the sim on 2026-10-12 and
 * 2026-10-13 (the #1430 spec's sim facts).
 */
import { replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { ReplaySpeed } from "./replay-jump-speed.js";

/** Frames per millisecond at 1x. */
const FRAMES_PER_MS = 60 / 1000;

/** A reading that is the replay's: in a replay, with a frame. */
export interface ReplayReading {
  readonly frame: number;
  /** Frames left to the end of the tape, as `ReplayFrameNumEnd` reads in a replay; undefined when it does not say. */
  readonly left: number | undefined;
  /** Playback in frames per millisecond, signed; 0 paused. */
  readonly rate: number;
  /** The speed telemetry reads; null when it does not say. */
  readonly speed: ReplaySpeed | null;
}

/**
 * The replay out of one telemetry tick, or null when the tick is not the
 * replay's: no telemetry, `IsReplayPlaying` not true (what iRacing reports
 * from the car and for the whole of a jump under way), or no finite frame.
 */
export function readReplay(telemetry: TelemetryData | null): ReplayReading | null {
  if (telemetry === null || telemetry.IsReplayPlaying !== true) return null;

  const frame = telemetry.ReplayFrameNum;

  if (typeof frame !== "number" || !Number.isFinite(frame)) return null;

  const left = telemetry.ReplayFrameNumEnd;
  const speed = replaySpeedFromTelemetry(telemetry);

  return {
    frame,
    left: typeof left === "number" && Number.isFinite(left) && left >= 0 ? left : undefined,
    rate: rateOf(speed),
    speed,
  };
}

/** Playback in frames per millisecond for a speed, signed: in slow motion the speed is the divisor. 0 paused or unknown. */
export function rateOf(speed: ReplaySpeed | null): number {
  if (speed === null || speed.speed === 0) return 0;

  const factor = speed.slowMotion ? Math.sign(speed.speed) / Math.abs(speed.speed) : speed.speed;

  return factor * FRAMES_PER_MS;
}

/** How far a reading may sit from where playback puts it and still be playback (frames). */
export function playbackTolerance(rate: number, elapsedMs: number): number {
  return 3 + Math.abs(rate) * 20 + 0.25 * Math.abs(rate * elapsedMs);
}

/**
 * Whether `frame`, read `elapsedMs` after a reading of `from`, is where
 * playback at `rate` puts it: within {@link playbackTolerance}. On a paused
 * replay (`rate` 0) that is within 3 frames of `from`; a caller that wants the
 * very frame says so itself.
 */
export function followsPlayback(from: number, rate: number, elapsedMs: number, frame: number): boolean {
  return Math.abs(frame - (from + rate * elapsedMs)) <= playbackTolerance(rate, elapsedMs);
}
