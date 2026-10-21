/**
 * A fake iRacing replay for the replay command gate's tests (#1430), modelled
 * on what was measured against the sim on 2026-10-12 and 2026-10-13 (the
 * spec's sim facts), so a test can say "nothing was thrown" rather than only
 * "these calls were made":
 *
 * - A position jump seeks at iRacing's 2048 frames a sim update and reads as a
 *   replay that was left until it lands. Another position jump retargets it.
 *   Any other command sent meanwhile ends it thousands of frames off its
 *   target and counts as thrown.
 * - A search is a seek telemetry does not show on a paused replay; on a
 *   playing one the frame stands still until it leaps to the landing. A pause,
 *   a speed or a frame step sent into a search on its way cancels it and is
 *   not acted on, and the replay acts on nothing more until a position jump
 *   puts it right (a pause followed by a jump was measured safe, 57 of 57). So
 *   a canceller counts as thrown unless a jump follows it, and so does every
 *   command sent before that jump. A position jump into a search wins. A
 *   search with nothing to find leaves nothing on its way. A search clears
 *   slow motion.
 * - Frames listed in `unlandable` rest a few frames on when jumped to.
 *
 * Time is the fake clock (`vi.useFakeTimers()`); the sim updates lazily on
 * every read and command.
 */
import { ReplayPosMode, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { vi } from "vitest";

import type { ReplayCommandSurface, ReplaySearchKind } from "./replay-command-gate.js";
import { type ReplaySpeed } from "./replay-jump-speed.js";

/** Frames a sim update at iRacing's search rate. */
const SEARCH_FRAMES_PER_UPDATE = 2048;
const SIM_UPDATE_MS = 1000 / 60;

/** How far off its target a jump ends when a command other than a jump arrives during it. */
export const THROWN_OFFSET = 7_597;

export interface FakeReplayOptions {
  readonly frame?: number;
  readonly speed?: ReplaySpeed;
  /** The last frame of the tape. Default six hours. */
  readonly end?: number;
  /** Where each search lands from the frame it is sent on; null finds nothing. Default: nothing for any search. */
  readonly searches?: Partial<Record<ReplaySearchKind, (from: number) => number | null>>;
  /** Frames a jump to which rests `unlandableRest` on. */
  readonly unlandable?: ReadonlySet<number>;
  readonly unlandableRest?: number;
  /** The shortest a jump or a search takes to land (ms). */
  readonly minSeekMs?: number;
  /** How long a speed or a pause takes to show (ms): the replay keeps its old speed meanwhile. Default 0. */
  readonly speedLagMs?: number;
}

export interface FakeReplay {
  readonly replay: ReplayCommandSurface & Record<string, ReturnType<typeof vi.fn>>;
  /** Every command, in the order it was sent. */
  readonly calls: string[];
  /** How many commands were lost: sent into a jump, or into a search on its way with no jump to put it right. */
  readonly thrown: number;
  telemetry(): TelemetryData;
  frame(): number;
  speed(): ReplaySpeed;
  /** Whether a jump or a search is under way in the sim. */
  busy(): boolean;
  /** Leave the replay: telemetry reads as from the car. */
  leave(): void;
}

function seekMs(distance: number, minMs: number): number {
  return Math.max(minMs, Math.ceil(Math.abs(distance) / SEARCH_FRAMES_PER_UPDATE) * SIM_UPDATE_MS);
}

function rateOf(speed: ReplaySpeed): number {
  if (speed.speed === 0) return 0;

  return (speed.slowMotion ? Math.sign(speed.speed) / Math.abs(speed.speed) : speed.speed) * (60 / 1000);
}

export function fakeReplay(options: FakeReplayOptions = {}): FakeReplay {
  const end = options.end ?? 1_296_000;
  const minSeekMs = options.minSeekMs ?? 20;
  let position = options.frame ?? 100_000;
  let speed: ReplaySpeed = options.speed ?? { speed: 0, slowMotion: false };
  let lastAt = Date.now();
  let seek: { target: number; landsAt: number } | null = null;
  let search: { landing: number; landsAt: number } | null = null;
  /** A canceller left the replay not acting on commands until a position jump. */
  let frozen = false;
  let left = false;
  let seekHits = 0;
  let lost = 0;
  let pendingSpeed: { speed: ReplaySpeed; at: number } | null = null;
  const calls: string[] = [];

  const advance = (): void => {
    const now = Date.now();

    if (pendingSpeed !== null && now >= pendingSpeed.at) {
      if (seek === null && search === null && !frozen) {
        position = Math.min(end, Math.max(0, position + rateOf(speed) * (pendingSpeed.at - lastAt)));
        lastAt = pendingSpeed.at;
      }

      speed = pendingSpeed.speed;
      pendingSpeed = null;
    }

    if (seek !== null && now >= seek.landsAt) {
      lastAt = seek.landsAt;
      position = seek.target;
      seek = null;
    }

    if (search !== null && now >= search.landsAt) {
      lastAt = search.landsAt;
      position = search.landing;
      search = null;
    }

    if (seek === null && search === null && !frozen) {
      position = Math.min(end, Math.max(0, position + rateOf(speed) * (now - lastAt)));
    }

    lastAt = now;
  };

  const landingOf = (frame: number): number =>
    options.unlandable?.has(frame) === true ? (options.unlandableRest ?? frame + 5) : Math.min(frame, end - 5);

  const startSeek = (target: number): void => {
    const from = seek?.target ?? Math.floor(position);

    search = null;
    // A position jump puts a cancelled search right: the canceller's harm is undone.
    frozen = false;
    seek = { target: landingOf(target), landsAt: Date.now() + seekMs(target - from, minSeekMs) };
  };

  /** A non-jump command: thrown into a jump or a search on its way. True when it may act. */
  const intrude = (): boolean => {
    advance();

    if (seek !== null) {
      seekHits++;
      position = Math.min(end, seek.target + THROWN_OFFSET);
      seek = null;

      return false;
    }

    if (search !== null) {
      search = null;
      frozen = true;

      return false;
    }

    if (frozen) lost++;

    return !frozen;
  };

  const setSpeed = (next: ReplaySpeed): boolean => {
    const acts = intrude();
    const applied = acts ? next : next.speed === 0 ? next : speed;

    if ((options.speedLagMs ?? 0) > 0) pendingSpeed = { speed: applied, at: Date.now() + (options.speedLagMs ?? 0) };
    else speed = applied;

    return true;
  };

  const startSearch = (kind: ReplaySearchKind): boolean => {
    if (!intrude()) return true;

    const landing = options.searches?.[kind]?.(Math.floor(position)) ?? null;

    if (landing === null) return true;

    if (speed.slowMotion) speed = { speed: Math.sign(speed.speed) || 1, slowMotion: false };

    search = { landing, landsAt: Date.now() + seekMs(landing - position, minSeekMs) };

    return true;
  };

  const record =
    <A extends unknown[]>(name: string, run: (...args: A) => boolean) =>
    (...args: A): boolean => {
      calls.push(args.length === 0 ? name : `${name} ${args.join(" ")}`);

      return run(...args);
    };

  const replay = {
    setPlaySpeed: vi.fn(
      record("setPlaySpeed", (value: number, slowMotion: boolean = false) => setSpeed({ speed: value, slowMotion })),
    ),
    setPlayPosition: vi.fn(
      record("setPlayPosition", (_mode: ReplayPosMode, frame: number) => {
        advance();
        startSeek(frame);

        return true;
      }),
    ),
    play: vi.fn(record("play", () => setSpeed({ speed: 1, slowMotion: false }))),
    pause: vi.fn(record("pause", () => setSpeed({ speed: 0, slowMotion: false }))),
    nextFrame: vi.fn(
      record("nextFrame", () => {
        if (intrude() && speed.speed === 0) position = Math.min(end - 1, Math.floor(position) + 1);

        return true;
      }),
    ),
    prevFrame: vi.fn(
      record("prevFrame", () => {
        if (intrude() && speed.speed === 0) position = Math.max(0, Math.floor(position) - 1);

        return true;
      }),
    ),
    goToStart: vi.fn(
      record("goToStart", () => {
        advance();
        startSeek(0);

        return true;
      }),
    ),
    goToEnd: vi.fn(
      record("goToEnd", () => {
        advance();
        startSeek(end - 60);

        return true;
      }),
    ),
    nextLap: vi.fn(record("nextLap", () => startSearch("nextLap"))),
    prevLap: vi.fn(record("prevLap", () => startSearch("prevLap"))),
    nextSession: vi.fn(record("nextSession", () => startSearch("nextSession"))),
    prevSession: vi.fn(record("prevSession", () => startSearch("prevSession"))),
    nextIncident: vi.fn(record("nextIncident", () => startSearch("nextIncident"))),
    prevIncident: vi.fn(record("prevIncident", () => startSearch("prevIncident"))),
  };

  const fake: FakeReplay = {
    replay: replay as FakeReplay["replay"],
    calls,
    get thrown(): number {
      return seekHits + lost + (frozen ? 1 : 0);
    },
    telemetry(): TelemetryData {
      advance();

      if (left || seek !== null) {
        return {
          IsReplayPlaying: false,
          IsOnTrack: false,
          ReplayFrameNum: 0,
          ReplayFrameNumEnd: end,
          ReplayPlaySpeed: 0,
          ReplayPlaySlowMotion: false,
          SessionNum: -1,
        } as TelemetryData;
      }

      const frame = Math.floor(position);

      return {
        IsReplayPlaying: true,
        IsOnTrack: false,
        ReplayFrameNum: frame,
        ReplayFrameNumEnd: end - frame,
        ReplaySessionTime: frame / 60,
        ReplayPlaySpeed: replaySpeedToSdk(speed.speed, speed.slowMotion),
        ReplayPlaySlowMotion: speed.slowMotion,
        SessionNum: 0,
      } as TelemetryData;
    },
    frame(): number {
      advance();

      return Math.floor(seek?.target ?? position);
    },
    speed(): ReplaySpeed {
      return speed;
    },
    busy(): boolean {
      advance();

      return seek !== null || search !== null;
    },
    leave(): void {
      left = true;
    },
  };

  return fake;
}
