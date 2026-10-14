/**
 * The replay command gate (#1430): the one module that sends a replay command.
 * Design: `docs/superpowers/specs/2026-10-12-issue-1430-replay-command-gate.md`.
 *
 * A replay command sent while a position jump is still under way ends the
 * jump somewhere else, and one sent while a search is on its way cancels the
 * search (measured 2026-10-12 and 2026-10-13; the facts are in the spec and in
 * `replay-position-state.ts`). Only another absolute jump is safe, because it
 * retargets the seek. So every surface says what it wants sent, and the gate
 * decides when it goes out, and whether:
 *
 * | Command | Nothing under way | A target stands, or a seek shows | A search may be on its way |
 * | --- | --- | --- | --- |
 * | Absolute jump | sent, target recorded | sent, replaces the target | sent, the search forgotten |
 * | Go to start / end | sent, recorded | sent, the target cleared | waits |
 * | Frame step | sent | an absolute jump one frame from the target | waits |
 * | Pause | sent | not sent: the replay is paused for the jump | waits; nothing to send on a paused replay |
 * | A speed | sent | waits for the read-back | waits |
 * | Search, anything else | sent | waits for the read-back to hold | waits |
 *
 * - **One record of where the replay is headed**: the pending target
 *   (`replay-position-state.ts`), which every position jump the plugin sends
 *   records, whoever sent it.
 * - **One record of a search the gate sent** (go to start and go to end too:
 *   position jumps to a frame the gate does not know). On a paused replay no
 *   telemetry shows a search on its way, so it is taken to be on its way until
 *   its landing reads back (the frame moved, then held two reads 50 ms apart)
 *   or until it can no longer be running: the frames to the edge of the tape
 *   in its direction at iRacing's 2048 a sim update, doubled, never under the
 *   fastest-lap walk's wait. On a playing replay the gate reads it: a frame
 *   standing still is a search on its way, one still advancing a Fastest Lap
 *   Search Delay after the send found nothing. The record itself has no time
 *   limit; it ends at a landing, an absolute jump or the replay being left.
 * - **One waiting slot**, newest wins. A command that waits goes out when what
 *   it waits on has landed, however long that takes. Behind a jump it is
 *   dropped only when the jump ends off its target or the jump's own wait runs
 *   out. Behind a search a second press, or the end of the time the search
 *   could be running, **takes over**: a pause if the replay is moving, an
 *   absolute jump to the frame beside the reading (right whether or not a
 *   search was running: into one it wins), judged as moved and then held, and
 *   then the press's command.
 * - **Every wait ends on what telemetry reads back.** No measured duration is a
 *   constant that correctness rests on (maintainer, 2026-10-12): each clock
 *   here only gives up, by dropping a press or handing it to a takeover that
 *   is right either way.
 * - **The state seam**: an optional opaque origin token rides on each press,
 *   and the gate reports per token whether something of it is under way or
 *   waiting ({@link subscribeReplayGate}). It adds no behaviour: the gate
 *   sends the same commands in the same order with and without a listener.
 *
 * A one-shot press goes through {@link pressReplayCommand}, which takes the
 * replay cursor (`replay-cursor.ts`) as every command did before. A long-running
 * driver that holds the cursor (the jump sequence, the fastest-lap walk) sends
 * through {@link sendOwnedReplayCommand} and the replay-jump calls below,
 * which keep its sequencing its own.
 *
 * In memory only, and one gate for the whole plugin: iRacing has one replay.
 */
import { getCommands, getController } from "@iracedeck/deck-iracing";
import { ReplayPosMode, replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import {
  cancelReplayCursorOwner,
  claimReplayCursor,
  onReplayCursorTaken,
  pendingReplayJumpSpeed,
  type ReplayCursorClaim,
} from "./replay-cursor.js";
import { frameBeside, planFrameMove } from "./replay-frame-move.js";
import { isSameSpeed, readReplayJumpPlayback, type ReplaySpeed, resolveReplayJumpSpeed } from "./replay-jump-speed.js";
import {
  clearReplayTarget,
  markReplayTargetSent,
  pendingReplayTarget,
  pendingReplayTargetPosition,
  recordReplayTarget,
  type ReplayPosition,
  type ReplayTarget,
  replayTargetGiveUpMs,
  resolveReplayPosition,
  settleReplayTarget,
} from "./replay-position-state.js";
import { isPaused, isSeeking, replaySeekWaitMs } from "./replay-seek.js";
import {
  readFastestLapSearchDelayMs,
  readReplayJumpTimeoutMs,
  REPLAY_JUMP_POLL_MS,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "./replay-timing.js";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The replay commands the gate sends; `getCommands().replay` is one. */
export interface ReplayCommandSurface {
  setPlaySpeed(speed: number, slowMotion?: boolean): boolean;
  setPlayPosition(mode: ReplayPosMode, frameNumber: number): boolean;
  play(): boolean;
  pause(): boolean;
  nextFrame(): boolean;
  prevFrame(): boolean;
  goToStart(): boolean;
  goToEnd(): boolean;
  nextLap(): boolean;
  prevLap(): boolean;
  nextSession(): boolean;
  prevSession(): boolean;
  nextIncident(): boolean;
  prevIncident(): boolean;
}

/** A lap, session or incident search. */
export type ReplaySearchKind = "nextLap" | "prevLap" | "nextSession" | "prevSession" | "nextIncident" | "prevIncident";

/** What a surface asks the gate to send. */
export type ReplayGateCommand =
  /** An absolute position jump (`setPlayPosition(Begin, frame)`). */
  | { readonly kind: "jump"; readonly frame: number }
  /** Go to start, or go to end (Jump to Live). */
  | { readonly kind: "go-to"; readonly end: "start" | "end" }
  /** One frame forward or back. */
  | { readonly kind: "step"; readonly direction: 1 | -1 }
  /** `send` names the SDK call when it is not `pause()`: the jump sequence's `setPlaySpeed(0)`. */
  | { readonly kind: "pause"; readonly send?: (replay: ReplayCommandSurface) => boolean }
  /**
   * A playing speed (not 0: a pause is {@link ReplayGateCommand} `pause`).
   * `send` names the SDK call when it is not `setPlaySpeed(speed, slowMotion)`
   * — `play()`, the legacy actions' `fastForward()` — so the call that goes
   * out is the one the surface always made.
   */
  | {
      readonly kind: "speed";
      readonly speed: number;
      readonly slowMotion: boolean;
      readonly send?: (replay: ReplayCommandSurface) => boolean;
    }
  | { readonly kind: "search"; readonly search: ReplaySearchKind }
  /** Anything else: `searchSessionTime`, `eraseTape`, a relative jump. Waits like a search, and records nothing. */
  | { readonly kind: "other"; readonly name: string; readonly send: (replay: ReplayCommandSurface) => boolean };

/** What became of a press. */
export type ReplayPressResult =
  /** It went out now. `ok` is what the SDK answered. */
  | { readonly kind: "sent"; readonly ok: boolean }
  /** It waits in the slot for what is under way to land. */
  | { readonly kind: "held" }
  /** It went into a takeover, whose jump went out now (`ok` is the SDK's answer to it). */
  | { readonly kind: "taking-over"; readonly ok: boolean }
  /** Nothing is sent, and nothing waits: a pause into a jump, a step with no frame to measure from. */
  | { readonly kind: "not-sent"; readonly reason: string };

/** How a press is made. */
export interface ReplayPressOptions {
  /** The name the cursor take is logged under: the mode or the dial owner (`play-pause`, `dial-frame-jog`). */
  readonly by: string;
  /** The opaque origin token of the press (a key's context id, a dial's own); none for a detent. */
  readonly origin?: string;
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/** What the gate reads and sends through; injectable for tests. */
export interface ReplayGateEnv {
  replay(): ReplayCommandSurface;
  /** A fresh telemetry reading (a native read), or null. */
  readTelemetry(): TelemetryData | null;
  /** Whether a replay is on screen: the controller's debounced replay state (#1324). */
  inReplay(): boolean;
  /** Whether the SDK is connected to the sim. */
  connected(): boolean;
  now(): number;
}

const defaultEnv: ReplayGateEnv = {
  replay: () => getCommands().replay,
  readTelemetry: () => {
    try {
      return getController().getCurrentTelemetry();
    } catch {
      return null;
    }
  },
  inReplay: () => {
    try {
      return getController().getReplayState().inReplay;
    } catch {
      return false;
    }
  },
  connected: () => {
    try {
      return getController().getConnectionStatus();
    } catch {
      return true;
    }
  },
  now: () => Date.now(),
};

let env: ReplayGateEnv = defaultEnv;
let log: ILogger = silentLogger;

/** The logger the gate's own lines go to. The replay actions set it once, at construction. */
export function setReplayCommandGateLogger(logger: ILogger): void {
  log = logger;
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** How long apart two reads must be for a landing to count as held (ms). */
const HOLD_GAP_MS = STABILIZATION_POLL_INTERVAL_MS;

/** How many reads a search behind a jump waits for, the read-back included: the read-back form of the 100 ms that worked every time. */
const SEARCH_BEHIND_JUMP_READS = 3;

/** Frames per millisecond at 1x. */
const FRAMES_PER_MS = 60 / 1000;

/** How long a gate-sent speed stands in for a reading that does not show it yet (ms), for "is the replay moving". */
const SPEED_SENT_HOLD_MS = 200;

interface Sample {
  readonly frame: number;
  readonly at: number;
}

/** A reading that is the replay's: in a replay, with a frame. */
interface ReplayReading {
  readonly frame: number;
  /** Frames left to the end of the tape, as `ReplayFrameNumEnd` reads in a replay; undefined when it does not say. */
  readonly left: number | undefined;
  /** Playback in frames per millisecond, signed; 0 paused. */
  readonly rate: number;
  readonly speed: ReplaySpeed | null;
}

function readReplay(telemetry: TelemetryData | null): ReplayReading | null {
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

/** Playback in frames per millisecond for a speed: in slow motion the speed is the divisor. */
function rateOf(speed: ReplaySpeed | null): number {
  if (speed === null || speed.speed === 0) return 0;

  const factor = speed.slowMotion ? Math.sign(speed.speed) / Math.abs(speed.speed) : speed.speed;

  return factor * FRAMES_PER_MS;
}

/** How far a reading may sit from where playback puts it and still be playback (frames). */
function playbackTolerance(rate: number, elapsedMs: number): number {
  return 3 + Math.abs(rate) * 20 + 0.25 * Math.abs(rate * elapsedMs);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SearchRecordKind = ReplaySearchKind | "go-to-start" | "go-to-end";

/** A search the gate sent, or a go to start / end. */
interface SearchRecord {
  readonly kind: SearchRecordKind;
  readonly direction: 1 | -1;
  readonly sentAt: number;
  /** The frame on screen when it went out; null when the reading was not the replay's. */
  readonly fromFrame: number | null;
  /** The speed the replay had when it went out: what a takeover or a replay jump gives back, slow motion included. */
  readonly speedAtSend: ReplaySpeed;
  readonly playing: boolean;
  /** How long it could be running on a paused replay (ms). */
  readonly couldRunMs: number;
  readonly origin: string | undefined;
  /** Whether it is still taken to be on its way: its fact in the state seam. False once it can no longer be running. */
  onItsWay: boolean;
  /** Whether telemetry has shown it on its way: a playing replay's frame standing still. */
  seen: boolean;
  landed: boolean;
  last: Sample | null;
  still: Sample | null;
  moved: Sample | null;
}

/** A takeover's jump: judged as moved and then held, not by an exact read-back. */
interface Takeover {
  readonly targetId: number;
  readonly fromFrame: number;
  readonly sentAt: number;
  readonly waitMs: number;
  moved: Sample | null;
}

/** Speeds the slot carries. */
type SlotCommand =
  | ReplayGateCommand
  /** The Replay jump playback step for a search that waited behind a jump sequence: applied after the search lands. */
  | { readonly kind: "playback"; readonly captured: ReplaySpeed };

interface Slot {
  readonly command: SlotCommand;
  readonly by: string;
  readonly origin: string | undefined;
  readonly pressedAt: number;
  readonly behind: "jump" | "search";
  /** The target it waits on; null behind a seek only the witness shows. */
  behindTargetId: number | null;
  /** For a search that waits behind a jump sequence: the speed that sequence captured, for the playback step after the search lands. */
  readonly jumpPlayback: ReplaySpeed | null;
  /** For a takeover's search: the speed to give back once the search has landed. */
  readonly restoreSpeed: ReplaySpeed | null;
  /** Reads after the read-back, for a search behind a jump. */
  holds: Sample[];
}

/** A replay jump holding the cursor (`replay-jump-playback.ts`, the walk). */
interface HeldJump {
  readonly claim: ReplayCursorClaim;
  readonly origin: string | undefined;
  /** The target it recorded at the press; null for a walk or a search runner. */
  target: ReplayTarget | null;
  /** Whether the gate has sent a pause for it. */
  pausedByGate: boolean;
  /**
   * Whether, when it opened, the replay had been paused for another jump under
   * way: its own target then replaced that jump's, and it must not pause again.
   */
  inheritedPause: boolean;
  /** Whether its seek is owed by the gate: a press took the cursor in its pause window. */
  owed: boolean;
  owedSince: number;
  /** Whether its step after the landing runs on the read-back although it no longer holds the cursor. */
  carried: boolean;
  readonly afterLanding: ((landing: TelemetryData) => void) | undefined;
  /** How its target ended, once it has. */
  status: JumpLandingStatus;
  landing: TelemetryData | null;
}

/** How a replay jump's target ended. */
export type JumpLandingStatus = "pending" | "read-back" | "gave-up" | "replaced" | "cleared";

/** What became of each target the slot or a jump may wait on. */
type TargetFate =
  | { readonly kind: "read-back"; readonly telemetry: TelemetryData; readonly held: boolean }
  | { readonly kind: "gave-up" | "cleared" | "nothing-moved" }
  | { readonly kind: "replaced"; readonly by: number | null };

let search: SearchRecord | null = null;
let takeover: Takeover | null = null;
let slot: Slot | null = null;
let held: HeldJump | null = null;
let owed: HeldJump | null = null;
const jumpsByTarget = new Map<number, HeldJump>();
const fates = new Map<number, TargetFate>();

/** How many target fates are kept: the slot and a jump wait on one or two at a time. */
const MAX_FATES = 64;

function setFate(id: number, fate: TargetFate): void {
  fates.delete(id);
  fates.set(id, fate);

  while (fates.size > MAX_FATES) {
    const oldest = fates.keys().next().value;

    if (oldest === undefined) break;

    fates.delete(oldest);
  }
}
/** The last playing speed the gate sent, for "is the replay moving" before a reading shows it. */
let speedSent: { readonly speed: ReplaySpeed; readonly at: number } | null = null;
/** Whether the latest reading showed a seek nobody recorded (the witness). */
let witness = false;
/** The last reading that was the replay's, for a takeover with no frame on screen. */
let lastReplay: ReplayReading | null = null;
/** When the gate last went from idle to busy (ms), for the record. */
let busySince: number | null = null;
/** Set while the gate itself takes the cursor, so its listener tells a press from an outside take. */
let gateTaking = false;
let timer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// The state seam
// ---------------------------------------------------------------------------

export type ReplayGateEndReason =
  | "read-back"
  | "landed"
  | "jump-landed"
  | "sent-on-landing"
  | "took-over"
  | "retargeted"
  | "forgotten"
  | "claim-taken"
  | "replaced"
  | "cleared-by-pause"
  | "off-target"
  | "wait-ran-out"
  | "nothing-moved"
  | "walk-gave-up"
  | "refused"
  | "disconnected"
  | "replay-left";

export type ReplayGateEndClass = "completed" | "superseded" | "gave-up";

const END_CLASS: Record<ReplayGateEndReason, ReplayGateEndClass> = {
  "read-back": "completed",
  landed: "completed",
  "jump-landed": "completed",
  "sent-on-landing": "completed",
  "took-over": "completed",
  retargeted: "superseded",
  forgotten: "superseded",
  "claim-taken": "superseded",
  replaced: "superseded",
  "cleared-by-pause": "superseded",
  "off-target": "gave-up",
  "wait-ran-out": "gave-up",
  "nothing-moved": "gave-up",
  "walk-gave-up": "gave-up",
  refused: "gave-up",
  disconnected: "gave-up",
  "replay-left": "gave-up",
};

/** What the gate says about one origin token. */
export interface ReplayGateView {
  /** Something of this token's is under way: its target stands, its search may be on its way, or its replay jump holds the cursor. */
  readonly underWay: { readonly since: number; readonly seen: boolean } | null;
  /** A command of this token's waits in the slot. */
  readonly waiting: { readonly since: number } | null;
}

export interface ReplayGateFactEnd {
  readonly fact: "underWay" | "waiting";
  readonly class: ReplayGateEndClass;
  readonly reason: ReplayGateEndReason;
}

/** One change for one token: its new view and whatever of it ended in that change. */
export interface ReplayGateNotice {
  readonly origin: string;
  readonly view: ReplayGateView;
  readonly ended: readonly ReplayGateFactEnd[];
}

const EMPTY_VIEW: ReplayGateView = { underWay: null, waiting: null };
const listeners = new Set<(notice: ReplayGateNotice) => void>();
const views = new Map<string, ReplayGateView>();
const runs = new Map<string, number>();
let batchDepth = 0;
let batchNow = 0;
const batchEnds = new Map<string, ReplayGateFactEnd[]>();

/** Runs `listener` on every change of any token's view. Returns the unsubscribe. */
export function subscribeReplayGate(listener: (notice: ReplayGateNotice) => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** The view of one token, as the last change left it. */
export function getReplayGateView(origin: string): ReplayGateView {
  return views.get(origin) ?? EMPTY_VIEW;
}

function noteEnd(origin: string | undefined, fact: "underWay" | "waiting", reason: ReplayGateEndReason): void {
  if (origin === undefined) return;

  const list = batchEnds.get(origin) ?? [];

  list.push({ fact, class: END_CLASS[reason], reason });
  batchEnds.set(origin, list);
}

/** Runs `change` as one change: views are computed and notices sent once, at its end. */
function batch<T>(now: number, change: () => T): T {
  if (batchDepth === 0) batchNow = now;

  batchDepth++;

  try {
    return change();
  } finally {
    batchDepth--;

    if (batchDepth === 0) publish();
  }
}

/** Every token's view from the state as it stands. */
function computeViews(): Map<string, ReplayGateView> {
  const underWay = new Map<string, boolean>();
  const add = (origin: string | undefined, seen: boolean): void => {
    if (origin === undefined) return;

    underWay.set(origin, (underWay.get(origin) ?? false) || seen);
  };
  const target = pendingReplayTarget();

  if (target !== null) add(target.origin, target.sent && witness);

  if (search !== null && search.onItsWay && !search.landed) add(search.origin, search.seen);

  if (held !== null && held.claim.cancelledBy === null) add(held.origin, witness);

  const result = new Map<string, ReplayGateView>();
  const tokens = new Set<string>([...underWay.keys(), ...(slot?.origin === undefined ? [] : [slot.origin])]);

  for (const origin of tokens) {
    const since = runs.get(origin) ?? batchNow;
    const isUnderWay = underWay.has(origin);

    result.set(origin, {
      underWay: isUnderWay ? { since, seen: underWay.get(origin) ?? false } : null,
      waiting: slot !== null && slot.origin === origin ? { since: slot.pressedAt } : null,
    });
  }

  return result;
}

function sameView(a: ReplayGateView, b: ReplayGateView): boolean {
  return (
    a.underWay?.since === b.underWay?.since &&
    a.underWay?.seen === b.underWay?.seen &&
    a.waiting?.since === b.waiting?.since &&
    (a.underWay === null) === (b.underWay === null) &&
    (a.waiting === null) === (b.waiting === null)
  );
}

function publish(): void {
  const next = computeViews();
  const tokens = new Set<string>([...views.keys(), ...next.keys(), ...batchEnds.keys()]);
  const notices: ReplayGateNotice[] = [];

  for (const origin of tokens) {
    const before = views.get(origin) ?? EMPTY_VIEW;
    const after = next.get(origin) ?? EMPTY_VIEW;
    const ended = [...(batchEnds.get(origin) ?? [])];

    // A fact that is gone with no end recorded for it still ends: never silently.
    if (before.underWay !== null && after.underWay === null && !ended.some((e) => e.fact === "underWay")) {
      ended.push({ fact: "underWay", class: "gave-up", reason: "wait-ran-out" });
    }

    if (before.waiting !== null && after.waiting === null && !ended.some((e) => e.fact === "waiting")) {
      ended.push({ fact: "waiting", class: "superseded", reason: "replaced" });
    }

    if (after.underWay === null && after.waiting === null) {
      runs.delete(origin);
      views.delete(origin);
    } else {
      if (!runs.has(origin)) runs.set(origin, batchNow);

      views.set(origin, after);
    }

    if (ended.length > 0 || !sameView(before, after)) notices.push({ origin, view: after, ended });
  }

  batchEnds.clear();

  for (const notice of notices) {
    for (const listener of listeners) {
      try {
        listener(notice);
      } catch (err) {
        log.debug(`Replay gate listener failed: ${String(err)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function sendRaw(name: string, send: (replay: ReplayCommandSurface) => boolean): boolean {
  let ok = false;

  try {
    ok = send(env.replay());
  } catch (err) {
    log.debug(`Replay command ${name} threw: ${String(err)}`);
  }

  return ok;
}

function describe(command: SlotCommand): string {
  switch (command.kind) {
    case "jump":
      return `jump to ${command.frame}`;
    case "go-to":
      return `go to ${command.end}`;
    case "step":
      return `step ${command.direction}`;
    case "pause":
      return "pause";
    case "speed":
      return `speed ${command.speed}${command.slowMotion ? " (slow motion)" : ""}`;
    case "search":
      return command.search;
    case "other":
      return command.name;
    case "playback":
      return "the Replay jump playback step";
  }
}

function searchDirection(kind: SearchRecordKind): 1 | -1 {
  return kind === "prevLap" || kind === "prevSession" || kind === "prevIncident" || kind === "go-to-start" ? -1 : 1;
}

/**
 * How long a search sent from `reading` in `direction` could be running: the
 * frames to the edge of the tape it runs towards at iRacing's search rate,
 * doubled, and never under the fastest-lap walk's wait. With no reading, the
 * whole of the tape the gate last saw.
 */
export function replaySearchMayRunMs(telemetry: TelemetryData | null, direction: 1 | -1): number {
  const reading = readReplay(telemetry) ?? lastReplay;
  const floorMs = readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER;

  if (reading === null) return floorMs;

  const distance = direction > 0 ? (reading.left ?? 0) : reading.frame;

  return replaySeekWaitMs(distance, floorMs);
}

/** The speed the replay has now: a gate-sent speed telemetry does not show yet, else the reading's. */
function currentSpeed(reading: ReplayReading | null, now: number): ReplaySpeed {
  if (speedSent !== null && now - speedSent.at < SPEED_SENT_HOLD_MS) {
    if (reading?.speed == null || !isSameSpeed(reading.speed, speedSent.speed)) return speedSent.speed;
  }

  const pending = pendingReplayJumpSpeed();

  if (pending !== null && pending.appliedAt !== null && now - pending.appliedAt < SPEED_SENT_HOLD_MS) {
    if (reading?.speed == null || !isSameSpeed(reading.speed, pending)) return { ...pending };
  }

  return reading?.speed ?? { speed: 0, slowMotion: false };
}

function recordSearch(
  kind: SearchRecordKind,
  telemetry: TelemetryData | null,
  now: number,
  origin: string | undefined,
): void {
  const reading = readReplay(telemetry);
  const direction = searchDirection(kind);
  const speedAtSend = currentSpeed(reading, now);

  endSearch("forgotten");
  search = {
    kind,
    direction,
    sentAt: now,
    fromFrame: reading?.frame ?? null,
    speedAtSend,
    playing: speedAtSend.speed !== 0,
    couldRunMs: replaySearchMayRunMs(telemetry, direction),
    origin,
    onItsWay: true,
    seen: false,
    landed: false,
    last: reading === null ? null : { frame: reading.frame, at: now },
    still: reading === null ? null : { frame: reading.frame, at: now },
    moved: null,
  };
}

/** Drops the search record, ending its fact for `reason`. */
function endSearch(reason: ReplayGateEndReason): void {
  if (search === null) return;

  if (search.onItsWay && !search.landed) noteEnd(search.origin, "underWay", reason);

  search = null;
}

/**
 * Records a target for a jump that went out, and ends what the jump
 * supersedes: the search (forgotten), a takeover (replaced) and another
 * token's target (retargeted). `details` is a replay jump's own.
 */
function recordTarget(
  frame: number,
  telemetry: TelemetryData | null,
  now: number,
  origin: string | undefined,
  details: { sent?: boolean; heldBy?: () => boolean } = {},
): ReplayTarget {
  const previous = pendingReplayTarget();
  const target = recordReplayTarget(frame, telemetry, now, { ...details, origin });

  if (previous !== null) {
    setFate(previous.id, { kind: "replaced", by: target.id });

    if (previous.origin !== origin) noteEnd(previous.origin, "underWay", "retargeted");

    const jump = jumpsByTarget.get(previous.id);

    if (jump !== undefined) {
      jump.status = "replaced";
      jumpsByTarget.delete(previous.id);
    }
  }

  takeover = null;

  return target;
}

/** Clears the pending target as `fate`, ending its fact. */
function clearTarget(fate: TargetFate["kind"], reason: ReplayGateEndReason): void {
  const target = pendingReplayTarget();

  if (target === null) return;

  clearReplayTarget();
  setFate(target.id, fate === "replaced" ? { kind: "replaced", by: null } : ({ kind: fate } as TargetFate));
  noteEnd(target.origin, "underWay", reason);

  const jump = jumpsByTarget.get(target.id);

  if (jump !== undefined) {
    jump.status =
      fate === "replaced" ? "replaced" : fate === "gave-up" || fate === "nothing-moved" ? "gave-up" : "cleared";
    jumpsByTarget.delete(target.id);
  }

  if (takeover?.targetId === target.id) takeover = null;
}

/** Empties the slot, ending its fact for `reason`. */
function emptySlot(reason: ReplayGateEndReason, why?: string): void {
  if (slot === null) return;

  if (why !== undefined) log.debug(`Replay command dropped: ${describe(slot.command)} (${slot.by}); ${why}`);

  noteEnd(slot.origin, "waiting", reason);
  slot = null;
}

/** Sends a command with nothing under way, recording what it starts. Returns the SDK's answer. */
function dispatch(
  command: SlotCommand,
  telemetry: TelemetryData | null,
  now: number,
  origin: string | undefined,
): boolean {
  const reading = readReplay(telemetry);

  switch (command.kind) {
    case "jump": {
      const ok = sendRaw("setPlayPosition", (r) => r.setPlayPosition(ReplayPosMode.Begin, command.frame));

      if (!ok) return false;

      endSearch("forgotten");

      // A jump to the frame on screen, with nothing standing, can never read back conclusively.
      if (pendingReplayTarget() === null && reading !== null && reading.frame === command.frame) return true;

      recordTarget(command.frame, telemetry, now, origin);

      return true;
    }
    case "go-to": {
      const ok = sendRaw(command.end === "start" ? "goToStart" : "goToEnd", (r) =>
        command.end === "start" ? r.goToStart() : r.goToEnd(),
      );

      if (!ok) return false;

      clearTarget("replaced", "retargeted");

      // A go to the end it already stands on, or the start, moves nothing and records nothing.
      const already =
        reading !== null &&
        (command.end === "start" ? reading.frame === 0 : reading.left !== undefined && reading.left <= 0);

      if (already) endSearch("forgotten");
      else recordSearch(command.end === "start" ? "go-to-start" : "go-to-end", telemetry, now, origin);

      return true;
    }
    case "step": {
      const ok = sendRaw(command.direction > 0 ? "nextFrame" : "prevFrame", (r) =>
        command.direction > 0 ? r.nextFrame() : r.prevFrame(),
      );

      // A step into a replay that reads paused lands one frame on; one that still plays lands wherever
      // the pause catches it, and records nothing.
      if (ok && reading !== null && currentSpeed(reading, now).speed === 0) {
        const frame = reading.frame + command.direction;
        const last = reading.left === undefined ? Infinity : reading.frame + reading.left - 1;

        if (frame >= 0 && frame <= last) recordTarget(frame, telemetry, now, origin);
      }

      return ok;
    }
    case "pause": {
      const ok = sendRaw("pause", command.send ?? ((r) => r.pause()));

      if (ok) speedSent = null;

      return ok;
    }
    case "speed": {
      const ok = sendRaw("setPlaySpeed", command.send ?? ((r) => r.setPlaySpeed(command.speed, command.slowMotion)));

      if (ok) speedSent = { speed: { speed: command.speed, slowMotion: command.slowMotion }, at: now };

      return ok;
    }
    case "search": {
      const ok = sendRaw(command.search, (r) => r[command.search]());

      if (ok) recordSearch(command.search, telemetry, now, origin);

      return ok;
    }
    case "other":
      return sendRaw(command.name, command.send);
    case "playback": {
      const wanted = resolveReplayJumpSpeed(readReplayJumpPlayback(), command.captured);
      const live = reading?.speed ?? null;

      if (live !== null && isSameSpeed(live, wanted)) return true;

      if (wanted.speed === 0) return dispatch({ kind: "pause" }, telemetry, now, origin);

      return dispatch({ kind: "speed", speed: wanted.speed, slowMotion: wanted.slowMotion }, telemetry, now, origin);
    }
  }
}

// ---------------------------------------------------------------------------
// Settling: what a reading says about what is under way
// ---------------------------------------------------------------------------

/** Whether a position jump is under way: a target stands (sent or not), a takeover runs, or a seek shows. */
function jumpUnderWay(): boolean {
  return pendingReplayTarget() !== null || takeover !== null || witness;
}

/** Whether nothing the gate knows of is under way, for the exported settled wait. */
function quiet(jumpsOnly: boolean): boolean {
  return !jumpUnderWay() && owed === null && (jumpsOnly || search === null || !search.onItsWay || search.landed);
}

function settle(telemetry: TelemetryData | null, now: number): void {
  const reading = readReplay(telemetry);

  if (reading !== null) lastReplay = reading;

  witness = isSeeking(telemetry) && env.inReplay();

  settleOwedSeek(telemetry, now);
  settleTarget(telemetry, now);
  settleTakeover(telemetry, reading, now);

  if (search !== null && reading !== null) judgeSearch(search, reading, now);

  if (search !== null && !search.landed && search.onItsWay && now - search.sentAt >= search.couldRunMs) {
    search.onItsWay = false;
    noteEnd(search.origin, "underWay", "nothing-moved");
    log.debug(`Replay search ${search.kind}: no longer taken to be on its way after ${search.couldRunMs} ms`);
  }

  if (!env.inReplay()) leftReplay();
}

/** The gate's own seek for a jump whose pause window a press took: sent once the pause has read back. */
function settleOwedSeek(telemetry: TelemetryData | null, now: number): void {
  const jump = owed;

  if (jump === null) return;

  const target = pendingReplayTarget();

  if (jump.target === null || target === null || target.id !== jump.target.id || target.sent) {
    owed = null;

    return;
  }

  if (isPaused(telemetry)) {
    owed = null;

    if (sendRaw("setPlayPosition", (r) => r.setPlayPosition(ReplayPosMode.Begin, target.frame))) {
      markReplayTargetSent(target, telemetry, now);
      log.debug(`Replay jump's seek to frame ${target.frame} sent for it: a press took the cursor in its pause`);
    } else {
      clearTarget("cleared", "refused");
    }

    return;
  }

  if (now - jump.owedSince >= readReplayJumpTimeoutMs()) {
    owed = null;
    log.debug(`Replay jump's seek to frame ${target.frame} not sent: the replay did not pause`);
    clearTarget("cleared", "wait-ran-out");
  }
}

function settleTarget(telemetry: TelemetryData | null, now: number): void {
  const settlement = settleReplayTarget(telemetry, now, log);

  if (settlement.kind === "none") return;

  const { target } = settlement;
  const jump = jumpsByTarget.get(target.id);

  jumpsByTarget.delete(target.id);

  if (takeover?.targetId === target.id) takeover = null;

  if (settlement.kind === "read-back") {
    setFate(target.id, { kind: "read-back", telemetry: settlement.telemetry, held: false });
    noteEnd(target.origin, "underWay", "read-back");

    if (jump !== undefined) {
      jump.status = "read-back";
      jump.landing = settlement.telemetry;

      // The step after the landing belongs to where the jump was going, whoever holds the cursor now.
      if (jump.carried && jump.afterLanding !== undefined) runCarried(jump, settlement.telemetry);
    }

    return;
  }

  setFate(target.id, { kind: "gave-up" });
  noteEnd(target.origin, "underWay", env.inReplay() ? "wait-ran-out" : "replay-left");

  if (jump !== undefined) jump.status = "gave-up";
}

function runCarried(jump: HeldJump, landing: TelemetryData): void {
  try {
    jump.afterLanding?.(landing);
  } catch (err) {
    log.debug(`Replay jump's step after the landing threw: ${String(err)}`);
  }
}

/** A takeover's jump lands when the frame has moved and then held, even a few frames off. */
function settleTakeover(telemetry: TelemetryData | null, reading: ReplayReading | null, now: number): void {
  const current = takeover;

  if (current === null) return;

  const target = pendingReplayTarget();

  if (target === null || target.id !== current.targetId) {
    takeover = null;

    return;
  }

  if (reading !== null && reading.frame !== current.fromFrame && telemetry !== null) {
    if (current.moved === null || current.moved.frame !== reading.frame) {
      current.moved = { frame: reading.frame, at: now };
    } else if (now - current.moved.at >= HOLD_GAP_MS) {
      takeover = null;
      clearReplayTarget();
      setFate(target.id, { kind: "read-back", telemetry, held: true });
      noteEnd(target.origin, "underWay", "jump-landed");

      return;
    }
  }

  if (now - current.sentAt >= current.waitMs) {
    log.debug(`Replay takeover: nothing moved within ${current.waitMs} ms`);
    clearTarget("nothing-moved", "nothing-moved");
  }
}

/** Judges a search against one reading of the replay. */
function judgeSearch(record: SearchRecord, reading: ReplayReading, now: number): void {
  if (record.landed) return;

  const { frame, rate } = reading;
  const last = record.last;

  record.last = { frame, at: now };

  if (last === null) {
    record.still = { frame, at: now };

    return;
  }

  if (rate === 0) {
    // Paused: any frame but the one it left from is the landing, once two reads 50 ms apart agree.
    const moved =
      record.fromFrame === null ? frame !== last.frame || record.moved !== null : frame !== record.fromFrame;

    if (!moved) {
      record.moved = null;

      return;
    }

    if (record.moved === null || record.moved.frame !== frame) {
      record.moved = { frame, at: now };
    } else if (now - record.moved.at >= HOLD_GAP_MS) {
      landSearch(record);
    }

    return;
  }

  const elapsed = now - last.at;
  const expected = last.frame + rate * elapsed;
  const tolerance = playbackTolerance(rate, elapsed);

  if (record.moved !== null) {
    const fromMoved = record.moved.frame + rate * (now - record.moved.at);

    if (Math.abs(frame - fromMoved) <= playbackTolerance(rate, now - record.moved.at)) {
      if (now - record.moved.at >= HOLD_GAP_MS) landSearch(record);

      return;
    }

    record.moved = null;
  }

  if (frame !== last.frame && Math.abs(frame - expected) > tolerance) {
    // A leap away from where playback puts it: the landing, once the next read agrees.
    record.moved = { frame, at: now };
    record.still = { frame, at: now };

    return;
  }

  if (record.still !== null && frame === record.still.frame) {
    const standMs = Math.max(HOLD_GAP_MS, 2.5 / Math.abs(rate));

    if (!record.seen && now - record.still.at >= standMs) record.seen = true;

    return;
  }

  record.still = { frame, at: now };

  // Still advancing as playback explains one Fastest Lap Search Delay after the send: it found nothing.
  const advanced = record.fromFrame !== null && Math.sign(frame - record.fromFrame) === Math.sign(rate);

  if (!record.seen && record.onItsWay && advanced && now - record.sentAt >= readFastestLapSearchDelayMs()) {
    record.onItsWay = false;
    noteEnd(record.origin, "underWay", "nothing-moved");
    log.debug(`Replay search ${record.kind}: the replay kept playing; it found nothing`);
  }
}

function landSearch(record: SearchRecord): void {
  record.landed = true;

  if (record.onItsWay) noteEnd(record.origin, "underWay", "landed");

  record.onItsWay = false;
}

/** The replay was left: a search, a takeover and a waiting press end; a standing target waits out its own wait. */
function leftReplay(): void {
  if (search !== null) endSearch("replay-left");

  if (slot !== null && !(slot.behind === "jump" && pendingReplayTarget() !== null)) {
    emptySlot("replay-left", "the replay was left");
  }
}

function disconnect(): void {
  if (search !== null) endSearch("disconnected");

  if (pendingReplayTarget() !== null) clearTarget("cleared", "disconnected");

  emptySlot("disconnected", "the sim disconnected");
  takeover = null;
  owed = null;
  witness = false;
}

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

function holdBehindJump(
  command: SlotCommand,
  options: ReplayPressOptions,
  now: number,
  jumpPlayback: ReplaySpeed | null,
): ReplayPressResult {
  if (slot !== null) emptySlot("replaced");

  slot = {
    command,
    by: options.by,
    origin: options.origin,
    pressedAt: now,
    behind: "jump",
    behindTargetId: pendingReplayTarget()?.id ?? null,
    jumpPlayback,
    restoreSpeed: null,
    holds: [],
  };
  log.debug(`Replay command held: ${describe(command)} (${options.by}) waits for the jump under way to land`);

  return { kind: "held" };
}

/** A press behind a search: it waits, or takes over (rules 1 to 3 of the spec). */
function waitBehindSearch(
  command: SlotCommand,
  options: ReplayPressOptions,
  telemetry: TelemetryData | null,
  now: number,
): ReplayPressResult {
  const record = search;

  if (record === null) return { kind: "not-sent", reason: "no search stands" };

  if (slot !== null && slot.behind === "search") {
    emptySlot("replaced");

    return takeOver(command, options, telemetry, now);
  }

  if (!record.onItsWay) return takeOver(command, options, telemetry, now);

  if (slot !== null) emptySlot("replaced");

  slot = {
    command,
    by: options.by,
    origin: options.origin,
    pressedAt: now,
    behind: "search",
    behindTargetId: null,
    jumpPlayback: null,
    restoreSpeed: null,
    holds: [],
  };
  log.debug(`Replay command held: ${describe(command)} (${options.by}) waits for the ${record.kind} search to land`);

  return { kind: "held" };
}

/**
 * The takeover: a pause if the replay is moving, an absolute jump to the frame
 * beside the reading, judged as moved and then held, and then the press's
 * command. Right whether or not a search was running: into one the jump wins.
 */
function takeOver(
  command: SlotCommand,
  options: ReplayPressOptions,
  telemetry: TelemetryData | null,
  now: number,
): ReplayPressResult {
  const record = search;
  const reading = readReplay(telemetry) ?? lastReplay;

  if (reading === null) {
    log.debug(`Replay command dropped: ${describe(command)} (${options.by}); no frame to take over from`);

    return { kind: "not-sent", reason: "no frame to take over from" };
  }

  const moving = currentSpeed(readReplay(telemetry), now).speed !== 0;
  const restore = record !== null && moving ? record.speedAtSend : null;

  endSearch("forgotten");

  if (moving) dispatch({ kind: "pause" }, telemetry, now, options.origin);

  const endFrame = reading.left === undefined ? undefined : reading.frame + reading.left;
  const beside = frameBeside(reading.frame, endFrame);
  const ok = sendRaw("setPlayPosition", (r) => r.setPlayPosition(ReplayPosMode.Begin, beside));

  log.debug(
    `Replay takeover for ${describe(command)} (${options.by}): jump to frame ${beside} beside ${reading.frame}`,
  );

  if (!ok) return { kind: "taking-over", ok: false };

  const target = recordTarget(beside, telemetry, now, options.origin);

  takeover = {
    targetId: target.id,
    fromFrame: reading.frame,
    sentAt: now,
    waitMs: replayTargetGiveUpMs(1),
    moved: null,
  };

  // The jump is the step; a pause has been sent with it, or there was nothing to pause.
  if (command.kind !== "step" && command.kind !== "pause") {
    slot = {
      command,
      by: options.by,
      origin: options.origin,
      pressedAt: now,
      behind: "jump",
      behindTargetId: target.id,
      jumpPlayback: null,
      restoreSpeed: command.kind === "search" || command.kind === "go-to" ? restore : null,
      holds: [],
    };
  }

  return { kind: "taking-over", ok };
}

/** Acts on the slot after a reading has settled the state. */
function serviceSlot(telemetry: TelemetryData | null, now: number): void {
  const current = slot;

  if (current === null) return;

  if (current.behind === "search") {
    serviceBehindSearch(current, telemetry, now);

    return;
  }

  serviceBehindJump(current, telemetry, now);
}

function serviceBehindSearch(current: Slot, telemetry: TelemetryData | null, now: number): void {
  const record = search;

  if (record === null) {
    emptySlot("forgotten", "the search it waited on was forgotten");

    return;
  }

  if (record.landed) {
    slot = null;
    noteEnd(current.origin, "waiting", "sent-on-landing");
    goOut(current, telemetry, now);

    return;
  }

  if (!record.onItsWay) {
    slot = null;
    noteEnd(current.origin, "waiting", "took-over");
    takeOver(current.command, { by: current.by, origin: current.origin }, telemetry, now);
  }
}

function serviceBehindJump(current: Slot, telemetry: TelemetryData | null, now: number): void {
  const target = pendingReplayTarget();

  if (current.behindTargetId === null) {
    // Behind a seek only the witness showed: a reading that is the replay's again is its landing.
    if (target !== null) {
      current.behindTargetId = target.id;

      return;
    }

    if (witness) return;

    if (readReplay(telemetry) === null) {
      if (!env.inReplay()) emptySlot("replay-left", "the replay was left");

      return;
    }

    afterJumpLanded(current, telemetry, now, false, telemetry);

    return;
  }

  if (target !== null && target.id === current.behindTargetId) return;

  const fate = fates.get(current.behindTargetId);

  if (fate === undefined) {
    // A target nothing recorded the end of: the replay is not known to be anywhere.
    emptySlot("off-target", "the jump it waited on ended unseen");

    return;
  }

  switch (fate.kind) {
    case "replaced":
      if (fate.by !== null && target !== null && target.id === fate.by) {
        current.behindTargetId = fate.by;

        return;
      }

      emptySlot("replaced", "the jump it waited on was replaced");

      return;
    case "read-back":
      afterJumpLanded(current, telemetry, now, fate.held, fate.telemetry);

      return;
    case "nothing-moved":
      emptySlot("nothing-moved", "the takeover's jump moved nothing");

      return;
    case "gave-up":
      emptySlot(env.inReplay() ? "off-target" : "replay-left", "the jump it waited on did not land on its target");

      return;
    case "cleared":
      // The jump's seek never went out, or was refused: it did not land, and a press that waited on it does nothing.
      emptySlot("refused", "the jump it waited on was never sent");

      return;
  }
}

/**
 * The jump a command waited on has read back. A speed goes out on that
 * reading; a search, or anything else, once the reading has held for three
 * reads 50 ms apart — a takeover's landing has held already.
 */
function afterJumpLanded(
  current: Slot,
  telemetry: TelemetryData | null,
  now: number,
  alreadyHeld: boolean,
  landing: TelemetryData | null,
): void {
  const needsHold = current.command.kind === "search" || current.command.kind === "other";

  if (needsHold && !alreadyHeld) {
    const reading = readReplay(telemetry);

    if (reading === null) return;

    const lastHold = current.holds[current.holds.length - 1];

    if (lastHold === undefined) {
      const landed = readReplay(landing);

      current.holds = [{ frame: landed?.frame ?? reading.frame, at: now }];

      return;
    }

    if (now - lastHold.at < HOLD_GAP_MS) return;

    const elapsed = now - lastHold.at;

    if (
      Math.abs(reading.frame - (lastHold.frame + reading.rate * elapsed)) > playbackTolerance(reading.rate, elapsed)
    ) {
      current.holds = [{ frame: reading.frame, at: now }];

      return;
    }

    current.holds.push({ frame: reading.frame, at: now });

    if (current.holds.length < SEARCH_BEHIND_JUMP_READS) return;
  }

  slot = null;
  noteEnd(current.origin, "waiting", "sent-on-landing");
  goOut(current, telemetry ?? landing, now);
}

/** Who is told of a speed or a pause the gate sent from the slot (module wiring, not state). */
const speedSentListeners = new Set<(speed: ReplaySpeed) => void>();

/**
 * Runs `listener` whenever the gate sends a speed or a pause that waited in
 * its slot, with the speed it sent: the surfaces that keep "what this plugin
 * last sent the replay" (the dial's pending speed, the keys' speed cache) take
 * it then, as they would have at the press. Returns the unsubscribe.
 */
export function onReplaySpeedSentFromSlot(listener: (speed: ReplaySpeed) => void): () => void {
  speedSentListeners.add(listener);

  return () => {
    speedSentListeners.delete(listener);
  };
}

function speedOf(command: SlotCommand, telemetry: TelemetryData | null): ReplaySpeed | null {
  switch (command.kind) {
    case "speed":
      return { speed: command.speed, slowMotion: command.slowMotion };
    case "pause":
      return { speed: 0, slowMotion: false };
    case "playback": {
      const wanted = resolveReplayJumpSpeed(readReplayJumpPlayback(), command.captured);
      const live = readReplay(telemetry)?.speed ?? null;

      return live !== null && isSameSpeed(live, wanted) ? null : wanted;
    }
    default:
      return null;
  }
}

/** A waiting command goes out, and what it carries after it waits behind it. */
function goOut(current: Slot, telemetry: TelemetryData | null, now: number): void {
  const sentSpeed = speedOf(current.command, telemetry);
  const ok = dispatch(current.command, telemetry, now, current.origin);

  log.debug(`Replay command sent on the landing: ${describe(current.command)} (${current.by}); result ${ok}`);

  if (ok && sentSpeed !== null) {
    for (const listener of speedSentListeners) {
      try {
        listener(sentSpeed);
      } catch (err) {
        log.debug(`Replay speed listener failed: ${String(err)}`);
      }
    }
  }

  if (!ok || current.command.kind !== "search") return;

  const follow: SlotCommand | null =
    current.jumpPlayback !== null
      ? { kind: "playback", captured: current.jumpPlayback }
      : current.restoreSpeed !== null && current.restoreSpeed.speed !== 0
        ? { kind: "speed", speed: current.restoreSpeed.speed, slowMotion: current.restoreSpeed.slowMotion }
        : null;

  if (follow === null) return;

  slot = {
    command: follow,
    by: current.by,
    origin: current.origin,
    pressedAt: current.pressedAt,
    behind: "search",
    behindTargetId: null,
    jumpPlayback: null,
    restoreSpeed: null,
    holds: [],
  };
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

function busy(): boolean {
  return (
    slot !== null ||
    pendingReplayTarget() !== null ||
    takeover !== null ||
    owed !== null ||
    // A search only while it is taken to be on its way: one that found nothing keeps its record, not the poll.
    (search !== null && !search.landed && search.onItsWay) ||
    witness ||
    views.size > 0
  );
}

function arm(): void {
  if (!busy()) {
    busySince = null;

    return;
  }

  busySince ??= env.now();

  if (timer !== null) return;

  timer = setTimeout(() => {
    timer = null;
    tick();
  }, REPLAY_JUMP_POLL_MS);
}

function tick(): void {
  const now = env.now();

  batch(now, () => {
    if (!env.connected()) {
      disconnect();

      return;
    }

    const telemetry = env.readTelemetry();

    settle(telemetry, now);
    serviceSlot(telemetry, now);
  });
  arm();
}

// ---------------------------------------------------------------------------
// Presses
// ---------------------------------------------------------------------------

/** Takes the replay cursor for a press, as every one-shot command does (`replay-cursor.ts`). */
/**
 * Whether the replay jump that `claim` belongs to still holds the cursor: what
 * keeps its target from being given up by the target's own clock. A claim that
 * was released when the jump ended is no longer held, though nothing cancelled it.
 */
function holdsCursor(claim: ReplayCursorClaim): () => boolean {
  return () => held !== null && held.claim === claim && claim.cancelledBy === null;
}

function takeCursor(by: string): void {
  gateTaking = true;

  try {
    cancelReplayCursorOwner(by);
  } finally {
    gateTaking = false;
  }
}

/**
 * A one-shot press: a key or a dial asks for `command`. Takes the replay
 * cursor, settles what is under way against a fresh reading, and sends,
 * holds, takes over or drops the command by the table in the header. The
 * result says which.
 */
export function pressReplayCommand(command: ReplayGateCommand, options: ReplayPressOptions): ReplayPressResult {
  const now = env.now();
  const telemetry = env.readTelemetry();
  let result: ReplayPressResult = { kind: "not-sent", reason: "nothing decided" };

  batch(now, () => {
    settle(telemetry, now);

    const before = held;
    // Read before the take: taking the cursor clears the speed the jump captured.
    const capturedBySequence = before !== null ? pendingReplayJumpSpeed() : null;

    takeCursor(options.by);
    result = decide(command, options, telemetry, now, before, capturedBySequence);
  });
  arm();

  return result;
}

function decide(
  command: ReplayGateCommand,
  options: ReplayPressOptions,
  telemetry: TelemetryData | null,
  now: number,
  before: HeldJump | null,
  capturedBySequence: { speed: number; slowMotion: boolean } | null,
): ReplayPressResult {
  const underWay = jumpUnderWay();
  const searching = search !== null && !search.landed;

  switch (command.kind) {
    case "jump":
      // A newer word about where the replay should be: whatever waited for the old one goes.
      emptySlot("replaced");

      return { kind: "sent", ok: dispatch(command, telemetry, now, options.origin) };
    case "go-to":
      if (searching && !underWay) return waitBehindSearch(command, options, telemetry, now);

      emptySlot("replaced");

      return { kind: "sent", ok: dispatch(command, telemetry, now, options.origin) };
    case "step": {
      if (underWay) {
        const from = pendingReplayTargetPosition();

        if (from === null) {
          log.debug(`Replay step dropped (${options.by}): a seek shows, and there is no frame to step from`);

          return { kind: "not-sent", reason: "a seek shows with no frame to step from" };
        }

        const move = planFrameMove(command.direction, from);

        if (move.kind !== "jump") return { kind: "not-sent", reason: move.kind === "none" ? move.reason : "no jump" };

        emptySlot("replaced");

        return { kind: "sent", ok: dispatch({ kind: "jump", frame: move.frame }, telemetry, now, options.origin) };
      }

      if (searching) return waitBehindSearch(command, options, telemetry, now);

      emptySlot("replaced");

      return { kind: "sent", ok: dispatch(command, telemetry, now, options.origin) };
    }
    case "pause": {
      const behindSearch = slot?.behind === "search";

      if (underWay) {
        emptySlot("cleared-by-pause");
        log.debug(`Pause not sent (${options.by}): a jump is under way, and the replay is paused for it`);

        return { kind: "not-sent", reason: "the replay is paused for the jump under way" };
      }

      if (before !== null && before.pausedByGate) {
        emptySlot("cleared-by-pause");
        log.debug(`Pause not sent (${options.by}): the replay jump under way has paused the replay`);

        return { kind: "not-sent", reason: "the replay jump under way has paused the replay" };
      }

      if (searching) {
        const moving = currentSpeed(readReplay(telemetry), now).speed !== 0;

        if (!moving) {
          emptySlot("cleared-by-pause");

          return { kind: "not-sent", reason: "the replay is paused" };
        }

        if (!behindSearch) emptySlot("cleared-by-pause");

        return waitBehindSearch(command, options, telemetry, now);
      }

      emptySlot("cleared-by-pause");

      return { kind: "sent", ok: dispatch(command, telemetry, now, options.origin) };
    }
    case "speed":
      if (underWay) return holdBehindJump(command, options, now, null);

      if (searching) return waitBehindSearch(command, options, telemetry, now);

      emptySlot("replaced");

      return { kind: "sent", ok: dispatch(command, telemetry, now, options.origin) };
    case "search":
    case "other":
      if (underWay) {
        return holdBehindJump(command, options, now, command.kind === "search" ? capturedBySequence : null);
      }

      if (searching) return waitBehindSearch(command, options, telemetry, now);

      emptySlot("replaced");

      return { kind: "sent", ok: dispatch(command, telemetry, now, options.origin) };
  }
}

// ---------------------------------------------------------------------------
// Claim holders: the jump sequence, the walk
// ---------------------------------------------------------------------------

/** What became of a claim holder's own send. */
export type ReplayOwnedSendResult = "sent" | "refused" | "skipped" | "cancelled";

/**
 * A command of a driver that holds the replay cursor: the jump sequence's
 * pause and playback step, the fastest-lap walk's probes. Sent at once — the
 * driver keeps its own order and waits — and recorded as any send is. A
 * pause is skipped while a jump is under way that is not the driver's own
 * unsent seek: the replay is paused for it, and a pause would end it.
 */
export function sendOwnedReplayCommand(
  claim: ReplayCursorClaim,
  command: ReplayGateCommand,
  options: { readonly origin?: string } = {},
): ReplayOwnedSendResult {
  if (claim.cancelledBy !== null) return "cancelled";

  const now = env.now();
  const telemetry = env.readTelemetry();
  let result: ReplayOwnedSendResult = "skipped";

  batch(now, () => {
    settle(telemetry, now);

    const origin = options.origin ?? (held?.claim === claim ? held.origin : undefined);

    if (command.kind === "pause") {
      const target = pendingReplayTarget();
      const ownUnsent = target !== null && !target.sent && held?.claim === claim && held.target?.id === target.id;
      const jumpOn = (target !== null && !ownUnsent) || takeover !== null || witness;
      const searchOnPaused = search !== null && !search.landed && currentSpeed(readReplay(telemetry), now).speed === 0;

      if (jumpOn || searchOnPaused) {
        result = "skipped";

        return;
      }

      result = dispatch(command, telemetry, now, origin) ? "sent" : "refused";

      if (result === "sent" && held?.claim === claim) held.pausedByGate = true;

      return;
    }

    if (command.kind === "jump") {
      const ok = sendRaw("setPlayPosition", (r) => r.setPlayPosition(ReplayPosMode.Begin, command.frame));

      result = ok ? "sent" : "refused";

      if (ok) {
        endSearch("forgotten");
        recordTarget(command.frame, telemetry, now, origin, { heldBy: holdsCursor(claim) });
      }

      return;
    }

    result = dispatch(command, telemetry, now, origin) ? "sent" : "refused";
  });
  arm();

  return result;
}

/** A replay jump's handle with the gate, from {@link openReplayJump}. */
export interface ReplayJumpGateHandle {
  readonly claim: ReplayCursorClaim;
  /** The target recorded at the press; null when the jump has no frame of its own (the walk, a search runner). */
  readonly target: ReplayTarget | null;
}

/**
 * Claims the replay cursor for a replay jump, telling the gate the take is a
 * jump's: a jump under way in its pause window then still gets its seek. The
 * one place `beginReplayJump` claims.
 */
export function claimReplayCursorForJump(owner: string, onCancelled?: (by: string) => void): ReplayCursorClaim {
  gateTaking = true;

  try {
    return claimReplayCursor(owner, onCancelled);
  } finally {
    gateTaking = false;
  }
}

/**
 * Opens a replay jump with the gate, at its press, after its claim: it holds
 * the cursor until {@link closeReplayJump}. A jump with a frame records it as
 * the target now, before its pause, so a move made in that window steps on
 * from where the jump is going. Whatever waited in the slot goes (a jump is a
 * newer word about where the replay should be); a jump that sends a position
 * jump forgets a search on its way, since its seek puts the replay right.
 * `afterLanding` is the jump's own step after the landing, which the gate runs
 * on the read-back when a press took the cursor from the jump.
 */
export function openReplayJump(
  claim: ReplayCursorClaim,
  options: {
    readonly frame?: number;
    readonly origin?: string;
    readonly telemetry: TelemetryData | null;
    readonly sendsPositionJump: boolean;
    readonly afterLanding?: (landing: TelemetryData) => void;
  },
): ReplayJumpGateHandle {
  const now = env.now();
  const jump: HeldJump = {
    claim,
    origin: options.origin,
    target: null,
    pausedByGate: false,
    inheritedPause: false,
    owed: false,
    owedSince: 0,
    carried: false,
    afterLanding: options.afterLanding,
    status: "pending",
    landing: null,
  };

  batch(now, () => {
    settle(options.telemetry, now);
    emptySlot("replaced");

    if (options.sendsPositionJump) endSearch("forgotten");

    jump.inheritedPause = pausedForJumpUnderWay(null, options.telemetry);
    held = jump;

    if (options.frame !== undefined) {
      jump.target = recordTarget(options.frame, options.telemetry, now, options.origin, {
        sent: false,
        heldBy: holdsCursor(claim),
      });
      jumpsByTarget.set(jump.target.id, jump);
    }
  });
  arm();

  return jump;
}

/**
 * Records the frame a replay jump opened without one is going to, before its
 * pause: the walk's last jump, once its search has found the frame. As at
 * {@link openReplayJump}, a move made before the seek goes out steps on from
 * there.
 */
export function recordReplayJumpTarget(
  handle: ReplayJumpGateHandle,
  frame: number,
  telemetry: TelemetryData | null,
): void {
  const jump = held !== null && held.claim === handle.claim ? held : null;

  if (jump === null || handle.claim.cancelledBy !== null) return;

  const now = env.now();

  batch(now, () => {
    settle(telemetry, now);

    jump.target = recordTarget(frame, telemetry, now, jump.origin, {
      sent: false,
      heldBy: holdsCursor(handle.claim),
    });
    jump.status = "pending";
    jump.landing = null;
    jumpsByTarget.set(jump.target.id, jump);
  });
  arm();
}

/** Sends the seek of a replay jump opened with a frame. Says what became of it. */
export function sendReplayJumpSeek(handle: ReplayJumpGateHandle): "sent" | "refused" | "cancelled" | "replaced" {
  if (handle.claim.cancelledBy !== null) return "cancelled";

  const own = handle.target;

  if (own === null) return "replaced";

  const now = env.now();
  const telemetry = env.readTelemetry();
  let result: "sent" | "refused" | "cancelled" | "replaced" = "replaced";

  batch(now, () => {
    settle(telemetry, now);

    const target = pendingReplayTarget();

    if (target === null || target.id !== own.id) return;

    if (target.sent) {
      result = "sent";

      return;
    }

    if (!sendRaw("setPlayPosition", (r) => r.setPlayPosition(ReplayPosMode.Begin, target.frame))) {
      result = "refused";
      clearTarget("cleared", "refused");

      return;
    }

    endSearch("forgotten");
    markReplayTargetSent(target, telemetry, now);
    result = "sent";
  });
  arm();

  return result;
}

/**
 * How a replay jump's target stands, settled against `telemetry`: `read-back`
 * with the reading it landed on, `pending`, or how it ended otherwise.
 */
export function replayJumpLanding(
  handle: ReplayJumpGateHandle,
  telemetry: TelemetryData | null,
): { readonly status: JumpLandingStatus; readonly landing: TelemetryData | null } {
  const now = env.now();

  batch(now, () => {
    settle(telemetry, now);
    serviceSlot(telemetry, now);
  });
  arm();

  const jump = handle.target === null ? undefined : findJump(handle);

  return { status: jump?.status ?? "cleared", landing: jump?.landing ?? null };
}

function findJump(handle: ReplayJumpGateHandle): HeldJump | undefined {
  if (held !== null && held.claim === handle.claim) return held;

  if (owed !== null && owed.claim === handle.claim) return owed;

  return closedJumps.get(handle.claim);
}

/** Jumps closed or taken whose status a sequence may still read (weakly held). */
const closedJumps = new WeakMap<ReplayCursorClaim, HeldJump>();

/** How a replay jump ended, for the state seam. */
export type ReplayJumpResult = "landed" | "gave-up" | "cancelled";

/**
 * Closes a replay jump: it no longer holds the cursor. A target whose seek
 * never went out is cleared here, unless a press took the cursor in the pause
 * window and the gate now owes that seek.
 */
export function closeReplayJump(handle: ReplayJumpGateHandle, result: ReplayJumpResult): void {
  const now = env.now();

  batch(now, () => {
    const jump = held !== null && held.claim === handle.claim ? held : null;

    if (jump === null) {
      // Taken already: the take has ended its fact. Only an unsent target nobody owes is left to clear.
      clearUnsent(handle);

      return;
    }

    held = null;
    closedJumps.set(handle.claim, jump);
    noteEnd(
      jump.origin,
      "underWay",
      result === "landed" ? "jump-landed" : result === "gave-up" ? "walk-gave-up" : "claim-taken",
    );
    clearUnsent(handle);
  });
  arm();
}

function clearUnsent(handle: ReplayJumpGateHandle): void {
  const target = pendingReplayTarget();

  if (handle.target === null || target === null || target.id !== handle.target.id || target.sent) return;

  if (owed !== null && owed.claim === handle.claim) return;

  clearTarget("cleared", "refused");
}

// A take of the cursor ends the jump that held it. A press, or another replay jump, leaves the gate owing
// its seek when it was still in its pause; anything else (a car key) sends no replay command, and an
// unsent seek is then never sent.
onReplayCursorTaken(() => {
  const jump = held;

  if (jump === null || jump.claim.cancelledBy !== null) return;

  held = null;
  closedJumps.set(jump.claim, jump);

  const now = env.now();

  batch(now, () => {
    noteEnd(jump.origin, "underWay", "claim-taken");

    const target = pendingReplayTarget();
    const ownTarget = jump.target !== null && target !== null && target.id === jump.target.id;

    if (!gateTaking) {
      jump.carried = false;

      if (ownTarget && target !== null && !target.sent) clearTarget("cleared", "claim-taken");

      return;
    }

    jump.carried = ownTarget;

    if (ownTarget && target !== null && !target.sent) {
      jump.owed = true;
      jump.owedSince = now;
      owed = jump;
    }
  });
  arm();
});

/**
 * Whether the replay has been paused for a jump under way that is not
 * `claim`'s own: a seek shows or a takeover runs; a target whose seek went
 * out stands on a replay that reads paused; or a target whose seek has not
 * gone out belongs to a replay jump that sent its pause. A replay jump that
 * takes over skips its own pause then: a pause sent into the seek would end
 * it where it stands, and one sent in the other jump's pause window is a
 * second pause nobody needs.
 */
export function isReplayPausedForJump(claim: ReplayCursorClaim, telemetry: TelemetryData | null): boolean {
  if (held !== null && held.claim === claim && held.inheritedPause) return true;

  return pausedForJumpUnderWay(claim, telemetry);
}

function pausedForJumpUnderWay(claim: ReplayCursorClaim | null, telemetry: TelemetryData | null): boolean {
  if (takeover !== null || isSeeking(telemetry)) return true;

  const target = pendingReplayTarget();

  if (target === null) return false;

  const owner = jumpsByTarget.get(target.id);

  if (owner !== undefined && owner.claim === claim) return false;

  if (target.sent) return isPaused(telemetry);

  return owner?.pausedByGate === true;
}

/** Hands over a speed that waits in the slot, emptying it: a replay jump that starts takes it as the speed it captured. */
export function takeWaitingReplaySpeed(): ReplaySpeed | null {
  if (slot === null || slot.command.kind !== "speed") return null;

  const { speed, slowMotion } = slot.command;
  const now = env.now();

  batch(now, () => emptySlot("replaced"));
  arm();

  return { speed, slowMotion };
}

/** The speed the replay had when the search standing went out, slow motion included; null with none standing. */
export function replaySearchSpeedAtSend(): ReplaySpeed | null {
  return search === null || search.landed ? null : search.speedAtSend;
}

// ---------------------------------------------------------------------------
// Reads for the surfaces
// ---------------------------------------------------------------------------

/** The speed waiting in the slot, which a surface reads as live: the next speed or pause works from it. */
export function waitingReplaySpeed(): ReplaySpeed | null {
  if (slot === null) return null;

  const { command } = slot;

  if (command.kind === "speed") return { speed: command.speed, slowMotion: command.slowMotion };

  return null;
}

/** Where the replay stands or is headed, by the shared target, from `telemetry`. */
export function readReplayPosition(telemetry: TelemetryData | null): ReplayPosition | null {
  const now = env.now();
  let position: ReplayPosition | null = null;

  batch(now, () => {
    settle(telemetry, now);
    position = resolveReplayPosition(telemetry, now, log);
  });
  arm();

  return position;
}

/** Whether the plugin is moving the replay right now: a jump, a search on its way, a held replay jump, a waiting press. */
export function isReplayMoveUnderWay(): boolean {
  return busy() || (held !== null && held.claim.cancelledBy === null);
}

// ---------------------------------------------------------------------------
// The waits #1426 and #801 build on
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How a settled wait ended. */
export type ReplaySettledOutcome = "settled" | "gave-up" | "superseded";

/**
 * Waits until nothing is under way, shown on `reads` reads 50 ms apart.
 * `jumpsOnly` counts only a jump (a target, a takeover, a seek showing), not a
 * search that has not landed: the form for a camera switch, which a seek
 * swallows and a search does not. With a claim the wait ends superseded when
 * the claim is taken; without one it never does, and a jump that starts
 * meanwhile is simply still under way. `timeoutMs` is the caller's bound.
 */
export async function waitForReplaySettled(options: {
  readonly reads?: number;
  readonly timeoutMs: number;
  readonly claim?: ReplayCursorClaim;
  readonly jumpsOnly?: boolean;
}): Promise<ReplaySettledOutcome> {
  const reads = Math.max(1, options.reads ?? 1);
  const startedAt = env.now();
  let count = 0;

  for (;;) {
    if (options.claim !== undefined && options.claim.cancelledBy !== null) return "superseded";

    const now = env.now();
    const telemetry = env.readTelemetry();

    batch(now, () => {
      settle(telemetry, now);
      serviceSlot(telemetry, now);
    });
    arm();

    count = quiet(options.jumpsOnly === true) ? count + 1 : 0;

    if (count >= reads) return "settled";

    if (now - startedAt >= options.timeoutMs) return "gave-up";

    await sleep(STABILIZATION_POLL_INTERVAL_MS);
  }
}

/**
 * Waits until no jump is under way, for a camera switch a replay jump makes
 * for itself outside its landing step (#1430): iRacing drops a camera change
 * that arrives during a seek, and not one during a search. The bound is the
 * jump's own: the longer of a replay jump's wait and what the standing
 * target's wait has left. A wait that runs out is the caller's to log at
 * debug; it sends the switch anyway.
 */
export async function waitForReplayJumpsToSettle(claim?: ReplayCursorClaim): Promise<ReplaySettledOutcome> {
  const target = pendingReplayTarget();
  const targetLeftMs = target === null ? 0 : Math.max(0, target.sentAt + target.giveUpMs - env.now());

  return waitForReplaySettled({
    jumpsOnly: true,
    timeoutMs: Math.max(readReplayJumpTimeoutMs(), targetLeftMs),
    claim,
  });
}

/** How a wait for a search ended. */
export type ReplaySearchLandingOutcome = "landed" | "found-nothing" | "not-landed" | "gave-up" | "superseded";

/**
 * Waits for the search the gate last sent to land: the frame moved by more
 * than playback explains, then held two reads 50 ms apart. On a paused replay
 * nothing shows a search on its way, so `patienceMs` passing ends the wait as
 * `not-landed` (an unmoved search and a lost one look the same). On a playing
 * replay the wait says more: `found-nothing` when the frame kept advancing a
 * Fastest Lap Search Delay after the send, and once the frame has stood still
 * the search is seen on its way, the patience no longer applies, and the wait
 * goes on to the landing or to `hardBoundMs` (`gave-up`). `superseded` when the
 * claim is taken or another command replaced the search.
 */
export async function waitForReplaySearchLanding(options: {
  readonly patienceMs: number;
  readonly hardBoundMs: number;
  readonly claim?: ReplayCursorClaim;
}): Promise<ReplaySearchLandingOutcome> {
  const record = search;
  const startedAt = env.now();

  if (record === null) return "not-landed";

  for (;;) {
    if (options.claim !== undefined && options.claim.cancelledBy !== null) return "superseded";

    const now = env.now();
    const telemetry = env.readTelemetry();

    batch(now, () => {
      settle(telemetry, now);
      serviceSlot(telemetry, now);
    });
    arm();

    if (record.landed) return "landed";

    if (search !== record) return "superseded";

    if (record.playing && !record.seen && !record.onItsWay) return "found-nothing";

    if (!record.seen && now - startedAt >= options.patienceMs) return "not-landed";

    if (now - startedAt >= options.hardBoundMs) return "gave-up";

    await sleep(REPLAY_JUMP_POLL_MS);
  }
}

/** How long the search standing could still be running (ms); null with none standing. */
export function replaySearchCouldRunMs(): number | null {
  if (search === null || search.landed) return null;

  return Math.max(0, search.sentAt + search.couldRunMs - env.now());
}

/** How a settle by a jump ended. */
export type ReplaySettleByJumpOutcome = "settled" | "nothing-moved" | "superseded";

/**
 * The takeover's own route, for a caller whose search did not land within its
 * patience: a pause if the replay is moving, then an absolute jump to the
 * frame beside the reading, judged as moved and then held. After it a retry
 * or a playback step is safe, whatever the search was doing. `nothing-moved`
 * when nothing moved within the jump's wait; the caller then sends nothing
 * more.
 */
export async function settleReplayByJump(
  options: { readonly claim?: ReplayCursorClaim; readonly origin?: string } = {},
): Promise<ReplaySettleByJumpOutcome> {
  const startNow = env.now();
  const telemetry = env.readTelemetry();
  let targetId: number | null = null;

  batch(startNow, () => {
    settle(telemetry, startNow);

    const reading = readReplay(telemetry) ?? lastReplay;

    if (reading === null) return;

    endSearch("forgotten");

    if (currentSpeed(readReplay(telemetry), startNow).speed !== 0) {
      dispatch({ kind: "pause" }, telemetry, startNow, options.origin);
    }

    const endFrame = reading.left === undefined ? undefined : reading.frame + reading.left;
    const beside = frameBeside(reading.frame, endFrame);

    if (!sendRaw("setPlayPosition", (r) => r.setPlayPosition(ReplayPosMode.Begin, beside))) return;

    const target = recordTarget(beside, telemetry, startNow, options.origin);

    takeover = {
      targetId: target.id,
      fromFrame: reading.frame,
      sentAt: startNow,
      waitMs: replayTargetGiveUpMs(1),
      moved: null,
    };
    targetId = target.id;
  });
  arm();

  if (targetId === null) return "nothing-moved";

  for (;;) {
    await sleep(REPLAY_JUMP_POLL_MS);

    if (options.claim !== undefined && options.claim.cancelledBy !== null) return "superseded";

    const now = env.now();
    const reading = env.readTelemetry();

    batch(now, () => {
      settle(reading, now);
      serviceSlot(reading, now);
    });
    arm();

    const fate = fates.get(targetId);

    if (fate === undefined) continue;

    if (fate.kind === "read-back") return "settled";

    if (fate.kind === "replaced") return "superseded";

    return "nothing-moved";
  }
}

// ---------------------------------------------------------------------------
// The record, and tests
// ---------------------------------------------------------------------------

/** The gate's raw record, for tests and the telemetry snapshot. Read-only. */
export interface ReplayGateRecord {
  readonly busySince: number | null;
  readonly target: ReplayTarget | null;
  readonly seekShowing: boolean;
  readonly search: {
    readonly kind: string;
    readonly direction: 1 | -1;
    readonly sentAt: number;
    readonly origin: string | undefined;
    readonly onItsWay: "seen" | "unknown" | "no";
    readonly couldRunUntil: number;
  } | null;
  readonly jump: { readonly owner: string; readonly origin: string | undefined } | null;
  readonly waiting: {
    readonly command: string;
    readonly pressedAt: number;
    readonly origin: string | undefined;
    readonly behind: "jump" | "search";
  } | null;
}

export function getReplayGateRecord(): ReplayGateRecord {
  return {
    busySince,
    target: pendingReplayTarget(),
    seekShowing: witness,
    search:
      search === null
        ? null
        : {
            kind: search.kind,
            direction: search.direction,
            sentAt: search.sentAt,
            origin: search.origin,
            onItsWay: search.landed || !search.onItsWay ? "no" : search.seen ? "seen" : "unknown",
            couldRunUntil: search.sentAt + search.couldRunMs,
          },
    jump: held === null || held.claim.cancelledBy !== null ? null : { owner: held.claim.owner, origin: held.origin },
    waiting:
      slot === null
        ? null
        : { command: describe(slot.command), pressedAt: slot.pressedAt, origin: slot.origin, behind: slot.behind },
  };
}

/** @internal Replace the environment for tests; `undefined` keys keep the default. */
export function _configureReplayCommandGate(overrides: Partial<ReplayGateEnv>): void {
  env = { ...defaultEnv, ...overrides };
}

/** @internal Reset for tests: state, environment, listeners and the timer. */
export function _resetReplayCommandGate(): void {
  if (timer !== null) clearTimeout(timer);

  timer = null;
  search = null;
  takeover = null;
  slot = null;
  held = null;
  owed = null;
  jumpsByTarget.clear();
  fates.clear();
  speedSent = null;
  witness = false;
  lastReplay = null;
  busySince = null;
  gateTaking = false;
  listeners.clear();
  speedSentListeners.clear();
  views.clear();
  runs.clear();
  batchEnds.clear();
  batchDepth = 0;
  env = defaultEnv;
  log = silentLogger;
  clearReplayTarget();
}
