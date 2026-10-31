/**
 * The full-course caution sequence (issue #1127): the pace car's comings and
 * goings, the pickup, the laps behind it, one to go, and the restart.
 *
 * Two unrelated jobs against two unrelated signals, so two functions behind one
 * entry point — {@link diffPaceCar} reads the pace car's track surface,
 * {@link diffCautionEpisode} reads the flags and the leader's crossings, and
 * each seeds its own baselines on the diff's first tick. The lineup is a third
 * reading, of the pace arrays, and lives in `pace-lineup.ts` as a pure
 * function: this module only holds the car it last reported and says when a
 * change is worth reporting ({@link diffLineup}).
 *
 * Every rule here was measured, not assumed — see
 * `docs/superpowers/specs/2026-09-17-issue-1127-oval-caution-restart.md` and the
 * committed fixture in `__fixtures__/caution-restart-20260917.json`.
 *
 * **The pace car's own `CarIdxTrackSurface` is the presence signal**, because
 * nothing else in telemetry answers "where is the pace car". `PaceMode` is
 * sticky — it never read `NotPacing` in the whole capture, holding the last
 * pacing mode straight through green-flag running; the caution bits describe
 * the FLAG rather than the car; and the pace arrays only say who is lined up
 * behind it. The surface is per-car ground truth, and the capture shows it
 * doing exactly one thing per episode: on track about 20 s after the caution is
 * thrown, `AproachingPits` about 5 s before every green. It does that at the
 * rolling start too, which is why the two pace-car events are deliberately
 * generic — nothing about "the pace car reached the track" is caution-specific,
 * and whether the engineer speaks at a given occurrence is the callout's
 * business.
 *
 * **The two halves are independent, and a consumer must not assume otherwise.**
 * The pace-car half needs the pace car's index out of the session YAML; a tick
 * where that cannot be resolved emits neither edge while the episode half
 * narrates on from the flags alone. So an episode can run with one pace-car
 * event, or none — nothing here guarantees a `deployed` / `off` pair brackets a
 * caution.
 *
 * **The episode** is one state machine per caution, driven by `SessionFlags`
 * edges and the leader's scored crossings:
 *
 * - **Waving** — `CautionWaving` is set: the caution is out and the field is
 *   still spread around the track. The bit only ever STARTS an episode: a
 *   re-raise once the field is caught (it is a per-zone bit, like the yellow
 *   one — the follow contract carries a cooldown for that) leaves the phase
 *   where it is, so the pickup below fires at most once per caution and the
 *   crossing baseline it set is never re-anchored. Whether the bit re-raises
 *   at all is unmeasured — it never did in the capture — which is exactly why
 *   the machine must be right under both readings.
 * - **Caught** — `Caution` is set and `CautionWaving` has gone. The pickup is a
 *   flag DE-ESCALATION, not a new yellow, and it lands on the leader's
 *   start/finish crossing about 90 s after the throw (measured at 333.57 and
 *   630.95). A `Caution` that was never preceded by a watched `CautionWaving`
 *   moves to this phase WITHOUT emitting: the pickup is a transition we have to
 *   have seen to report, so a plugin started mid-caution — and a discipline
 *   whose cautions may not wave first — is never told the field has just been
 *   caught.
 * - **One to go** — `OneLapToGreen` rises while caught. It is not a terminal
 *   phase: the flag WITHDRAWN while the caution is still out — a waved-off
 *   restart, or a caution extended after one to go was shown — returns the
 *   episode to caught, so the next leader crossing without the flag is an
 *   extra lap and the next rise is reported as the real one to go. Left
 *   latched, the driver would be released with no warning at all. Whether the
 *   field forms up single or double file is not carried in the event: the
 *   callout reads the lineup at speak time, where `doubleFile` and the lane
 *   already live.
 * - **Restarted** — `Green` rises while a caution is out AND neither caution
 *   bit is set on that tick. Both captures show every caution bit dropping on
 *   the restart tick (oval `0x10044600` → `0x80040004`; the road course's
 *   466.95 carries no `Caution` bit), and the second half of the test is what
 *   keeps a yellow-checkered tick — `Green` rising with `Caution` still set —
 *   from being called a restart: "Green, green, green! Go, go, go!" to a
 *   driver who must not go is the worst thing this module can say. A green
 *   that rises with a caution bit still set is therefore NOT the restart,
 *   whatever else it is, and the phase carries on until the bits drop, when
 *   it expires with no event (below). Deliberately not gated on `StartGo`: a
 *   restart does carry it (which is why the green-flag callout has never
 *   spoken at one), but nothing here needs to tell a restart apart from a
 *   race start — a race start finds no caution phase to end. The tick is also
 *   stamped (`cautionRestartedAt`), which is what lets `diffStartLights` hold
 *   the race-start line down for a `StartGo` that trails the green by a tick.
 *   The cost, accepted: an unmeasured ordering where the green rises a tick
 *   BEFORE the caution bits drop announces no restart at all — the episode
 *   expires silently on the later tick. Silence is the cheaper wrong.
 *
 * **The phase also EXPIRES**, the moment neither caution bit is set, and that
 * is a safety property rather than a tidy-up. A green rising edge is not a
 * reliable end marker: the tick that re-seeds after a replay glance swallows
 * every edge it spans, and glancing at the replay to see the incident is
 * ordinary driver behaviour under a yellow. A phase left standing would call
 * every green-flag leader crossing for the rest of the session an extra lap
 * under caution. The expiry is therefore what guarantees that a live phase
 * means a caution bit is still set — `Caution`, or `CautionWaving` re-raised
 * on its own after the pickup — and the SEED applies it too, which is what
 * makes that guarantee hold on every tick rather than on every tick but the
 * first one back from a replay — see {@link diffCautionEpisode}. What it does
 * NOT guarantee is that no green is flying: the yellow-checkered case above
 * keeps a caution bit set under a green, and a phase that merely survived that
 * tick is still `"caught"`. So the extra-lap branch, and the silent entry
 * into `"caught"`, each refuse a tick with `Green` set — a lap under a flying
 * green is not a caution lap, whatever the caution bits say.
 *
 * **The pickup consumes the crossing it landed on.** The static flag precedes
 * the leader's `CarIdxLapCompleted` increment by about half a second in both
 * captured cautions (333.57 → 334.07, 630.95 → 631.43), so counting that
 * increment would report an extra lap at every single pickup. The baseline used
 * is the leader's PRE-pickup lap rather than the current one, which is strictly
 * the better of the two — identical on the measured ordering, and still exact
 * if the counter were ever scored on the same tick as the flag. It does NOT
 * make the rule ordering-proof: were the counter scored on an EARLIER tick than
 * the flag, the pickup would swallow its own crossing and the next genuine one.
 * Nothing measured does that. A leader whose identity changes across the pickup
 * tick can swallow two crossings the same way.
 *
 * **Neither way into `caught` may leave the baseline behind the leader.** The
 * pre-pickup reading is only as fresh as the last tick that could read a leader
 * at all, which with no canonical order means the last tick carrying a lineup —
 * so a green stretch freezes it, and it can reach a later caution reading laps
 * out of date. That would land as a caution that had already run every green
 * lap since. The pickup therefore clamps to what the leader has scored, and a
 * caution that arrives already static re-anchors on it outright: an episode the
 * diff never watched begin has no laps of its own behind it yet.
 *
 * **The one-to-green lap has a checkpoint of its own, at 35% of the PLAYER's
 * lap** — `caution.lastLapCheckpoint`, the moment the position call is made.
 * It is the first upward crossing of {@link LAST_LAP_CHECKPOINT_PCT} in
 * the player's `LapDistPct` after `caution.oneLapToGreen`, while the phase is
 * still `"one-to-go"`. Why that lands on the right lap for everyone: the field
 * is packed behind the pace car, and the one-to-go flag rises at the LEADER's
 * crossing, so a mid-pack player is usually at ~0.9–1.0 of the lap before when
 * it does — their own start/finish crossing comes a few seconds later, and the
 * first time their distance RISES through 0.35 after the flag is therefore on
 * the one-to-green lap itself. For the leader, whose distance is ~0 at the
 * flag, it is the same lap. Fired at most once per one-to-green lap: the flag
 * withdrawn and re-raised (the waved-off restart below) re-arms it for the new
 * final lap, and a green that arrives first leaves nothing to fire. It
 * carries nothing: the position spoken is the RACE position, read live by the
 * callout from the canonical order (`getLivePosition`), not the lineup's
 * restart position — a lapped car lined up ahead of you is behind you in the
 * race, and the 2026-09-19 snapshot had the two a place apart (20 in the
 * lineup, 19 in the race, 19 on the display). A payload nothing reads would be
 * a published field maintained for no one, so there is none.
 *
 * **An extra lap is the ABSENCE of a signal.** Any later leader crossing that
 * arrives while still caught, with `OneLapToGreen` clear, is a lap the caution
 * did not need: the default at the pickup is two laps, iRacing accepts an
 * extension only after a full lap behind the pace car, and no field carries the
 * count (`ResultsNumCautionFlags` / `ResultsNumCautionLaps` stayed 0
 * mid-caution). So the one-to-go flag either comes at a crossing or it does
 * not, and its absence is the extension — no knowledge of who pressed
 * `!pacelaps` is needed, or available.
 *
 * **The leader comes from the canonical race order**, like every other position
 * in this package (`@.claude/rules/race-positions.md`). The pace lineup is the
 * fallback for a tick with no canonical order, and reading it takes care: pace
 * rows are numbered PER LINE, so once the field re-forms double file row 1
 * holds TWO cars — the leader on line 0 and the car alongside on line 1 — and
 * row 0 on line 1 is a racing car rather than the pace car. The front of the
 * lineup is therefore line 0, row 1. (That the lineup, not the official
 * positions, is the authority for the RESTART order is a separate documented
 * exception, and belongs to `pace-lineup.ts`, which also carries the
 * interleave the two lines restart in and why the pace car anchors it.)
 *
 * **Catch-up is a fourth reading, with an episode of its own** (issue #1168):
 * the player dropped back from the car he lines up behind. The measurement is
 * `caution-gap.ts`'s — the gap as a multiple of the pack's own spacing — and
 * {@link diffCatchUp} here holds what a measurement cannot: the dwell that
 * swallows a transient, the hysteresis between raising and clearing, the
 * reminder clock, and the two latches that say whether the gap means "you are
 * lagging" at all. It runs on the lineup {@link diffLineup} resolved, so a
 * tick resolves the lineup once and never under green.
 *
 * It is **level-armed**: every tick decides from the gap as it is now, so a
 * re-seed — a plugin restart, an SDK reconnect, a replay glance — cannot leave
 * an open gap with no edge left to fire on (the #951 lesson). The cost is
 * stated where it is paid: after a glance a driver already reminded twice gets
 * a fresh first call. Nothing speaks while the caution waves, in the settle
 * window after the pickup, or inside a dwell, so the first call a caution can
 * produce lands at least `CATCH_UP_SETTLE_MS + CATCH_UP_DWELL_MS` after the
 * pickup. It does NOT stop at one to green — the last caution lap is exactly
 * when being in place matters — and stops when the pace car leaves.
 */
import type { SimEventName } from "@iracedeck/event-bus";
import { Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { isOvalTrack } from "../track-type.js";
import { type CautionGapMeasurement, measureCautionGap } from "./caution-gap.js";
import { resolvePaceCarIdx } from "./pace-laps.js";
import { type PaceLineup, type PaceLineupFlags, resolvePaceLineup } from "./pace-lineup.js";
import { isRacingSurface } from "./track-surface.js";
import type { EmitFn } from "./types.js";

/**
 * How far into the one-to-green lap the player's `LapDistPct` must rise for
 * `caution.lastLapCheckpoint` to fire. Far enough past the start/finish line
 * that the double-file re-form (on the tick before the flag) and the
 * one-lap-to-green call itself are behind the driver; well short of the pace car
 * peeling off (~5 s before the green), so the position lands with time to
 * take in.
 */
export const LAST_LAP_CHECKPOINT_PCT = 0.35;

/**
 * The ratio — the player's gap to the car he follows over the pack's spacing —
 * at or above which the gap counts as OPEN (issue #1168). PROVISIONAL: capture
 * C1 sets it, to the ratio at which iRacing's own "catch up" message appears,
 * rounded down to 0.25 and clamped to [2.0, 3.4]. The snapshots bound it
 * already: the widest gap between two cars in place is 1.55× and the smallest
 * dropped-back reading 3.4×, and 2.5 sits between them with margin both ways.
 */
export const CATCH_UP_RAISE_MULTIPLE = 2.5;

/**
 * The ratio below which an open gap counts as CLOSED again. PROVISIONAL:
 * capture C1 sets it, from the ratio at which iRacing's message disappears,
 * bounded to [1.75, raise − 0.25]. Below the raise multiple so a gap hovering
 * at one threshold cannot flap, and above the widest normal reading (1.55×) so
 * a car that has genuinely closed up is never still "open".
 */
export const CATCH_UP_CLEAR_MULTIPLE = 1.75;

/**
 * How long the ratio must stay at or above the raise multiple, continuously,
 * before the gap is reported. PROVISIONAL: capture C1 sets it, to the longest
 * excursion above the raise multiple by any car other than the player at the
 * pickup and at the double-file re-form, plus one second, never below 2 s. It
 * is what swallows the re-form at one to go — `caution-gap-20261002.json` has
 * the player at 7.4× on the re-form tick and 1.9× 8.6 s later, so three
 * seconds is a floor the first real recording is expected to raise — and any
 * one-tick transient: a crossing tick, a row reassignment.
 */
export const CATCH_UP_DWELL_MS = 3_000;

/**
 * How long after the phase first becomes `"caught"` before a gap is judged at
 * all. PROVISIONAL: capture C1 sets it, to the time from the pickup until the
 * pack spacing first comes within 20 % of its one-to-go value, rounded up to
 * 5 s, never below 5 s. The pickup lands on the LEADER's crossing while the
 * tail may still be compacting — two tail cars read 1.55× six seconds before
 * the whole line was inside 12.3 m — and the pickup's own calls hold the floor
 * then anyway.
 */
export const CATCH_UP_SETTLE_MS = 10_000;

/**
 * How long after one call before the next may be made while the gap stays
 * open. Not capture C1's: confirmed by the maintainer (2026-09-19), with the
 * count below. Measured from the moment a reminder is DUE and judged — whether
 * or not it spoke — never from a missed due time (the #951 rule), so a
 * held-back reminder cannot drain as a burst.
 */
export const CATCH_UP_REMINDER_MS = 30_000;

/** How many reminders one open gap may produce. Confirmed with {@link CATCH_UP_REMINDER_MS}; capture C1 does not set it. */
export const CATCH_UP_MAX_REMINDERS = 2;

/**
 * How long after the player leaves pit road under caution before his gap is
 * judged: the time to get up to speed. PROVISIONAL, and unmeasured — no
 * capture shows a stop under caution, and capture C1 as specified does not
 * include one. A recording of a pit exit under caution is what sets it.
 */
export const CATCH_UP_PIT_EXIT_GRACE_MS = 10_000;

/**
 * How long a stretch of ticks that could not be judged may be before a clock
 * that needs CONTINUITY — the dwell, a suspense, the drive-round's in-place
 * time — is taken to have been interrupted and starts again. Not a threshold
 * of the call and not capture C1's: it is "a dropped tick or two is not an
 * interruption", sized far above the SDK's 16 ms tick and far below the
 * shortest window it guards (the three-second dwell). Without it two readings
 * ten seconds apart would stand in for "three seconds continuously".
 */
export const CATCH_UP_UNJUDGED_TOLERANCE_MS = 1_000;

/**
 * One reason catch-up cannot be judged on a tick — see {@link resolveCatchUpBlocks}.
 *
 * Each is HARD or SOFT, and the difference is what it does to an episode that
 * is already running ({@link diffCatchUp}). A hard block ends it at once. A
 * soft block only SUSPENDS it, and ends it once the block has held for
 * {@link CATCH_UP_DWELL_MS}: a soft block can blink — one tick of a pace car's
 * surface reading a pit surface — and an episode reset by a blink speaks its
 * first call and both reminders all over again.
 *
 * Hard — the condition cannot blink, or cannot arise while an episode runs:
 *
 * - `phase`: the caution is not `"caught"` or `"one-to-go"`. A waving field
 *   is not a pack, and the phase is the translator's own state machine, which
 *   moves on flag edges it has already debounced.
 * - `green`: a `Green` bit is set. A yellow-checkered tick keeps the phase
 *   alive under a flying green, and under a green nothing is said.
 * - `settling`: inside {@link CATCH_UP_SETTLE_MS} of the pickup. It precedes
 *   every episode of a caution and cannot return.
 * - `pit-exit-grace`: inside {@link CATCH_UP_PIT_EXIT_GRACE_MS} of leaving pit
 *   road after a stop. A stop long enough to open the grace has already ended
 *   any episode, by holding the `pit-road` block.
 *
 * Soft — the reading can flicker, or the condition can be withdrawn:
 *
 * - `green-held`: `GreenHeld` is set. The pace car may pull away on purpose
 *   from here and the green-held line owns the moment, for every car and not
 *   only the pair with the pace car. iRacing can withdraw the bit.
 * - `pit-road`: the player is on pit road. Dropping back there is the speed
 *   limit, not a lag — and a car running low can clip the pit lane for a tick.
 * - `procedure`: the player carries a pace flag and has not yet taken his
 *   slot — a drive-round in progress.
 * - `pace-car-off`: the pace car is not on the road. Once it peels off the
 *   field is seconds from the green, and gaps open on purpose.
 * - `ahead-of-slot`: the car to follow is nearer behind him than ahead.
 */
export type CatchUpBlock =
  | "phase"
  | "green"
  | "settling"
  | "pit-exit-grace"
  | "green-held"
  | "pit-road"
  | "procedure"
  | "pace-car-off"
  | "ahead-of-slot";

/** The blocks that end a running episode at once — see {@link CatchUpBlock}. Every other block is soft. */
const HARD_CATCH_UP_BLOCKS: ReadonlySet<CatchUpBlock> = new Set(["phase", "green", "settling", "pit-exit-grace"]);

/** Whether a block ends a running episode at once rather than suspending it. */
export function isHardCatchUpBlock(block: CatchUpBlock): boolean {
  return HARD_CATCH_UP_BLOCKS.has(block);
}

/** The player is being sent round to the tail: any of the three pace flags. */
function inDriveRound(paceFlags: PaceLineupFlags): boolean {
  return paceFlags.wavedAround || paceFlags.freePass || paceFlags.endOfLine;
}

/**
 * The blocks that can be read WITHOUT measuring the field: the phase, the
 * flags, the clocks, pit road, and — given the player's pace flags, which a
 * tick with no lineup does not have — the drive-round. {@link diffCatchUp}
 * asks these first, so a tick they already decide never pays for the
 * measurement.
 */
function resolveStateBlocks(
  state: TranslatorState,
  telemetry: TelemetryData,
  paceFlags: PaceLineupFlags | null,
  now: number,
): CatchUpBlock[] {
  const blocks: CatchUpBlock[] = [];
  const flags = telemetry.SessionFlags ?? 0;
  const caught = state.cautionPhase === "caught" || state.cautionPhase === "one-to-go";

  if (!caught) blocks.push("phase");

  if (hasFlag(flags, Flags.Green)) blocks.push("green");

  // Only a caught phase has a pickup to settle from.
  if (caught && (state.cautionCaughtAt === null || now - state.cautionCaughtAt < CATCH_UP_SETTLE_MS)) {
    blocks.push("settling");
  }

  const pitExitAt = state.cautionCatchUpPitExitAt;

  if (pitExitAt !== null && now - pitExitAt < CATCH_UP_PIT_EXIT_GRACE_MS) blocks.push("pit-exit-grace");

  if (hasFlag(flags, Flags.GreenHeld)) blocks.push("green-held");

  if (telemetry.OnPitRoad === true) blocks.push("pit-road");

  if (paceFlags !== null && inDriveRound(paceFlags) && !state.cautionProcedureJoined) blocks.push("procedure");

  return blocks;
}

/**
 * Every reason catch-up cannot be judged on this tick; empty when it is LIVE.
 * The one statement of "live", asked by {@link diffCatchUp} to decide whether
 * an episode may run and by the translator's `getCautionGap()` to answer
 * `warranted`, so the diff that emits and the gate that speaks cannot disagree
 * about the same tick.
 *
 * A list rather than a boolean because the reasons are independent and more
 * than one usually holds — the waved-around car of the 2026-09-19 capture is
 * blocked three ways at once — and the Telemetry Snapshot shows which.
 *
 * Reads the translator's latches and takes `now` for the two clocks; changes
 * nothing. Two conditions of the design are not here because they are not
 * "blocks" but the absence of a reading: a player who holds no row has no
 * lineup to measure, and a gap or a spacing that cannot be read has no ratio.
 */
export function resolveCatchUpBlocks(
  state: TranslatorState,
  telemetry: TelemetryData,
  measurement: CautionGapMeasurement,
  now: number,
): CatchUpBlock[] {
  const blocks = resolveStateBlocks(state, telemetry, measurement.paceFlags, now);

  if (!measurement.paceCarOnTrack) blocks.push("pace-car-off");

  // Waived within a pit-exit episode: a car that stopped while the field
  // circulated can have the tail anywhere up the road, and "catch car N" is
  // exactly what tells him which car that is.
  if (measurement.aheadOfSlot && state.cautionCatchUpPitExitAt === null) blocks.push("ahead-of-slot");

  return blocks;
}

/** Whether a clock that needs continuity was interrupted: no tick has confirmed it for longer than the tolerance. */
function interrupted(seenAt: number | null, now: number): boolean {
  return seenAt === null || now - seenAt > CATCH_UP_UNJUDGED_TOLERANCE_MS;
}

/** Nothing is suspended and no other car is being watched. */
function endCatchUpSuspense(state: TranslatorState): void {
  state.cautionCatchUpSuspendedSince = null;
  state.cautionCatchUpSuspendedSeenAt = null;
  state.cautionCatchUpCandidateCarIdx = null;
  state.cautionCatchUpCandidateRaisedSince = null;
  state.cautionCatchUpCandidateSeenAt = null;
}

/** The catch-up episode back to nothing: no dwell running, no gap open, no call made, nothing suspended. */
function endCatchUpEpisode(state: TranslatorState): void {
  state.cautionCatchUpFollowCarIdx = null;
  state.cautionCatchUpRaisedSince = null;
  state.cautionCatchUpRaisedSeenAt = null;
  state.cautionCatchUpOpen = false;
  state.cautionCatchUpLastCallAt = null;
  state.cautionCatchUpLastCallGapMeters = null;
  state.cautionCatchUpReminders = 0;
  endCatchUpSuspense(state);
}

/** The pit-exit episode over: the player is an ordinary car in the lineup again. */
function endPitExitEpisode(state: TranslatorState): void {
  state.cautionCatchUpPitExitAt = null;
  state.cautionCatchUpPitExitCalled = false;
}

/** What the drive-round latch has observed so far, forgotten: the latch itself is untouched. */
function forgetDriveRound(state: TranslatorState): void {
  state.cautionProcedureAwaySeen = false;
  state.cautionProcedureInPlaceCarIdx = null;
  state.cautionProcedureInPlaceSince = null;
  state.cautionProcedureInPlaceSeenAt = null;
}

/**
 * What of catch-up lives and dies with the caution phase: the drive-round
 * latch, the pickup's timestamp and the pit-exit episode. Cleared when no
 * caution is out — here on every tick, and on the seed tick too, so a caution
 * that ended while the driver looked at the replay cannot leave any of them
 * behind (all three ride through the replay wipe). The pit-road baseline is
 * not the phase's: it follows the player whether a caution is out or not.
 */
function expireCatchUpWithPhase(state: TranslatorState): void {
  if (state.cautionPhase !== "none") return;

  state.cautionProcedureJoined = false;
  state.cautionCaughtAt = null;
  forgetDriveRound(state);
  endPitExitEpisode(state);
  endCatchUpEpisode(state);
}

/**
 * The drive-round latch: has a player who carries a pace flag TAKEN HIS SLOT.
 *
 * A single reading of "a flag is set and the gap is under the clear multiple"
 * cannot say so. On the tick the flag first appears he may still sit at
 * normal spacing in his OLD slot, a tick before his row moves to the tail —
 * whether iRacing sets the bit before or after it moves the rows is
 * unmeasured — and a latch set there would lift the suppression for the whole
 * drive round, with the tail car hundreds of metres up the road and "catch
 * car N" three seconds away. So joining needs one of two things, both with a
 * flag set:
 *
 * - **The drive round was seen, and has ended.** A reading at or above the
 *   raise multiple, or the car ahead of his slot, and after it a reading under
 *   the clear multiple.
 * - **He has been in place all along.** The gap under the clear multiple to
 *   the SAME car continuously for {@link CATCH_UP_SETTLE_MS}. This is the
 *   plugin started mid-caution with the player already at the tail and still
 *   carrying the flag (`caution-lineup-20260919.json`), who must not be
 *   silenced for the rest of the caution; and it is what a flag that appeared
 *   a tick early can never satisfy, since his car changes with his row.
 *
 * Runs in every caution phase. A tick with no flag forgets what was observed:
 * the next flag is a procedure of its own.
 */
function trackDriveRound(state: TranslatorState, measurement: CautionGapMeasurement, now: number): void {
  const { ratio, followCarIdx } = measurement;

  if (measurement.aheadOfSlot || (ratio !== null && ratio >= CATCH_UP_RAISE_MULTIPLE)) {
    state.cautionProcedureAwaySeen = true;
    state.cautionProcedureInPlaceSince = null;

    return;
  }

  // Nothing to judge by this tick: what was observed stands.
  if (ratio === null || followCarIdx === null) return;

  if (ratio >= CATCH_UP_CLEAR_MULTIPLE) {
    // The band: neither away nor in place.
    state.cautionProcedureInPlaceSince = null;

    return;
  }

  if (state.cautionProcedureAwaySeen) {
    state.cautionProcedureJoined = true;
    forgetDriveRound(state);

    return;
  }

  if (
    state.cautionProcedureInPlaceSince === null ||
    state.cautionProcedureInPlaceCarIdx !== followCarIdx ||
    interrupted(state.cautionProcedureInPlaceSeenAt, now)
  ) {
    state.cautionProcedureInPlaceCarIdx = followCarIdx;
    state.cautionProcedureInPlaceSince = now;
  }

  state.cautionProcedureInPlaceSeenAt = now;

  if (now - state.cautionProcedureInPlaceSince >= CATCH_UP_SETTLE_MS) {
    state.cautionProcedureJoined = true;
    forgetDriveRound(state);
  }
}

/**
 * A tick on which a running episode cannot be judged FOR A REASON — a soft
 * block, or a different car ahead — rather than for want of a reading. The
 * episode goes into suspense: nothing is emitted, and its clocks and its
 * reminder count are kept, so that the original car and liveness returning
 * resume it exactly as it was. Only once the disturbance has held for
 * {@link CATCH_UP_DWELL_MS} does the episode end.
 *
 * `candidate` is the other car, when the disturbance is one: its own dwell is
 * counted WHILE the suspense runs, so a real change of the car ahead does not
 * cost two dwells. With the gap to the new car at the raise multiple from the
 * tick it appears, the old episode ends and the new car's first call is made
 * on the same tick, one dwell after the change — what a change cost before
 * there was a suspense at all.
 *
 * Returns whether the episode was re-keyed to the candidate, in which case
 * the caller goes on to judge the tick for it.
 */
function suspendCatchUp(
  state: TranslatorState,
  now: number,
  candidate: { carIdx: number; ratio: number } | null,
): boolean {
  // Nothing running: nothing to suspend, and nothing a blink could cost.
  if (state.cautionCatchUpFollowCarIdx === null) return false;

  if (state.cautionCatchUpSuspendedSince === null || interrupted(state.cautionCatchUpSuspendedSeenAt, now)) {
    state.cautionCatchUpSuspendedSince = now;
  }

  state.cautionCatchUpSuspendedSeenAt = now;

  if (candidate === null) {
    // Blocked: nobody's gap is being judged, so no other car's dwell runs.
    state.cautionCatchUpCandidateCarIdx = null;
    state.cautionCatchUpCandidateRaisedSince = null;
    state.cautionCatchUpCandidateSeenAt = null;
  } else {
    if (state.cautionCatchUpCandidateCarIdx !== candidate.carIdx) {
      state.cautionCatchUpCandidateCarIdx = candidate.carIdx;
      state.cautionCatchUpCandidateRaisedSince = null;
    }

    if (candidate.ratio < CATCH_UP_RAISE_MULTIPLE) {
      state.cautionCatchUpCandidateRaisedSince = null;
    } else if (
      state.cautionCatchUpCandidateRaisedSince === null ||
      interrupted(state.cautionCatchUpCandidateSeenAt, now)
    ) {
      state.cautionCatchUpCandidateRaisedSince = now;
    }

    state.cautionCatchUpCandidateSeenAt = now;
  }

  if (now - state.cautionCatchUpSuspendedSince < CATCH_UP_DWELL_MS) return false;

  // The disturbance has held: the episode is over.
  const raisedSince = candidate === null ? null : state.cautionCatchUpCandidateRaisedSince;

  endCatchUpEpisode(state);

  if (candidate === null) return false;

  // Re-keyed to the new car, with the dwell it has already served.
  if (raisedSince !== null) {
    state.cautionCatchUpFollowCarIdx = candidate.carIdx;
    state.cautionCatchUpRaisedSince = raisedSince;
    state.cautionCatchUpRaisedSeenAt = now;
  }

  return true;
}

/**
 * The catch-up episode: one continuous stretch of an open gap to one car.
 *
 * Runs on every tick the caution diff does not seed on, handed the lineup
 * {@link diffLineup} resolved — `null` when it resolved none (no caution
 * phase, a `Green` bit, or a player who holds no row). It measures only when
 * something reads the measurement: a tick that a hard block, or a soft block
 * readable from the flags alone, already decides is not measured at all, and
 * neither is any tick under green. The exception is a player who carries a
 * pace flag and has not joined, whose drive-round latch reads the gap in
 * every caution phase.
 *
 * **Open, remind, close.** With catch-up live ({@link resolveCatchUpBlocks})
 * the episode OPENS once the ratio has stayed at or above
 * {@link CATCH_UP_RAISE_MULTIPLE} for {@link CATCH_UP_DWELL_MS} continuously,
 * and `caution.gapOpened` fires. It CLOSES, silently, when the ratio falls
 * below {@link CATCH_UP_CLEAR_MULTIPLE}; in the band between the two an open
 * gap stays open and a closed one stays closed. While open it REMINDS with
 * `caution.gapStillOpen`: every {@link CATCH_UP_REMINDER_MS} it asks whether
 * the driver is closing — the gap shorter by at least one pack spacing than at
 * the previous such moment — and speaks only if he is not, at most
 * {@link CATCH_UP_MAX_REMINDERS} times. That moment re-anchors both the clock
 * and the gap whether or not it spoke: a driver who closed twenty metres and
 * then stopped closing, still far off the pack, is "not closing" at the next
 * one, where a comparison with the gap at the last SPOKEN call would call him
 * closing for the rest of the caution. A reminder that was due and skipped is
 * not counted against the two.
 *
 * **Every tick is one of four things to a running episode**, and only two of
 * them can end it:
 *
 * - **Judged**: live, the same car ahead, and a ratio. The episode advances.
 * - **A hard block** ({@link isHardCatchUpBlock}): it ends, at once.
 * - **A disturbance** — a soft block, or a different car ahead: it is
 *   SUSPENDED ({@link suspendCatchUp}), and ends only when the disturbance has
 *   held for a dwell. A car ahead that reads `NotInWorld` for a tick makes the
 *   lineup name the next car up for that tick; the 2026-09-18 road capture has
 *   a lineup flickering for 1.07 s. Ended by that, an episode that had already
 *   made its call and both reminders would make all three again.
 * - **Unknown** — a lineup that could not be resolved with the caution still
 *   caught, a spacing short of its samples, the car ahead or the player out of
 *   the world for a tick: nothing is known, so nothing changes. An OPEN
 *   episode is held as it is, for as long as it takes; the first tick that can
 *   judge again may find a reminder due, and makes it, on a real reading.
 *
 * **The dwell is continuous.** A stretch that could not be judged does not
 * count towards it: beyond {@link CATCH_UP_UNJUDGED_TOLERANCE_MS} the dwell
 * starts again from the first reading after, so two readings ten seconds
 * apart are not "three seconds at the raise multiple". A dropped tick or two
 * is bridged.
 *
 * **A real change of the car ahead costs one dwell**, as it always did: the
 * old car's episode ends and the new car's first call is made on the same
 * tick, {@link CATCH_UP_DWELL_MS} after the lineup first named the new car,
 * provided the gap to it was at the raise multiple from then on. Later, if the
 * gap to the new car only opened later — one dwell after it did.
 *
 * **The drive-round latch** (`cautionProcedureJoined`, {@link trackDriveRound})
 * is updated here in EVERY caution phase, waving included, though catch-up
 * itself is live only once the field is caught: a waved-around car can reach
 * the tail before the pickup.
 *
 * **Pit exit is one call.** The player's `OnPitRoad` going true → false under
 * a caution, after a stay of at least a dwell — a tick on the pit lane's edge
 * is not a stop, though a car FIRST seen on pit road is taken to have stopped
 * — opens a pit-exit episode: nothing is judged for
 * {@link CATCH_UP_PIT_EXIT_GRACE_MS}, then the dwell runs as usual, the
 * ahead-of-slot rule is waived, and the call fires ONCE — not again if the car
 * ahead changes, and with no reminders, because he is catching the field on
 * purpose. It ends when he has caught it (the ratio below the clear multiple),
 * when a later stop replaces it, or when the caution ends. Both the stay and
 * the pit-exit episode ride through the replay wipe: a glance at the replay
 * from the stall must not make the stop an ordinary drop-back, and one after
 * the call must not buy a second.
 *
 * **The state is set before either event is emitted**, so a speak gate asked
 * at publish — `getCautionGap().warranted` — already reads true.
 */
function diffCatchUp(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  lineup: PaceLineup | null,
  trackLengthMeters: number | null,
  now: number,
  emit: EmitFn<(typeof CAUTION_EVENTS)[number]>,
): void {
  const onPitRoad = telemetry.OnPitRoad === true;
  const wasOnPitRoad = state.cautionCatchUpLastOnPitRoad;

  // The pit-road baseline follows the player on every tick, caution or not,
  // so the edge — and how long the stay was — is there to read whenever a
  // caution is out.
  state.cautionCatchUpLastOnPitRoad = onPitRoad;

  const pitRoadSince = state.cautionCatchUpPitRoadSince;

  if (!onPitRoad) {
    state.cautionCatchUpPitRoadSince = null;
  } else if (wasOnPitRoad === false) {
    state.cautionCatchUpPitRoadSince = now;
  } else if (wasOnPitRoad === null) {
    // The FIRST reading there has ever been, and it finds him on pit road: a
    // fresh state, a plugin restart, an SDK reconnect. The "at least a dwell"
    // rule is there to ignore a one-tick blink in a car that was being
    // judged, and a car first seen in the pits was not blinking — so the stay
    // counts as held already, whenever it began.
    state.cautionCatchUpPitRoadSince = now - CATCH_UP_DWELL_MS;
  }

  if (state.cautionPhase === "none") {
    expireCatchUpWithPhase(state);

    return;
  }

  // The settle clock starts when the phase first reads caught, however it got
  // there — a watched pickup, or a caution that arrived already static.
  if (state.cautionPhase === "waving") {
    state.cautionCaughtAt = null;
  } else if (state.cautionCaughtAt === null) {
    state.cautionCaughtAt = now;
  }

  // Off pit road after a stop. A stay shorter than a dwell was the pit lane's
  // edge clipped, not a stop, and opens nothing.
  if (!onPitRoad && wasOnPitRoad === true && pitRoadSince !== null && now - pitRoadSince >= CATCH_UP_DWELL_MS) {
    state.cautionCatchUpPitExitAt = now;
    state.cautionCatchUpPitExitCalled = false;
  }

  // Measured at most once, and only when something reads it.
  let measured: CautionGapMeasurement | null = null;
  const measure = (resolved: PaceLineup): CautionGapMeasurement =>
    (measured ??= measureCautionGap(telemetry, sessionInfo, resolved, trackLengthMeters));

  if (lineup !== null && !state.cautionProcedureJoined) {
    if (inDriveRound(lineup.paceFlags)) trackDriveRound(state, measure(lineup), now);
    else forgetDriveRound(state);
  }

  const stateBlocks = resolveStateBlocks(state, telemetry, lineup?.paceFlags ?? null, now);

  if (stateBlocks.some(isHardCatchUpBlock)) {
    endCatchUpEpisode(state);

    return;
  }

  // What is left of `stateBlocks` is soft, and decides the tick without a
  // measurement: under a block nobody's gap is judged.
  if (stateBlocks.length > 0) {
    suspendCatchUp(state, now, null);

    return;
  }

  // No lineup and nothing blocking: the player holds no row this tick, or the
  // lineup could not be read. Unknown.
  if (lineup === null) return;

  const measurement = measure(lineup);

  if (!measurement.paceCarOnTrack || (measurement.aheadOfSlot && state.cautionCatchUpPitExitAt === null)) {
    suspendCatchUp(state, now, null);

    return;
  }

  const { ratio, gapMeters, packSpacingMeters, followCarIdx } = measurement;

  // Live, and nothing to judge it by this tick. Unknown.
  if (ratio === null || gapMeters === null || packSpacingMeters === null || followCarIdx === null) return;

  if (state.cautionCatchUpFollowCarIdx !== null && state.cautionCatchUpFollowCarIdx !== followCarIdx) {
    // A different car ahead of a running episode: a disturbance, with a
    // candidate. Carry on only if it has held and the episode is now the new
    // car's.
    if (!suspendCatchUp(state, now, { carIdx: followCarIdx, ratio })) return;
  } else {
    endCatchUpSuspense(state);
  }

  const inPitExit = state.cautionCatchUpPitExitAt !== null;

  if (!state.cautionCatchUpOpen) {
    if (ratio < CATCH_UP_CLEAR_MULTIPLE) {
      // In place. For a car out of the pits that is the field caught.
      endCatchUpEpisode(state);
      endPitExitEpisode(state);

      return;
    }

    if (ratio < CATCH_UP_RAISE_MULTIPLE) {
      // The band: not open, and the dwell has to be continuous.
      endCatchUpEpisode(state);

      return;
    }

    // At the raise multiple: the dwell starts, or goes on — unless the last
    // reading at it is too old to call this continuous.
    if (
      state.cautionCatchUpFollowCarIdx === null ||
      state.cautionCatchUpRaisedSince === null ||
      interrupted(state.cautionCatchUpRaisedSeenAt, now)
    ) {
      state.cautionCatchUpFollowCarIdx = followCarIdx;
      state.cautionCatchUpRaisedSince = now;
    }

    state.cautionCatchUpRaisedSeenAt = now;

    if (now - state.cautionCatchUpRaisedSince < CATCH_UP_DWELL_MS) return;

    // A pit-exit episode has already made its one call.
    if (inPitExit && state.cautionCatchUpPitExitCalled) return;

    state.cautionCatchUpOpen = true;
    state.cautionCatchUpLastCallAt = now;
    state.cautionCatchUpLastCallGapMeters = gapMeters;
    state.cautionCatchUpReminders = 0;

    if (inPitExit) state.cautionCatchUpPitExitCalled = true;

    emit({ event: "caution.gapOpened", data: {} });

    return;
  }

  if (ratio < CATCH_UP_CLEAR_MULTIPLE) {
    // Closed. Silently: there is no "that's better" call.
    endCatchUpEpisode(state);
    endPitExitEpisode(state);

    return;
  }

  // Out of the pits he is catching the field on purpose: no reminders.
  if (inPitExit || state.cautionCatchUpReminders >= CATCH_UP_MAX_REMINDERS) return;

  const lastCallAt = state.cautionCatchUpLastCallAt;
  const lastCallGapMeters = state.cautionCatchUpLastCallGapMeters;

  if (lastCallAt === null || lastCallGapMeters === null || now - lastCallAt < CATCH_UP_REMINDER_MS) return;

  // A reminder is due. Judged against the gap at the previous such moment, and
  // that moment moves here whether or not this one speaks (see above).
  const closing = lastCallGapMeters - gapMeters >= packSpacingMeters;

  state.cautionCatchUpLastCallAt = now;
  state.cautionCatchUpLastCallGapMeters = gapMeters;

  if (closing) return;

  state.cautionCatchUpReminders++;
  emit({ event: "caution.gapStillOpen", data: {} });
}

/**
 * The flag half of a restart: `Green` rising on this tick with neither
 * `Caution` nor `CautionWaving` set on it — the test in the module comment's
 * **Restarted** paragraph, which is what keeps a yellow-checkered tick (`Green`
 * rising with `Caution` still set) from being called one.
 *
 * It is only half: a green that rises with no caution behind it is a race
 * start or a plain green, so each caller adds its own "a caution was out".
 * {@link diffCautionEpisode} reads the caution phase; the replay green record
 * (`replay-greens.ts`, issue #1354) keeps a latch of its own, because that
 * phase is wiped on every replay tick and the record runs ahead of the guard
 * that wipes it. Shared rather than copied so the event the engineer speaks
 * and the frame the replay jumps to are decided by one reading of the flags.
 *
 * @param prevFlags - `SessionFlags` on the previous tick the caller diffed
 * @param flags - `SessionFlags` on this tick
 */
export function isRestartGreenEdge(prevFlags: number, flags: number): boolean {
  return (
    hasFlag(flags, Flags.Green) &&
    !hasFlag(prevFlags, Flags.Green) &&
    !hasFlag(flags, Flags.Caution) &&
    !hasFlag(flags, Flags.CautionWaving)
  );
}

/**
 * The next caution's id (issue #1286). Module-level and never reset, so a
 * caution in a later session — `resetPerSessionState` builds a fresh state —
 * can never reuse an id a consumer still remembers.
 */
let nextCautionEpisodeId = 1;

/**
 * Opens and closes the episode identity with the phase, once the tick's phase
 * has settled: at the top of {@link diffLineup}, which needs the id before it
 * records the caution's first follow car, and on the seed tick, whose early
 * return never reaches it.
 */
function trackCautionEpisode(state: TranslatorState): void {
  if (state.cautionPhase === "none") {
    state.cautionEpisodeId = null;
    state.cautionFirstFollowCarIdx = null;
  } else if (state.cautionEpisodeId === null) {
    state.cautionEpisodeId = nextCautionEpisodeId++;
  }
}

/**
 * The car leading the race, whose start/finish crossings the caution's laps are
 * counted in: the canonical order first, then the front of the pace lineup —
 * line 0, row 1. `null` when neither can be read, which costs silence rather
 * than some other car's laps.
 */
function resolveLeaderIdx(telemetry: TelemetryData, canonicalPositions: number[] | null): number | null {
  if (canonicalPositions) {
    const leader = canonicalPositions.findIndex((position) => position === 1);

    if (leader >= 0) return leader;
  }

  const rows = telemetry.CarIdxPaceRow;
  const lines = telemetry.CarIdxPaceLine;

  if (Array.isArray(rows) && Array.isArray(lines)) {
    const front = rows.findIndex((row, idx) => row === 1 && lines[idx] === 0);

    if (front >= 0) return front;
  }

  return null;
}

/**
 * The leader's scored lap count, or `null` when it can't be read — iRacing's
 * −1 sentinel included, since a baseline taken from it would report the first
 * real value as a crossing.
 */
function resolveLeaderLapCompleted(telemetry: TelemetryData, canonicalPositions: number[] | null): number | null {
  const idx = resolveLeaderIdx(telemetry, canonicalPositions);
  const laps = telemetry.CarIdxLapCompleted;

  if (idx === null || !Array.isArray(laps)) return null;

  const lap = laps[idx];

  return typeof lap === "number" && lap >= 0 ? lap : null;
}

/**
 * The pace car reaching the track and leaving it. Seeds its surface baseline
 * silently, so a plugin started with the pace car already out says nothing.
 */
function diffPaceCar(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  seeding: boolean,
  emit: EmitFn<(typeof CAUTION_EVENTS)[number]>,
): void {
  const paceCarIdx = resolvePaceCarIdx(sessionInfo);
  const surfaces = telemetry.CarIdxTrackSurface;
  const surface = paceCarIdx !== null && Array.isArray(surfaces) ? surfaces[paceCarIdx] : undefined;

  if (seeding) {
    state.cautionPaceCarSurface = surface ?? null;

    return;
  }

  // A tick that cannot read the pace car — session info naming none, or no
  // surface array — is a gap in the reading, not a reading. The baseline is
  // kept through it, so a transition that straddles the gap is still an edge
  // on the next tick that can read; writing `null` here instead would turn
  // that tick into a fresh seed and swallow "Pace car's out" for good.
  if (surface === undefined) return;

  const was = state.cautionPaceCarSurface;

  state.cautionPaceCarSurface = surface;

  if (was === null) return;

  // The pace car is on the road when its surface is a track surface rather
  // than a pit one — the test the catch-up measurement stands down on too.
  if (!isRacingSurface(was) && isRacingSurface(surface)) emit({ event: "paceCar.deployed", data: {} });
  else if (isRacingSurface(was) && !isRacingSurface(surface)) emit({ event: "paceCar.off", data: {} });
}

/**
 * The caution's own phases: the pickup, the laps behind the pace car, one to
 * go, and the restart. Seeds the flag and crossing baselines silently — and the
 * phase is deliberately NOT re-seeded from nothing, so the value preserved
 * across a replay wipe survives and a fresh connect reports only the
 * transitions it actually watched.
 *
 * The seed does apply ONE rule to the phase, though: it expires a phase the
 * flags contradict. A glance at the replay is preserved-phase's whole reason —
 * coming back mid-caution must not re-report the pickup — but a caution that
 * ENDED during the glance is not that case, and a phase left standing there is
 * a latch nothing can clear until the tick AFTER this one. `diffStartLights`
 * reads the phase before this diff runs, so that one tick is enough to swallow
 * a legitimate `StartGo` rising edge and lose the race-start line for good.
 * Expiring here emits nothing and can therefore re-report nothing; it only
 * declines to carry a caution the flags say is over.
 */
function diffCautionEpisode(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  canonicalPositions: number[] | null,
  seeding: boolean,
  emit: EmitFn<(typeof CAUTION_EVENTS)[number]>,
  now: number,
  trackLengthMeters: number | null,
): void {
  const flags = telemetry.SessionFlags ?? 0;
  const waving = hasFlag(flags, Flags.CautionWaving);
  const caution = hasFlag(flags, Flags.Caution);
  const green = hasFlag(flags, Flags.Green);
  const oneToGo = hasFlag(flags, Flags.OneLapToGreen);
  const leaderLap = resolveLeaderLapCompleted(telemetry, canonicalPositions);
  // The player's own lap distance, read the way the rest of the translator
  // reads it (`LapDistPct`, the player-car field). A tick that cannot read it
  // keeps the last baseline rather than writing `null` — a gap is not a
  // reading, and a `null` here would swallow a crossing that straddled it.
  const lapDistPct =
    typeof telemetry.LapDistPct === "number" && telemetry.LapDistPct >= 0 ? telemetry.LapDistPct : null;

  if (seeding) {
    state.cautionLastFlags = flags;
    state.cautionLeaderLapCompleted = leaderLap;
    state.cautionLastLapDistPct = lapDistPct;

    // The one thing the seed says about the phase — see the expiry paragraph
    // above. Same test as the live expiry below, so "no caution bits means no
    // caution phase" holds on every tick rather than on every tick but the
    // first one back from a replay.
    if (!caution && !waving) {
      state.cautionPhase = "none";
      state.cautionCheckpointArmed = false;
    }

    trackCautionEpisode(state);
    // …and the same for what catch-up keeps with the phase (issue #1168).
    expireCatchUpWithPhase(state);

    return;
  }

  const wasFlags = state.cautionLastFlags;
  const wasLeaderLap = state.cautionLeaderLapCompleted;

  state.cautionLastFlags = flags;

  // The crossing baseline for THIS tick — the pickup below may move it past the
  // leader's own counter, so the extra-lap test reads this rather than state.
  let crossingBaseline = wasLeaderLap;

  // The precedence below is load-bearing: a green rising edge with every
  // caution bit gone ends the episode before anything else can read it, a
  // waving caution outranks a static one (both bits can be set) but only until
  // the pickup, a static caution the diff watched wave is the pickup, one it
  // did not is caught silently — never under a flying green — with neither
  // bit set the phase expires, and a one-to-go flag withdrawn while the caution
  // stays out returns the episode to caught.
  if (isRestartGreenEdge(wasFlags, flags) && state.cautionPhase !== "none") {
    // The restart: the green rising AND the caution bits gone on the same
    // tick (`isRestartGreenEdge` above), which is what both captures show. A
    // green rising with `Caution` still set (a yellow-checkered tick) is
    // deliberately not this branch — see the module comment — and falls
    // through to leave the phase where it is, so no "Go, go, go!" reaches a
    // driver who must not go.
    emit({ event: "caution.restarted", data: {} });
    state.cautionPhase = "none";
    state.cautionRestartedAt = now;
  } else if (waving && (state.cautionPhase === "none" || state.cautionPhase === "waving")) {
    // The waving bit starts an episode; it never rewinds one. Once the field
    // is caught a re-raise of `CautionWaving` — the bit is per-zone like the
    // yellow one, and the follow contract carries a cooldown for exactly that
    // — is the same caution still out, not a new one: rewinding to "waving"
    // here would report the pickup AGAIN at the next static tick and re-anchor
    // the crossing baseline on it, swallowing the next genuine leader crossing
    // and with it an `extraLap`. The pickup therefore fires at most once per
    // episode, and only the green edge or the both-bits-clear expiry ends one.
    state.cautionPhase = "waving";
  } else if (caution && state.cautionPhase === "waving") {
    emit({ event: "caution.fieldCaught", data: {} });
    state.cautionPhase = "caught";

    // Consume the leader crossing the pickup itself landed on; see the module
    // comment for what the pre-pickup reading does and does not buy. Never
    // below what the leader has already scored, though: with no canonical
    // order the pre-pickup reading is only as fresh as the last tick that
    // carried a lineup, and a stale one would read as a caution that had
    // already run every green lap since.
    const pickupLap = wasLeaderLap ?? leaderLap;

    if (pickupLap !== null) {
      crossingBaseline = leaderLap === null ? pickupLap + 1 : Math.max(pickupLap + 1, leaderLap);
    }
  } else if (caution && state.cautionPhase === "none" && !green) {
    // `!green` is the other half of the yellow-checkered rule: a `Caution`
    // bit that outlives a green (the finish under yellow) must not START an
    // episode on a plugin that only met it there, any more than it may keep
    // one that the green was mistaken for ending.
    state.cautionPhase = "caught";

    // Re-anchor rather than carry the baseline in: this is an episode the diff
    // never watched begin, so whatever the leader last scored under a lineup —
    // possibly the previous caution's — says nothing about laps run behind
    // this pace car.
    crossingBaseline = leaderLap;
  } else if (!caution && !waving) {
    state.cautionPhase = "none";
  } else if (state.cautionPhase === "one-to-go" && !oneToGo) {
    // The one-to-go flag withdrawn with the caution still out — a waved-off
    // restart, or a caution extended after one to go was shown. The field is
    // back to running laps behind the pace car, so the phase returns to caught:
    // the next leader crossing without the flag is an extra lap, and the next
    // rise of the flag is the REAL one to go, reported again. Left latched at
    // "one-to-go", neither branch below could ever match, and the driver would
    // be released into the green with no warning at all.
    state.cautionPhase = "caught";
  }

  // Whether THIS tick armed the checkpoint — the checkpoint diff must not fire
  // on the tick that armed it (see {@link diffLastLapCheckpoint}).
  let armedThisTick = false;

  if (oneToGo && !hasFlag(wasFlags, Flags.OneLapToGreen) && state.cautionPhase === "caught") {
    emit({ event: "caution.oneLapToGreen", data: {} });
    state.cautionPhase = "one-to-go";
    // Arm the last lap's checkpoint. Armed HERE rather than on the phase
    // alone, so a phase that merely survived (a replay glance preserves it)
    // owes nothing it has not been told to owe — and re-armed on every rise,
    // so a re-raised one-to-go gets its own position call.
    state.cautionCheckpointArmed = true;
    armedThisTick = true;
    // Reaching the branch below means a caution bit is still set, and the
    // expiry above is what guarantees it: with neither bit set the phase has
    // already returned to "none". It does NOT mean the `Caution` bit
    // specifically — a tick carrying only a re-raised `CautionWaving` after
    // the pickup leaves the phase at "caught" (the waving bit never rewinds
    // an episode), and a leader crossing on such a tick is still a lap under
    // caution, so the branch asks for neither bit by name. What it does ask
    // for is no flying `Green`: at a yellow-checkered finish the `Caution`
    // bit outlives the green, the phase survives with it, and a leader
    // crossing there is a lap under the checkered, not "another lap under
    // caution". Stated rather than left implicit, because the earlier form
    // of this comment claimed `"caught"` implied `Caution`, which the
    // re-raise rule made false.
  } else if (
    state.cautionPhase === "caught" &&
    !oneToGo &&
    !green &&
    leaderLap !== null &&
    crossingBaseline !== null &&
    leaderLap > crossingBaseline
  ) {
    emit({ event: "caution.extraLap", data: {} });
  }

  if (state.cautionPhase === "none") {
    // Between episodes the baseline simply FOLLOWS the leader (gap-tolerant:
    // a tick that cannot read one keeps the last value). The high-water rule
    // below is an episode's device — it carries the pickup's consumed crossing
    // and rides out a leader swap — and outside one it would carry a lap
    // count into the NEXT caution that the sim has since moved below: an
    // admin `!restart` zeroes every lap counter under the same `SessionNum`
    // (so the per-session reset never sees it), and the scenario harness
    // replays fixed lap values on every press of a caution button. Either
    // way the pickup would clamp its baseline to the stale count and no extra
    // lap could be reported until the leader had climbed back past it.
    state.cautionLeaderLapCompleted = leaderLap ?? crossingBaseline;
  } else {
    // High-water within an episode, never lowered: it carries the pickup's
    // consumed crossing until the counter catches up, and a leader swap to a
    // car with fewer laps scored then goes quiet rather than manufacturing an
    // extra lap.
    state.cautionLeaderLapCompleted =
      leaderLap === null || (crossingBaseline !== null && crossingBaseline > leaderLap) ? crossingBaseline : leaderLap;
  }

  diffLastLapCheckpoint(state, lapDistPct, armedThisTick, emit);

  // Last, so it reads the phase this tick actually settled on. The lineup is
  // resolved ONCE, inside `diffLineup` and only past its early returns, and
  // handed on: catch-up judges the gap on the same reading, and under green
  // neither of them reads anything.
  const lineup = diffLineup(state, telemetry, sessionInfo, emit);

  diffCatchUp(state, telemetry, sessionInfo, lineup, trackLengthMeters, now, emit);
}

/**
 * The one-to-green lap's checkpoint — see the module comment for why 35% of
 * the PLAYER's lap is the right moment for every car in the field. Reads the
 * phase this tick settled on: anything but `"one-to-go"` disarms, which is
 * what makes a green arriving first fire nothing, and a one-to-go withdrawn
 * wait for the re-raise to re-arm it. Takes no lineup: the event carries no
 * position, because the one spoken is the race position, read live.
 *
 * The tick that ARMS the checkpoint never fires it, even when the player's
 * distance rises through 35% on that very tick: the one-to-go call and the
 * position call would then be published on the same tick, and the position
 * call would contend for the bus with the warning it is meant to follow. A
 * player exactly there when the leader's crossing raises the flag — which the
 * packed field makes rare, the mid-pack car being at ~0.9–1.0 of the lap —
 * gets no position call this caution rather than one on top of the warning.
 */
function diffLastLapCheckpoint(
  state: TranslatorState,
  lapDistPct: number | null,
  armedThisTick: boolean,
  emit: EmitFn<(typeof CAUTION_EVENTS)[number]>,
): void {
  if (state.cautionPhase !== "one-to-go") state.cautionCheckpointArmed = false;

  if (lapDistPct === null) return;

  const was = state.cautionLastLapDistPct;

  state.cautionLastLapDistPct = lapDistPct;

  if (!state.cautionCheckpointArmed || armedThisTick || was === null) return;

  // An UPWARD crossing only: the wrap at start/finish (~1.0 → ~0.0) passes
  // through nothing, and a car sitting past 0.35 when the flag rises — every
  // mid-pack car, at ~0.9–1.0 — waits for its own lap to bring it back round.
  if (was < LAST_LAP_CHECKPOINT_PCT && lapDistPct >= LAST_LAP_CHECKPOINT_PCT) {
    emit({ event: "caution.lastLapCheckpoint", data: {} });
    state.cautionCheckpointArmed = false;
  }
}

/**
 * The car to follow changing. Held rather than diffed against the previous
 * tick's telemetry, because the lineup can go briefly unreadable — a tick
 * without session info, a player the re-form has not placed yet — and a gap
 * is an absence of news rather than a change.
 *
 * Three things it deliberately does not report:
 *
 * - **the first lineup of an episode**, which is the answer to "who do I
 *   follow" rather than a change to it. The `null` held between episodes is
 *   what distinguishes the two, so the phase returning to `"none"` clears it;
 * - **a follow car it cannot name** (`followCarIdx === null`), which happens
 *   only when session info names no pace car for a front-row player;
 * - **anything under green.** The phase alone would nearly always do — a green
 *   rising edge ends the episode — but the two are not the same test at a
 *   yellow-checkered finish, where the caution bits stay set past the green and
 *   the phase is therefore `"caught"`. The lineup UNWINDS under green: the
 *   pace car pulls off, line 0 shifts down a row, and cars drop out of the
 *   arrays one by one as they accelerate away, so the car ahead changes on
 *   almost every tick. Sixty ticks of the committed fixture are exactly that,
 *   and reporting them would be a burst of changes to a lineup nobody is in
 *   any more.
 *
 * The lineup is resolved HERE, after those two early returns, and nowhere
 * else in the diff: resolving it is session-info lookups plus three passes
 * over the car slots — so on the green-flag ticks that are almost every tick
 * of a race, nothing is resolved at all.
 *
 * It hands the lineup it resolved back (issue #1168), `null` when it resolved
 * none: {@link diffCatchUp} runs right after it on that value, so one
 * resolution per tick serves both and neither reads a lineup under green.
 */
function diffLineup(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn<(typeof CAUTION_EVENTS)[number]>,
): PaceLineup | null {
  trackCautionEpisode(state);

  if (state.cautionPhase === "none" || hasFlag(telemetry.SessionFlags ?? 0, Flags.Green)) {
    state.cautionFollowCarIdx = null;

    return null;
  }

  const lineup = resolvePaceLineup(telemetry, sessionInfo, isOvalTrack(sessionInfo));

  if (lineup === null || lineup.followCarIdx === null) return lineup;

  const was = state.cautionFollowCarIdx;

  state.cautionFollowCarIdx = lineup.followCarIdx;

  // The caution's first lineup, kept for `getCautionEpisode()` — never moved by
  // a change, so a consumer can tell a return to it from a new car.
  if (state.cautionFirstFollowCarIdx === null) state.cautionFirstFollowCarIdx = lineup.followCarIdx;

  if (was === null || was === lineup.followCarIdx) return lineup;

  emit({
    event: "caution.lineup.changed",
    data: {
      followCarIdx: lineup.followCarIdx,
      followCarNumber: lineup.followCarNumber,
      line: lineup.line,
      isLeader: lineup.isLeader,
    },
  });

  return lineup;
}

/**
 * What the translator hands {@link diffCaution} beside the tick. An object
 * rather than two trailing parameters because they are two adjacent optional
 * NUMBERS: `diffCaution(…, emit, now, trackLengthMeters)` and its transposition
 * both compile, and the second would stamp the restart with a track length
 * (the #1052 swap trap).
 */
export type CautionDiffOptions = {
  /**
   * The tick's clock (ms), the same value `diffFlags` takes: it stamps the
   * restart so `diffStartLights` can hold the race-start line down for a
   * `StartGo` trailing the green, and it is the catch-up episode's clock
   * (issue #1168). Defaulted to `Date.now()` for the tests that need neither;
   * the translator always passes its own.
   */
  now?: number;
  /**
   * The track's length in metres, for the catch-up measurement. Without it no
   * gap can be measured and catch-up says nothing; everything else here runs
   * as before.
   */
  trackLengthMeters?: number | null;
};

/** The events {@link diffCaution} emits (issue #1499): its emitter's type, and its row in `TICK_ORDER`. */
export const CAUTION_EVENTS = [
  "caution.extraLap",
  "caution.fieldCaught",
  "caution.gapOpened",
  "caution.gapStillOpen",
  "caution.lastLapCheckpoint",
  "caution.lineup.changed",
  "caution.oneLapToGreen",
  "caution.restarted",
  "paceCar.deployed",
  "paceCar.off",
] as const satisfies readonly SimEventName[];

export function diffCaution(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  canonicalPositions: number[] | null,
  emit: EmitFn<(typeof CAUTION_EVENTS)[number]>,
  options: CautionDiffOptions = {},
): void {
  const { now = Date.now(), trackLengthMeters = null } = options;
  const seeding = !state.cautionInitialized;

  state.cautionInitialized = true;

  diffPaceCar(state, telemetry, sessionInfo, seeding, emit);
  diffCautionEpisode(state, telemetry, sessionInfo, canonicalPositions, seeding, emit, now, trackLengthMeters);
}
