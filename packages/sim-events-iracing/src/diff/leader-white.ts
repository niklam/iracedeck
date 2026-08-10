/**
 * Leader's white-flag detection (issue #936).
 *
 * The leader taking the white flag — starting the FINAL lap of the race —
 * is a headline "one more lap" callout. iRacing's own `Flags.White` bit is
 * PER-CAR (the #772 two-stage split already reads it that way for the
 * player), so it cannot answer "has the OVERALL leader started their final
 * lap" for anyone but the leader themselves — a multi-class player several
 * laps down never sees the leader's white bit at all. This diff detects the
 * leader's final-lap crossing directly from lap counting against the two
 * independently-known race limits, mirroring the #880 fuel-coverage
 * resolver's leader-relative model:
 *
 *   - **Lap-limited**: `SessionLapsRemainEx` is LEADER-relative in races
 *     (validated 2026-08 capture) and reads the laps still to run INCLUDING
 *     the current one. The leader starts their final lap the tick it falls
 *     to 1 (a `>= 2` → `1` edge) — a race connected already at 1 seeds
 *     silently (this race's episode is missed, never guessed retroactively).
 *   - **Timed**: the clock has no lap-boundary of its own — the leader takes
 *     the white at their FIRST S/F crossing AFTER `SessionTimeRemain`
 *     expires, and the checkered at their SECOND (the #880 model). This diff
 *     tracks the leader's own `CarIdxLapCompleted` and fires on a genuine
 *     same-TRACKED-leader increment once the clock has expired, but ONLY for
 *     that first post-expiry crossing — see `leaderWhitePostExpiryCrossed`
 *     below. A leader change BEFORE expiry re-baselines the crossing
 *     detector silently; a leader change WHILE expired ABSORBS (sets the
 *     marker — see the inline comment): the detector cannot observe a
 *     crossing across the flip, and an unobservable white crossing must
 *     become silence, never leave the checkered armed.
 *
 * **`leaderWhitePostExpiryCrossed`: literal first-crossing rule.** A timed
 * race's leader has exactly two post-expiry crossings — the white, then the
 * checkered — so any detection path that can MISS the white (a leader change
 * landing exactly on the crossing tick, or a gated window covering it) must
 * not leave the checkered crossing armed: speaking "leader starting their
 * final lap" as the race actually ends would be a strictly worse failure
 * than staying silent. `state.leaderWhitePostExpiryCrossed` is set to `true`
 * the INSTANT a same-leader crossing is observed while `clockExpired` —
 * unconditionally, including under a closed gate and even after
 * `leaderWhiteFired` has already latched. Observation absorbs, it never
 * defers: once a post-expiry crossing has been seen, whether or not THIS
 * diff got to act on it, the timed edge can never fire again this race. The
 * accepted residual: a full replay-ENTRY wipe (`wipeStateForReplay`, which
 * re-seeds the crossing-detector baselines) that happens to swallow the
 * white crossing itself cannot retroactively mark the miss — the crossing
 * was never observed by any tick, gated or not. The remaining defenses for
 * that narrow window are the unconditional postRace gate (the checkered
 * itself is always suppressed once the race is over) and the player's own
 * White-bit suppression below (a player who WAS present for the crossing
 * hears their own white-flag family instead).
 *
 * Once-per-race latch (`leaderWhiteFired`): the callout is a single
 * headline moment, and unlike the player's own two-stage white (which
 * re-arms per episode) there's no second "final lap" to speak. STICKY
 * across `wipeStateForReplay` (a replay glance mid-final-lap must not
 * replay the announcement) but re-armed — alongside
 * `leaderWhitePostExpiryCrossed` — on a GREEN rising edge in `diffFlags`
 * (the #880 precedent — oval overtime / a same-session admin restart means a
 * new final lap is coming). When BOTH the lap and timed edges are true on
 * the same tick (a race carrying both limits), only ONE event is emitted —
 * the latch check gates the whole detection block, and the
 * `if (lapEdge || timedEdge)` body emits exactly once regardless of how many
 * of the two conditions are true.
 *
 * Suppression is checked INSIDE the fire block — after the edge is detected
 * and the latch is set — so a suppressed moment still latches (no repeated
 * detection is possible on a later tick): the leader IS the player (the
 * player's own two-stage white in `diffFlags` already owns that callout) or
 * the player's own `SessionFlags & Flags.White` is already up at the
 * detection tick (same reasoning — the player is about to hear their own
 * white-flag family fire). An unresolved leader (`leaderIdx < 0`, no car
 * currently holds position 1) never fires either — the lap-limited edge
 * doesn't otherwise depend on `leaderIdx` at all, so this guard is what
 * keeps it from firing leaderless with the leader/player suppression
 * vacuously satisfied.
 *
 * Gating mirrors `diffOpponentPit` / `diffOpponentFlags`: race sessions
 * only, replay-only suppressed, pre-green suppressed (no leader is
 * meaningful before the green), post-race suppressed, and an unresolved
 * player carIdx suppresses everything. The three crossing/baseline fields
 * (`leaderWhiteLastLeaderIdx` / `leaderWhiteLastLeaderLap` /
 * `leaderWhiteLastLapsRemainEx`) advance every tick regardless of gating so
 * a gated tick's edge is absorbed into the baseline, never replayed once the
 * gate reopens — `leaderWhitePostExpiryCrossed` observation follows the same
 * unconditional-advance rule, for the reason explained above.
 *
 * **`clockExpired` guard.** `SessionTimeRemain` has no documented negative
 * sentinel in this codebase — unlike `SessionLapsRemainEx`, whose "no lap
 * limit" reading is the large POSITIVE `IRSDK_UNLIMITED_LAPS` sentinel, a
 * lap-limited-only race instead reads `SessionTimeRemain` as the large
 * POSITIVE `IRSDK_UNLIMITED_TIME` sentinel (validated in
 * `fuel-laps-left.test.ts`), which a plain `<= 0` check already excludes —
 * no upper-bound guard is needed on that side. Against the OPPOSITE hazard —
 * iRacing can blip `SessionTimeRemain <= 0` for a tick mid-race (the #666
 * transient in `start-lights.ts`) — two defenses stack (#936 review): the
 * expiry only counts once it has held for TWO consecutive ticks
 * (`leaderWhiteLastClockExpired`), so a one-tick blip coinciding with a
 * crossing can neither fire prematurely nor latch the marker; and a clock
 * reading back ABOVE zero clears `leaderWhitePostExpiryCrossed`, so even a
 * sustained blip's spurious latch is undone the moment the clock recovers —
 * after a genuine expiry the clock never recovers, so the clear is inert
 * exactly when the marker is load-bearing (and correctly re-arms when an
 * overtime extension adds real time back).
 */
import { Flags, hasFlag, IRSDK_UNLIMITED_LAPS, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

export function diffLeaderWhite(
  state: TranslatorState,
  telemetry: TelemetryData,
  playerCarIdx: number,
  isRaceSession: boolean,
  replayOnlySession: boolean,
  preGreen: boolean,
  postRace: boolean,
  frozenPositions: number[],
  emit: EmitFn,
): void {
  const leaderIdx = frozenPositions.findIndex((p) => p === 1);
  const leaderLap = leaderIdx >= 0 ? (telemetry.CarIdxLapCompleted?.[leaderIdx] ?? -1) : -1;

  const rawLapsRemain = telemetry.SessionLapsRemainEx;
  const lapsRemain =
    typeof rawLapsRemain === "number" &&
    Number.isFinite(rawLapsRemain) &&
    rawLapsRemain >= 0 &&
    rawLapsRemain < IRSDK_UNLIMITED_LAPS
      ? rawLapsRemain
      : null;

  const timeRemain = telemetry.SessionTimeRemain;
  const clockExpiredNow = typeof timeRemain === "number" && Number.isFinite(timeRemain) && timeRemain <= 0;
  // Two-consecutive-tick confirmation (#936 review): a one-tick `<= 0` blip
  // (the #666 transient) coinciding with a leader crossing must neither fire
  // a premature callout nor latch the post-expiry marker. A genuine expiry
  // holds `<= 0` for thousands of ticks before the leader's crossing, so the
  // one-tick confirmation delay is unobservable in practice.
  const clockExpired = clockExpiredNow && state.leaderWhiteLastClockExpired;

  const prevLapsRemain = state.leaderWhiteLastLapsRemainEx;
  const sameLeader = leaderIdx >= 0 && leaderIdx === state.leaderWhiteLastLeaderIdx;
  const leaderCrossed =
    sameLeader && leaderLap >= 0 && state.leaderWhiteLastLeaderLap >= 0 && leaderLap > state.leaderWhiteLastLeaderLap;

  // Literal first-crossing rule: capture whether THIS crossing is the first
  // one observed post-expiry BEFORE marking it observed, then mark it
  // observed unconditionally — regardless of gating or the `leaderWhiteFired`
  // latch. Observation absorbs, it never defers (see the module doc).
  const isFirstPostExpiryCrossing = clockExpired && leaderCrossed && !state.leaderWhitePostExpiryCrossed;

  // A LEADER CHANGE while the clock is expired also absorbs (#936 review):
  // a swap at the front after expiry is overwhelmingly the white-flag
  // scramble at the line, and the crossing detector cannot observe the
  // crossing across the flip (no baseline exists for the incoming leader),
  // so leaving the marker unset would arm the CHECKERED crossing as the
  // "first" one — the phantom the marker exists to prevent. The cost is the
  // safe direction: a genuine mid-lap post-expiry lead change silences the
  // callout for that race (silence beats a phantom, per the module doc).
  const leaderChanged =
    leaderIdx >= 0 && state.leaderWhiteLastLeaderIdx >= 0 && leaderIdx !== state.leaderWhiteLastLeaderIdx;

  if (clockExpired && (leaderCrossed || leaderChanged)) {
    state.leaderWhitePostExpiryCrossed = true;
  }

  // A clock reading back ABOVE zero un-absorbs (#936 review): iRacing can
  // blip `SessionTimeRemain <= 0` for a tick or two mid-race (the #666
  // transient) — if that blip coincides with a leader crossing or change,
  // the marker latches spuriously and would silence the REAL white crossing
  // laps later. After a genuine expiry the clock never recovers, so this
  // clear only ever undoes blip-latched markers (and re-arms correctly when
  // an overtime extension adds time back).
  if (typeof timeRemain === "number" && Number.isFinite(timeRemain) && timeRemain > 0) {
    state.leaderWhitePostExpiryCrossed = false;
  }

  const gated = !isRaceSession || replayOnlySession || preGreen || postRace || playerCarIdx < 0;

  if (!gated && !state.leaderWhiteFired) {
    const lapEdge = lapsRemain === 1 && prevLapsRemain !== null && prevLapsRemain >= 2;
    const timedEdge = isFirstPostExpiryCrossing;

    if ((lapEdge || timedEdge) && leaderIdx >= 0) {
      state.leaderWhiteFired = true;

      const playerWhiteUp = hasFlag(telemetry.SessionFlags, Flags.White);

      if (leaderIdx !== playerCarIdx && !playerWhiteUp) {
        emit({ event: "flag.white-leader.raised", data: {} });
      }
    }
  }

  state.leaderWhiteLastLeaderIdx = leaderIdx;
  state.leaderWhiteLastLeaderLap = leaderLap;
  state.leaderWhiteLastLapsRemainEx = lapsRemain;
  state.leaderWhiteLastClockExpired = clockExpiredNow;
}
