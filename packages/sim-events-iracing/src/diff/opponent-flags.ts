/**
 * Opponent penalty-flag callouts (issue #936, narrowed by #1274).
 *
 * **Store = truth, qualifier = policy.** This module holds the flag-state
 * STORE: raw decoded per-car penalty flags (`PENALTY_FLAG_MASK` over
 * `CarIdxSessionFlags`) with no hold, no episodes, no cooldowns — the
 * reusable seam (`getLiveOpponentFlags()` in `translator.ts`) reads it
 * directly. On top of the store, this module also owns announcement POLICY:
 * qualification (same class, same lap, nearby in class positions AND within
 * the driver's race-gap range), the per-flag hold, the per-(car, flag)
 * episode latch + re-announce cooldown, `raised` vs `entered-range` trigger
 * classification, and the burst aggregation (`opponentFlagRecentEntries` /
 * distinct-car threshold collapse, the #622 shape — see the aggregation
 * section below).
 *
 * The store advances every tick from the live array length (never a fixed
 * 64 — a real capture showed length 72 with the pace car at index 64) and
 * keeps advancing even while the announce gates are closed, so a gated tick
 * is absorbed rather than replayed once the gate reopens (the
 * `diffOpponentPit` precedent). Three pieces of level-based (not edge-based)
 * per-car cleanup run every tick regardless of gating, since they describe
 * the CURRENT bit state rather than a transition:
 * - `opponentFlagAnnouncedMask[i] &= bits` — a flag's own bit dropping ends
 *   that flag's announced episode (the dedup gate below reads this).
 * - `opponentFlagHeldBackLoggedMask[i] &= bits` — the same for the #1273
 *   "held back" debug line, so it logs once per (car, flag) episode.
 * - `opponentFlagHeldSinceAt.<flag>[i]` — for the two HELD flags, the epoch
 *   ms the bit has been continuously up, kept while it stays up (not reset
 *   every tick), seeded to `now` the tick it's found already up (including
 *   the very first store tick), and cleared to `0` while it's down.
 *
 * **The hold.** Furled must be continuously up for
 * {@link OPPONENT_FLAG_FURLED_DEBOUNCE_MS} (the #669 flicker guard) and Black
 * for {@link OPPONENT_FLAG_BLACK_HOLD_MS} (#1274: a genuine black flag lasts
 * laps, so the hold costs nothing when it is real and filters a blip when it
 * is not) before either is effectively active. Repair and Disqualify are
 * immediate. A drop inside the hold resets it; nothing announces.
 *
 * **`opponentFlagEffectiveMask`** is the fourth level-based per-car value
 * advanced every tick: a bitmask (same bit values as `opponentFlagBits`) of
 * flags that are EFFECTIVELY active — hold-adjusted for Furled and Black,
 * equal to the raw bit for the other two. Comparing this tick's value
 * against the value from the END of the previous tick (captured before this
 * tick overwrites it) is what tells "became effectively active THIS tick"
 * (`raised`) apart from "was already active, something else about this
 * announce just became true" (`entered-range`) — the hold means the raw bit
 * can rise several ticks before the flag is announce-eligible, so a raw-bit
 * transition alone can't drive the trigger label; and because this mask
 * advances unconditionally (like the other store fields), a flag that turns
 * effectively active DURING a gated window is already reflected by the time
 * the gate reopens, so the reopened tick correctly reports `entered-range`
 * rather than replaying a `raised` for an edge that happened several ticks
 * earlier under the gate. One more case reads `entered-range` although the
 * mask transitions: a HELD flag whose continuous-up time began on the seed
 * tick (`opponentFlagSeededAt` — the first store tick, or the first after a
 * replay wipe re-seeds it). It was already up when the store first looked,
 * so its hold clearing three seconds later is not a flag being raised.
 *
 * **Qualification (#1274).** Per non-player/non-pace/in-world car with a
 * pending flag: same class (a readable `CarIdxClass` must match the
 * player's in any session — `isMultiClass` reads false while session info is
 * missing — and in multi-class an unreadable class does not qualify), same
 * lap (lap-progress scores within one lap — the #622 `classify` structure;
 * an unreadable player progress is its own reason), then
 * - `"ahead"`: one to {@link OPPONENT_FLAG_AHEAD_WINDOW} class positions
 *   ahead, and
 * - `"behind"`: exactly one class position behind,
 *
 * each only while the RACE gap — the gap display's own pair reading (#933's
 * crossing time, or the #1285 chaser ETA when the car ahead is crawling),
 * through the injected `getRaceGap(aheadCarIdx, behindCarIdx)` resolver so
 * this module stays a pure function of its inputs — is at most the driver's range
 * (`getRangeSeconds()`, read live once per announce pass). A `null` gap never
 * qualifies: silence is the right failure, a guessed gap is how the #936
 * track-ahead window said false things. There is no hysteresis on the bound;
 * the episode latch already stops a car hovering at it from repeating, so the
 * bound only decides whether the first announce happens — including a flag
 * already up on a car that closes into range later (`entered-range`), or a
 * range the driver widens mid-episode. There is deliberately no class-blind
 * or track-relative path: a flagged car is not a hazard, so a call about a
 * car the driver is not racing is noise.
 *
 * **Announce condition.** Effectively active AND qualified AND that flag's
 * bit not already in `opponentFlagAnnouncedMask` (the per-episode latch) AND
 * opted in AND that flag's per-car cooldown (`opponentFlagCooldownUntil`,
 * {@link OPPONENT_FLAG_CAR_COOLDOWN_MS}) expired. On announce: set the
 * episode-latch bit, stamp the flag's own cooldown (per-flag, so an
 * escalation like black → DQ on the same car is never suppressed by the
 * black cooldown), and emit with `trigger: "raised"` when the flag became
 * effectively active this exact tick (and was not already up at the seed
 * tick), else `"entered-range"` (the level-triggered case: the flag was
 * already active and something else — the qualification, a cooldown, a gate,
 * an opt-in — just cleared). The payload
 * names the car by `carNumber` (session info, omitted when there is no row)
 * and carries the race gap as `gapSeconds`.
 *
 * **Escalation.** iRacing swaps Furled for Black in one transition: the
 * Furled latch drops with its bit and Black then waits its own hold. An
 * escalation is classified `announced & ~bit` at announce time, so one that
 * lands after the earlier flag's bit dropped is announced as a plain flag —
 * which is what it is to the driver.
 *
 * **Gating** (the `diffOpponentPit` precedent): race sessions only,
 * replay-only sessions suppressed, pre-green suppressed (grid/formation
 * positions are meaningless), post-race suppressed (the whole field can
 * carry stale flags after the checkered), and an unresolved player carIdx
 * suppresses everything (qualification is relative to the player). The
 * whole announce pass is skipped while gated; the store (bits, hold timers,
 * effective mask) still advances every tick regardless, so nothing gated
 * ever replays once the gate reopens. The very first tick is handled the
 * same way as a gated tick (seed the store silently, no announce pass) so a
 * flag that's already active before the plugin ever attached doesn't
 * spuriously read as "just activated".
 *
 * **Aggregation (the #622 `diffOpponentPit` shape, per DISTINCT CAR).** A
 * rolling list of `{ at, carIdx }` entries — one per distinct recently-
 * announced car, a later flag on a listed car refreshing its timestamp
 * rather than adding an entry — is pruned to the last
 * {@link OPPONENT_FLAG_AGGREGATE_WINDOW_MS} on every tick; when pruning
 * empties it, `opponentFlagAggregateAnnounced` lowers. Every eligible
 * announce stamps its (car, flag) episode latch + cooldown and
 * refreshes-or-adds the car's window entry. Below
 * {@link OPPONENT_FLAG_AGGREGATE_THRESHOLD} distinct cars the announce goes
 * out individually; the non-escalation announce that brings the
 * DISTINCT-CAR count to the threshold collapses to one `"others"` aggregate
 * instead (setting the flag, once per episode); later would-be individual
 * announces stay silent while the flag is set. The flag — NOT the live
 * count — gates the silence, so pruning below the threshold mid-episode
 * must not resume enumeration; only a full 12 s of quiet does.
 *
 * Two classes of announce are exempt from the collapse:
 * - **Opt-outs never reach it.** The injected `getCalloutEnabled` resolver
 *   (live-read from the plugin's global settings once per pending flag per
 *   pass) is checked before any stamping — and before the race-gap lookup,
 *   which a car whose every pending flag is opted out skips — so a disabled
 *   subject never consumes the aggregation budget and can never redirect an
 *   enabled subject into a collapsed tail. The aggregate line by
 *   construction only ever describes flags the user opted into, which is why
 *   the audio side plays it master-gated but NOT per-flag-gated.
 * - **Escalations always get through.** A further flag on a car that
 *   already has an announced flag this episode (black → DQ) emits
 *   individually even mid-collapse and never counts as a new distinct car:
 *   "the car ahead's penalty just became a disqualification" is per-car
 *   news, not burst noise — and the website docs promise exactly this.
 *
 * **Debug logging (#1273).** Every individual announce writes one debug line
 * naming the car (carIdx and number), the flag, relation and trigger, the
 * raw `CarIdxSessionFlags` in hex, the class positions of the car and the
 * player, the race gap and the car's `CarIdxTrackSurface` — so a support log
 * can show which car a call was about. The announce that trips the burst
 * collapse writes the same fields on its "aggregate announced" line instead,
 * with the distinct-car count. An effectively-active flag that is held back
 * (not in world, class, player progress, lap, positions, gap, opt-out,
 * cooldown, or silenced by an open aggregate episode) writes one "held back"
 * line with its reason, once per (car, flag) episode via
 * `opponentFlagHeldBackLoggedMask`: the FIRST reason is the one logged, a
 * later change of reason is not, and the car still writes its announce line
 * if it qualifies later. Nothing logs at info.
 */
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import {
  classPositionFromOrder,
  decodePenaltyFlags,
  Flags,
  getCarNumberFromSessionInfo,
  PENALTY_FLAG_MASK,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import type { TranslatorState } from "../state.js";
import { coerceSettingNumber } from "./setting-number.js";
import type { EmitFn } from "./types.js";

/** Rolling window for counting recently-announced flagged cars. */
export const OPPONENT_FLAG_AGGREGATE_WINDOW_MS = 12_000;

/** Distinct flagged cars within the window at which enumeration collapses. */
export const OPPONENT_FLAG_AGGREGATE_THRESHOLD = 3;

/** Per-(car, flag) re-announce cooldown — an escalation (black → DQ) is never suppressed by it. */
export const OPPONENT_FLAG_CAR_COOLDOWN_MS = 30_000;

/** How long the Furled bit must stay continuously up before it announces (the #669 flicker guard). */
export const OPPONENT_FLAG_FURLED_DEBOUNCE_MS = 1_000;

/**
 * How long the Black bit must stay continuously up before it announces
 * (#1274). A chosen value, not a measured one — cheap insurance against a
 * blip, since a genuine black flag lasts laps.
 */
export const OPPONENT_FLAG_BLACK_HOLD_MS = 3_000;

/** Ahead window width in class positions. */
export const OPPONENT_FLAG_AHEAD_WINDOW = 3;

/** Fallback race-gap range (s) when no resolver is wired; mirrors `opponentFlagRangeSeconds`' schema default. */
export const OPPONENT_FLAG_DEFAULT_RANGE_SECONDS = 3;
/** Range slider bounds; mirror `opponentFlagRangeSeconds` in the schema. */
export const OPPONENT_FLAG_RANGE_MIN_SECONDS = 1;
export const OPPONENT_FLAG_RANGE_MAX_SECONDS = 10;

/**
 * Sanitize the `opponentFlagRangeSeconds` global setting (#1274). Clamps to
 * the slider's range; anything unparseable — a cleared field included —
 * falls back to the default. Shared by every plugin so the bounds live in
 * exactly one place (the `sanitizeGapAlertThresholdSeconds` shape: no
 * rounding, a stored fractional value is honoured as written).
 */
export function sanitizeOpponentFlagRangeSeconds(value: unknown): number {
  // A cleared field is a MISSING value, not a request for the minimum.
  const n = coerceSettingNumber(value);

  if (n === null) return OPPONENT_FLAG_DEFAULT_RANGE_SECONDS;

  return Math.min(OPPONENT_FLAG_RANGE_MAX_SECONDS, Math.max(OPPONENT_FLAG_RANGE_MIN_SECONDS, n));
}

/** The four per-driver penalty/status bits this module tracks, keyed to their `CarPenaltyFlags` field name. */
type FlagKey = "furled" | "black" | "repair" | "disqualify";

/** The flags that must stay continuously up for a hold before they are effectively active. */
export type HeldOpponentFlagKey = "furled" | "black";

/** Hold per held flag — the table the effective-mask pass reads. */
const OPPONENT_FLAG_HOLD_MS: Record<HeldOpponentFlagKey, number> = {
  furled: OPPONENT_FLAG_FURLED_DEBOUNCE_MS,
  black: OPPONENT_FLAG_BLACK_HOLD_MS,
};

const HELD_FLAG_KEYS: HeldOpponentFlagKey[] = ["furled", "black"];

function isHeldFlag(key: FlagKey): key is HeldOpponentFlagKey {
  return key === "furled" || key === "black";
}

/**
 * Table-driven flag catalog — one entry per bit, no copy-paste per flag in
 * the loops below. Exported so `getLiveOpponentFlags()` (the reusable seam
 * in `translator.ts`) derives its bit→enum mapping from the SAME table the
 * announcer uses — a fifth penalty bit added here reaches both in lockstep.
 */
export const OPPONENT_FLAG_DEFS: Array<{ key: FlagKey; bit: number; flag: OpponentPenaltyFlag }> = [
  { key: "furled", bit: Flags.Furled, flag: OpponentPenaltyFlag.Furled },
  { key: "black", bit: Flags.Black, flag: OpponentPenaltyFlag.Black },
  { key: "repair", bit: Flags.Repair, flag: OpponentPenaltyFlag.Repair },
  { key: "disqualify", bit: Flags.Disqualify, flag: OpponentPenaltyFlag.Disqualify },
];

/**
 * The live inputs the qualifier reads through injected closures, so the diff
 * stays a pure function of its arguments (#936, #1274).
 */
export type OpponentFlagResolvers = {
  /**
   * Per-flag opt-in, live-read per announce. Enforced here — not only at the
   * audio layer — so a disabled subject never consumes the aggregation budget.
   */
  getCalloutEnabled: (flag: OpponentPenaltyFlag) => boolean;
  /**
   * Race gap in seconds between two cars (`getLiveGapBetween` in
   * `translator.ts`: #933's crossing time, or the #1285 ETA reading behind a
   * crawling car — the same reading the gap display uses), or `null` when it
   * cannot be read. `null` never qualifies.
   */
  getRaceGap: (aheadCarIdx: number, behindCarIdx: number) => number | null;
  /** The driver's race-gap range in seconds, live-read once per announce pass (sanitized here too). */
  getRangeSeconds: () => number;
};

/** Why a pending flag did not announce — the #1273 "held back" reason. */
type HeldBackReason =
  | "not-in-world"
  | "class-unreadable"
  | "different-class"
  | "position-unresolved"
  | "player-progress-unreadable"
  | "different-lap"
  | "outside-positions"
  | "gap-unreadable"
  | "gap-over-range"
  | "opted-out"
  | "cooldown"
  | "collapsed";

/** A car that qualifies: its relation, both class positions and the race gap. */
type Qualified = {
  relation: "ahead" | "behind";
  reason?: undefined;
  carPos: number;
  playerPos: number;
  gapSeconds: number;
};

/**
 * A car that does not qualify, with the first check it failed. The positions
 * and gap ride along for the debug line; `0` / `null` when the check that
 * produces them was never reached.
 */
type NotQualified = {
  relation?: undefined;
  reason: HeldBackReason;
  carPos: number;
  playerPos: number;
  gapSeconds: number | null;
};

type Assessment = Qualified | NotQualified;

/**
 * The player's side of every qualification, the same for every car in one
 * announce pass — resolved once per pass rather than once per flagged car
 * (the class position is an O(field) walk).
 */
type PlayerStanding = {
  /** The player's (class) position; `0` when unresolved. */
  pos: number;
  /** The player's lap progress (`CarIdxLapCompleted + CarIdxLapDistPct`); `null` when unreadable. */
  progress: number | null;
};

function resolvePlayerStanding(
  telemetry: TelemetryData,
  positions: number[],
  playerCarIdx: number,
  isMultiClass: boolean,
): PlayerStanding {
  const pos = isMultiClass
    ? classPositionFromOrder(positions, telemetry.CarIdxClass as number[] | undefined, playerCarIdx)
    : (positions[playerCarIdx] ?? 0);
  const lc = telemetry.CarIdxLapCompleted?.[playerCarIdx] ?? -1;
  const dp = telemetry.CarIdxLapDistPct?.[playerCarIdx] ?? -1;

  return { pos, progress: lc < 0 || dp < 0 ? null : lc + dp };
}

/**
 * Qualify a car against the player (issue #1274): same class, same lap, 1–3
 * class positions ahead or exactly one behind, and a race gap within range.
 * The race gap is only looked up once the positions qualify — it is the one
 * check that costs a trace search — and only when `needGap` says some
 * pending flag on the car is opted in: for a car whose every pending flag is
 * opted out the gap could change nothing, so the car reads `opted-out` there.
 *
 * Class: a readable class that differs from the player's never qualifies,
 * whatever `isMultiClass` says — `isMultiClass` is false while session info
 * is missing, and a single-class session's classes are all equal anyway. An
 * unreadable class fails only in a multi-class session, where the class
 * decides the class positions too.
 */
function assess(
  telemetry: TelemetryData,
  positions: number[],
  player: PlayerStanding,
  playerCarIdx: number,
  carIdx: number,
  isMultiClass: boolean,
  getRaceGap: OpponentFlagResolvers["getRaceGap"],
  rangeSeconds: number,
  needGap: boolean,
): Assessment {
  const carClasses = telemetry.CarIdxClass as number[] | undefined;
  const playerClass = carClasses?.[playerCarIdx];
  const carClass = carClasses?.[carIdx];
  const classesReadable = typeof playerClass === "number" && typeof carClass === "number";

  if (isMultiClass && !classesReadable) {
    return { reason: "class-unreadable", carPos: 0, playerPos: 0, gapSeconds: null };
  }

  if (classesReadable && playerClass !== carClass) {
    return { reason: "different-class", carPos: 0, playerPos: 0, gapSeconds: null };
  }

  const carPos = isMultiClass ? classPositionFromOrder(positions, carClasses, carIdx) : (positions[carIdx] ?? 0);
  const playerPos = player.pos;

  if (carPos <= 0 || playerPos <= 0) return { reason: "position-unresolved", carPos, playerPos, gapSeconds: null };

  // Same lap: lap-progress scores within one full lap. Raw `CarIdxLap`
  // equality misbehaves around S/F crossings; the score form is what the
  // position machinery ranks by. The car's own progress passed the caller's
  // in-world test; the player's may still be unreadable — its own reason,
  // since nothing is known about the lap then.
  if (player.progress === null) {
    return { reason: "player-progress-unreadable", carPos, playerPos, gapSeconds: null };
  }

  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;
  const scoreGap = Math.abs((lc?.[carIdx] ?? 0) + (dp?.[carIdx] ?? 0) - player.progress);

  if (scoreGap >= 1.0) return { reason: "different-lap", carPos, playerPos, gapSeconds: null };

  const delta = playerPos - carPos;
  let relation: "ahead" | "behind";

  if (delta >= 1 && delta <= OPPONENT_FLAG_AHEAD_WINDOW) {
    relation = "ahead";
  } else if (delta === -1) {
    relation = "behind";
  } else {
    return { reason: "outside-positions", carPos, playerPos, gapSeconds: null };
  }

  if (!needGap) return { reason: "opted-out", carPos, playerPos, gapSeconds: null };

  const gapSeconds = relation === "ahead" ? getRaceGap(carIdx, playerCarIdx) : getRaceGap(playerCarIdx, carIdx);

  if (gapSeconds === null || !Number.isFinite(gapSeconds)) {
    return { reason: "gap-unreadable", carPos, playerPos, gapSeconds: null };
  }

  if (gapSeconds > rangeSeconds) return { reason: "gap-over-range", carPos, playerPos, gapSeconds };

  return { relation, carPos, playerPos, gapSeconds };
}

/**
 * The car-describing tail shared by the #1273 announce and held-back lines:
 * everything a support log needs to tie a call (or a silence) to one car.
 */
function describeCar(
  telemetry: TelemetryData,
  carIdx: number,
  carNumber: string | null,
  rawFlags: number,
  assessment: Assessment,
  rangeSeconds: number,
): string {
  const surface = (telemetry.CarIdxTrackSurface as number[] | undefined)?.[carIdx];
  const gap = assessment.gapSeconds === null ? "none" : `${assessment.gapSeconds.toFixed(2)}s`;

  return (
    `carIdx=${carIdx} carNumber=${carNumber ?? "none"} sessionFlags=0x${(rawFlags >>> 0).toString(16)} ` +
    `classPos=${assessment.carPos || "none"} playerClassPos=${assessment.playerPos || "none"} ` +
    `raceGap=${gap} range=${rangeSeconds}s surface=${surface ?? "none"}`
  );
}

/**
 * Advance the per-car penalty-flag store and run the announce qualifier for
 * the current tick (issues #936, #1274). `sessionInfo` names the car
 * (`carNumber`); `logger` takes the #1273 debug lines.
 */
export function diffOpponentFlags(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  playerCarIdx: number,
  paceCarIdx: number | null,
  isRaceSession: boolean,
  replayOnlySession: boolean,
  preGreen: boolean,
  postRace: boolean,
  isMultiClass: boolean,
  frozenPositions: number[],
  resolvers: OpponentFlagResolvers,
  now: number,
  emit: EmitFn,
  logger: ILogger = silentLogger,
): void {
  // Prune the aggregation window every tick; a quiet window ends the episode.
  if (state.opponentFlagRecentEntries.length > 0) {
    state.opponentFlagRecentEntries = state.opponentFlagRecentEntries.filter(
      (e) => now - e.at <= OPPONENT_FLAG_AGGREGATE_WINDOW_MS,
    );

    if (state.opponentFlagRecentEntries.length === 0) {
      state.opponentFlagAggregateAnnounced = false;
    }
  }

  const raw = telemetry.CarIdxSessionFlags as number[] | undefined;

  if (!raw) return;

  // The very first tick is handled like a gated tick below: the store still
  // seeds, but nothing announces — a flag already active before the plugin
  // ever attached must not read as "just activated".
  const isFirstTick = !state.opponentFlagsInitialized;

  state.opponentFlagsInitialized = true;

  if (isFirstTick) state.opponentFlagSeededAt = now;

  const bits = state.opponentFlagBits;
  const announced = state.opponentFlagAnnouncedMask;
  const heldBackLogged = state.opponentFlagHeldBackLoggedMask;
  const heldSinceAt = state.opponentFlagHeldSinceAt;
  const effectiveMask = state.opponentFlagEffectiveMask;
  const cooldownUntil = state.opponentFlagCooldownUntil;

  // Effectively-active bits from the END of the previous tick, captured
  // before this tick's loop overwrites `effectiveMask` — the raised-vs-
  // entered-range transition detector below.
  const prevEffective: number[] = [];

  for (let i = 0; i < raw.length; i++) {
    const masked = (raw[i] ?? 0) & PENALTY_FLAG_MASK;

    bits[i] = masked;
    // Level-based, not edge-based: a flag's own bit dropping ends its
    // announced episode (and its held-back log latch) regardless of what
    // else changed this tick.
    announced[i] = (announced[i] ?? 0) & masked;
    heldBackLogged[i] = (heldBackLogged[i] ?? 0) & masked;

    const decoded = decodePenaltyFlags(masked);

    for (const key of HELD_FLAG_KEYS) {
      // Kept while continuously up; seeded to `now` the tick it's first
      // found up (seed tick included — there is no earlier truth to read).
      heldSinceAt[key][i] = decoded[key] ? heldSinceAt[key][i] || now : 0;
    }

    prevEffective[i] = effectiveMask[i] ?? 0;

    let newEffective = 0;

    for (const def of OPPONENT_FLAG_DEFS) {
      const active = isHeldFlag(def.key)
        ? heldSinceAt[def.key][i] > 0 && now - heldSinceAt[def.key][i] >= OPPONENT_FLAG_HOLD_MS[def.key]
        : decoded[def.key];

      if (active) newEffective |= def.bit;
    }

    effectiveMask[i] = newEffective;
  }

  bits.length = raw.length;
  announced.length = raw.length;
  heldBackLogged.length = raw.length;
  effectiveMask.length = raw.length;

  for (const key of HELD_FLAG_KEYS) heldSinceAt[key].length = raw.length;

  const gated = !isRaceSession || replayOnlySession || preGreen || postRace || playerCarIdx < 0;

  if (isFirstTick || gated) return;

  const lc = telemetry.CarIdxLapCompleted;
  const dp = telemetry.CarIdxLapDistPct;
  // Read once per announce pass, and only when some car has something
  // pending — a range change applies from the next pass, never retroactively.
  // The player's standing is the same for every car in the pass, so it is
  // resolved once alongside it.
  let rangeSeconds: number | null = null;
  let player: PlayerStanding | null = null;

  for (let i = 0; i < raw.length; i++) {
    if (i === playerCarIdx || i === paceCarIdx) continue;

    // Only an effectively-active flag whose episode has not announced yet is
    // pending — skip the qualification (and its gap lookup) for everyone else.
    const pending = (effectiveMask[i] ?? 0) & ~announced[i];

    if (pending === 0) continue;

    const range = (rangeSeconds ??= sanitizeOpponentFlagRangeSeconds(resolvers.getRangeSeconds()));

    player ??= resolvePlayerStanding(telemetry, frozenPositions, playerCarIdx, isMultiClass);

    // Opt-outs are enforced HERE, not only at the audio layer: a disabled
    // subject must never stamp state, consume the aggregation budget, or
    // redirect an enabled subject into a collapsed tail. Live-read per pass
    // so a settings toggle takes effect on the next event; a flag re-enabled
    // mid-episode simply announces then (level-trigger). Read before the
    // qualification so a car whose every pending flag is opted out costs no
    // gap lookup.
    let enabledPending = 0;

    for (const def of OPPONENT_FLAG_DEFS) {
      if ((pending & def.bit) !== 0 && resolvers.getCalloutEnabled(def.flag)) enabledPending |= def.bit;
    }

    // In-world test (the race-finish.ts shape) — blipped/vanished/towed cars
    // never qualify.
    const inWorld = (lc?.[i] ?? -1) >= 0 && (dp?.[i] ?? -1) >= 0;
    const assessment: Assessment = inWorld
      ? assess(
          telemetry,
          frozenPositions,
          player,
          playerCarIdx,
          i,
          isMultiClass,
          resolvers.getRaceGap,
          range,
          enabledPending !== 0,
        )
      : { reason: "not-in-world", carPos: 0, playerPos: 0, gapSeconds: null };
    // Resolved lazily: only an announce or a first held-back line needs it.
    let carNumber: string | null | undefined;

    for (const def of OPPONENT_FLAG_DEFS) {
      if ((pending & def.bit) === 0) continue; // not effectively active, or episode already announced

      let heldBack: HeldBackReason | null = null;

      if (assessment.reason !== undefined) {
        heldBack = assessment.reason;
      } else if ((enabledPending & def.bit) === 0) {
        heldBack = "opted-out";
      } else if (now < (cooldownUntil[def.key][i] ?? 0)) {
        heldBack = "cooldown"; // per-(car, flag) cooldown
      }

      if (heldBack !== null) {
        // The #1273 held-back line — once per (car, flag) episode, never per tick.
        if ((heldBackLogged[i] & def.bit) === 0) {
          heldBackLogged[i] |= def.bit;
          carNumber ??= getCarNumberFromSessionInfo(sessionInfo, i);
          logger.debug(
            `Opponent flag held back: flag=${def.flag} reason=${heldBack} ` +
              describeCar(telemetry, i, carNumber, raw[i] ?? 0, assessment, range),
          );
        }

        continue;
      }

      // Only a qualified car gets past the held-back checks above.
      const qualified = assessment as Qualified;
      // `raised` only when the flag became effectively active THIS tick and
      // was not already up when the store seeded: a held flag found up on
      // the seed tick clears its hold later, but nobody saw it rise.
      const seededUp = isHeldFlag(def.key) && heldSinceAt[def.key][i] <= state.opponentFlagSeededAt;
      const activatedThisTick = (prevEffective[i] & def.bit) === 0 && !seededUp;
      const trigger = activatedThisTick ? ("raised" as const) : ("entered-range" as const);
      // A further flag on a car that already has an announced flag this
      // episode — evaluated BEFORE this flag's own latch bit is set.
      const isEscalation = (announced[i] & ~def.bit) !== 0;

      announced[i] |= def.bit;
      cooldownUntil[def.key][i] = now + OPPONENT_FLAG_CAR_COOLDOWN_MS;

      // Distinct-car window bookkeeping: refresh the car's entry if it's
      // already listed (keeping the episode alive), add it otherwise — the
      // collapse threshold counts CARS, never per-(car, flag) announces.
      const existing = state.opponentFlagRecentEntries.find((e) => e.carIdx === i);

      if (existing) {
        existing.at = now;
      } else {
        state.opponentFlagRecentEntries.push({ at: now, carIdx: i });
      }

      // Escalations bypass the collapse entirely (see the module header) —
      // they play individually even while the aggregate episode is open and
      // never trip the distinct-car threshold themselves.
      const individually =
        isEscalation ||
        (!state.opponentFlagAggregateAnnounced &&
          state.opponentFlagRecentEntries.length < OPPONENT_FLAG_AGGREGATE_THRESHOLD);

      carNumber ??= getCarNumberFromSessionInfo(sessionInfo, i);

      const carTail =
        `relation=${qualified.relation} trigger=${trigger} ` +
        describeCar(telemetry, i, carNumber, raw[i] ?? 0, qualified, range);

      if (individually) {
        logger.debug(`Opponent flag announced: flag=${def.flag} ${carTail}`);
        emit({
          event: "opponentFlag.flagged",
          data: {
            relation: qualified.relation,
            carIdx: i,
            flag: def.flag,
            trigger,
            isMultiClass,
            position: qualified.carPos,
            ...(carNumber !== null ? { carNumber } : {}),
            gapSeconds: qualified.gapSeconds,
          },
        });
        continue;
      }

      // Collapsed: the announce that reaches the threshold speaks the
      // aggregate tail, once per episode, and its line says so — naming the
      // car that tripped it; later ones stay silent while the episode flag
      // is set, each logged as held back.
      if (!state.opponentFlagAggregateAnnounced) {
        state.opponentFlagAggregateAnnounced = true;
        logger.debug(
          `Opponent flag aggregate announced: cars=${state.opponentFlagRecentEntries.length} flag=${def.flag} ${carTail}`,
        );
        emit({ event: "opponentFlag.flagged", data: { relation: "others" } });
        continue;
      }

      if ((heldBackLogged[i] & def.bit) === 0) {
        heldBackLogged[i] |= def.bit;
        logger.debug(`Opponent flag held back: flag=${def.flag} reason=collapsed ${carTail}`);
      }
    }
  }
}
