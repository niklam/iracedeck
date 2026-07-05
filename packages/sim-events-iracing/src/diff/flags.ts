/**
 * Flag transitions.
 *
 * Publishes flag.*.raised when a flag appears in SessionFlags that wasn't
 * active last tick, flag.yellow.cleared once all yellow-ish bits have
 * stayed clear for the sustain window (issue #671), and the furled pair
 * (issue #669): flag.furled.raised is debounced behind
 * {@link FURLED_DEBOUNCE_MS} (running briefly off track flashes the bit),
 * and flag.furled.cleared fires on the falling edge only when the raised
 * callout was actually announced.
 *
 * Yellow handling (issue #480 rework): a *static* yellow (`Yellow` without
 * `YellowWaving`) / *static* caution (`Caution` without `CautionWaving`)
 * drives the existing `flag.yellow.raised {scope}` event; the waving variants
 * (`YellowWaving`, `CautionWaving`) drive their own (more urgent) callouts.
 * `flag.yellow.cleared` fires only when EVERY yellow-ish bit goes clear (so a
 * static→waving escalation never mis-clears) — tracked via `state.lastAnyYellow`.
 *
 * Validated clear (issue #671): the yellow bits mirror the flag SHOWN to the
 * player and are transient per zone — `YellowWaving` drops the moment the
 * player passes out of the affected zone and re-raises next lap. So the
 * cleared edge is not announced on the drop tick; it is announced only after
 * the all-clear has been SUSTAINED for {@link YELLOW_CLEARED_HOLD_MS}, and a
 * yellow-ish re-raise meanwhile cancels the pending clear (CrewChief's
 * validated-clear approach).
 *
 * Blue is suppressed when Green is active (race-start sets both). Green is
 * suppressed when `StartGo` is set — a standing/rolling race-start go is owned
 * by the start-light family (issue #480); restarts (no `StartGo`) still fire.
 *
 * Checkered deferral (issue #771) — qualifying and race only: iRacing raises
 * the `Checkered` bit for the entire field the moment the session ends
 * (qualifying clock expires, race leader finishes) — often most of a lap
 * before the player takes the flag, and observed behavior shows the flag
 * ahead of a car's crossing even for the winner. So the checkered raise is
 * held until the player's own scored S/F crossing (a `LapCompleted`
 * increment) — including for the winner, whose deferral resolves seconds
 * later right at the line. Practice/testing speaks IMMEDIATELY at the raise:
 * the flag there just means the session is over, with no flag-taking lap.
 * The deferral also falls back to immediate when the player isn't in the
 * car or crossings can't be tracked (never hold a callout hostage to
 * missing data), when the player is already parked in the pits in
 * qualifying (no crossing is coming), and — as a safety net for any timing
 * where the bit instead lands at/after the race leader's scored crossing —
 * via the winner grace ({@link FLAG_CROSS_GRACE_MS}, gated on leading the
 * race per the canonical live order, which `handleTick` passes in as
 * `playerIsLeader`).
 *
 * Two-stage white (issue #772) — RACE sessions only: iRacing shows the
 * White to the whole field while the LEADER is still ~5–10 s from starting
 * the final lap, so the raise precedes everyone's crossing. The raise stays
 * the heads-up (`flag.white.raised`, "about to start the final lap"), and a
 * second event (`flag.white-last-lap.raised`) fires at the player's own S/F
 * crossing under the flag — the start of THEIR last lap — guarded by
 * {@link WHITE_LAST_LAP_MIN_GAP_MS} so a crossing landing while the
 * heads-up is still playing skips the second line instead of preempting it
 * mid-sentence. Should the bit ever land at/after the race leader's scored
 * crossing, the leader skip (`leaderTookTheLine`) speaks only the last-lap
 * line — a safety net mirroring the checkered grace. Practice/qualifying
 * keep the single raise-time callout: their white is shown to the player
 * when THEY start their own final lap, so a split would swallow the callout
 * entirely (the last-lap scenario is race-only).
 */
import type { FlagScope } from "@iracedeck/event-bus";
import { Flags, hasFlag, type TelemetryData } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import type { EmitFn } from "./types.js";

/**
 * How long (ms) the all-clear must be sustained before `flag.yellow.cleared`
 * is announced (issue #671). iRacing's yellow bits mirror the flag SHOWN to
 * the player (transient / per-zone — `YellowWaving` drops when the player
 * passes out of the affected zone and re-raises next lap), so the cleared
 * edge is only announced after the all-clear has held for this window; a
 * yellow-ish re-raise meanwhile cancels the pending clear. Value mirrors
 * CrewChief's `timeBetweenYellowAndClearFlagMessages`.
 */
export const YELLOW_CLEARED_HOLD_MS = 3000;

/**
 * How long (ms) the `Furled` bit must stay set before `flag.furled.raised`
 * is announced (issue #669). Running briefly off track flashes the bit for
 * ~0.5 s without a genuine furled-black-flag warning, so the rising edge only
 * arms this window; the bit clearing meanwhile drops the announcement.
 */
export const FURLED_DEBOUNCE_MS = 1000;

/**
 * Winner grace window (ms) for the checkered deferral (issue #771). iRacing
 * generally shows the checkered BEFORE a car reaches the line — even for the
 * winner — so the normal winner path is the deferral itself: the raise
 * pends and the callout fires at their crossing moments later. This grace
 * is a SAFETY NET for any timing where the bit instead lands on — or a
 * frame or two after — the race leader's scored crossing (waiting for the
 * NEXT crossing would then delay the winner's call by a whole cool-down
 * lap): a raise landing within this window of the player's latest crossing,
 * while the player leads a RACE (per the canonical live order — see
 * `.claude/rules/race-positions.md` — passed in by `handleTick`), speaks
 * immediately. The leader guard keeps a mid-pack car that crossed just
 * before the raise (about to be lapped at the line) from an early call —
 * that car is scored for one more lap; and the race guard keeps the grace
 * out of qualifying, where the clock (not anyone's crossing) raises the
 * flag and a provisional-pole crossing just before expiry still earns a
 * final lap.
 */
export const FLAG_CROSS_GRACE_MS = 1000;

/**
 * Minimum gap (ms) between the white-flag heads-up and the last-lap call
 * (issue #772). Its ONLY job is to keep stage 2 from same-family-preempting
 * the heads-up while that line is still playing (~4.5 s including the radio
 * frame), so it hugs that duration with a little margin. iRacing shows the
 * white while the leader is still ~5–10 s from the line, so under real
 * timing even the leader's crossing usually lands past this guard and gets
 * the clean at-the-line call; only a crossing landing mid-heads-up skips
 * the second line (the line that just played already covers it — skipped,
 * not delayed, since a late "this is the last lap" would be stale).
 */
export const WHITE_LAST_LAP_MIN_GAP_MS = 6000;

type FlagKey =
  | "green"
  | "yellow"
  | "blue"
  | "black"
  | "red"
  | "white"
  | "checkered"
  | "debris"
  | "meatball"
  | "disqualify"
  | "furled"
  | "dq-scoring-invalid"
  | "crossed"
  | "green-held"
  | "ten-to-go"
  | "five-to-go"
  | "yellow-waving"
  | "caution-waving";

function resolveActiveFlags(sessionFlags: number): {
  flags: Set<FlagKey>;
  yellowScope: FlagScope | null;
  anyYellow: boolean;
} {
  const flags = new Set<FlagKey>();
  let yellowScope: FlagScope | null = null;

  if (hasFlag(sessionFlags, Flags.Green)) flags.add("green");

  // Yellow rework (issue #480). The *static* yellow drives the legacy
  // `flag.yellow.raised {scope}` event; the waving variants are separate
  // callouts. A static→waving escalation must not surface the static line.
  const yellowWaving = hasFlag(sessionFlags, Flags.YellowWaving);
  const cautionWaving = hasFlag(sessionFlags, Flags.CautionWaving);
  const localStatic = hasFlag(sessionFlags, Flags.Yellow) && !yellowWaving;
  const fullStatic = hasFlag(sessionFlags, Flags.Caution) && !cautionWaving;

  if (localStatic || fullStatic) {
    flags.add("yellow");
    yellowScope = fullStatic ? "full" : "local";
  }

  if (yellowWaving) flags.add("yellow-waving");

  if (cautionWaving) flags.add("caution-waving");

  // `anyYellow` is the true "is the field under any caution" signal, used for
  // the `flag.yellow.cleared` edge — independent of the static `"yellow"` key
  // (which leaves `activeFlags` on a static→waving escalation). Derived from
  // the four locals (localStatic || yellowWaving === Yellow || yellowWaving).
  const anyYellow = localStatic || yellowWaving || fullStatic || cautionWaving;

  if (hasFlag(sessionFlags, Flags.Blue)) flags.add("blue");

  // Disqualify carries its own dedicated line; don't ALSO fire the generic
  // `black` callout when both bits are set (the pre-#480 code merged them into
  // one). Disqualify-only and Black-only each still fire their own callout.
  if (hasFlag(sessionFlags, Flags.Black) && !hasFlag(sessionFlags, Flags.Disqualify)) flags.add("black");

  if (hasFlag(sessionFlags, Flags.Disqualify)) flags.add("disqualify");

  if (hasFlag(sessionFlags, Flags.Furled)) flags.add("furled");

  if (hasFlag(sessionFlags, Flags.DqScoringInvalid)) flags.add("dq-scoring-invalid");

  if (hasFlag(sessionFlags, Flags.Red)) flags.add("red");

  if (hasFlag(sessionFlags, Flags.White)) flags.add("white");

  if (hasFlag(sessionFlags, Flags.Checkered)) flags.add("checkered");

  if (hasFlag(sessionFlags, Flags.Debris)) flags.add("debris");

  // Meatball ("come in to pits, you have damage") — `Flags.Repair` in the SDK enum.
  if (hasFlag(sessionFlags, Flags.Repair)) flags.add("meatball");

  // Race-progression flags (issue #480). NOTE: the rolling-start "one pace lap
  // to go" cue is NOT here — iRacing's `OneLapToGreen` bit is "formation in
  // progress" (set for the whole parade, re-set in cool-down), so it's driven
  // by a start/finish-crossing heuristic in `diff/pace-laps.ts` (issue #657).
  if (hasFlag(sessionFlags, Flags.Crossed)) flags.add("crossed");

  if (hasFlag(sessionFlags, Flags.GreenHeld)) flags.add("green-held");

  if (hasFlag(sessionFlags, Flags.TenToGo)) flags.add("ten-to-go");

  if (hasFlag(sessionFlags, Flags.FiveToGo)) flags.add("five-to-go");

  // Race-start sets both green and blue bits — suppress blue.
  if (flags.has("green") && flags.has("blue")) flags.delete("blue");

  return { flags, yellowScope, anyYellow };
}

export function diffFlags(
  state: TranslatorState,
  telemetry: TelemetryData,
  now: number,
  emit: EmitFn,
  isRaceSession = false,
  playerIsLeader = false,
  isPracticeSession = false,
): void {
  const sessionFlags = telemetry.SessionFlags ?? 0;
  const { flags: current, yellowScope, anyYellow } = resolveActiveFlags(sessionFlags);

  // Player S/F crossing tracking (issue #771). A scored `LapCompleted`
  // increment is the player taking the line — the signal the checkered
  // deferral resolves on. A decrement (session restart resets the counter)
  // just moves the baseline.
  const lapCompleted =
    typeof telemetry.LapCompleted === "number" && Number.isFinite(telemetry.LapCompleted)
      ? telemetry.LapCompleted
      : null;

  // First tick — seed without firing. The checkered-deferral fields
  // (`checkeredPendingCross`, `flagLastCrossedAt`) are deliberately NOT reset
  // here: they default via `createInitialState()` on a genuine first seed,
  // and the translator's replay-tick wipe preserves them so a mid-deferral
  // replay glance can't silently swallow a pending checkered (issue #771) —
  // a seed-time reset would clobber that preservation.
  if (!state.flagStateInitialized) {
    state.flagStateInitialized = true;
    state.activeFlags = current as Set<string>;
    state.lastYellowScope = yellowScope;
    state.lastAnyYellow = anyYellow;
    state.yellowClearPendingSince = null;
    state.furledPendingAt = 0;
    state.furledAnnounced = false;
    state.flagLastLapCompleted = lapCompleted;

    return;
  }

  const crossedThisTick =
    lapCompleted !== null && state.flagLastLapCompleted !== null && lapCompleted > state.flagLastLapCompleted;

  if (lapCompleted !== null) state.flagLastLapCompleted = lapCompleted;

  if (crossedThisTick) state.flagLastCrossedAt = now;

  // The player's own crossing plausibly raised a flag this tick: they lead a
  // RACE (per the canonical live order, passed in by `handleTick`) and their
  // scored crossing landed on the raise tick or within the grace window.
  // Observed iRacing behavior shows the white/checkered AHEAD of a car's
  // crossing (even the leader's), so this is a SAFETY NET for any timing
  // where the bit instead trails the leader's crossing by a tick or two
  // (see FLAG_CROSS_GRACE_MS). Consumed by the checkered deferral (issue
  // #771) and the white two-stage split (issue #772).
  const leaderTookTheLine =
    isRaceSession &&
    playerIsLeader &&
    (crossedThisTick || (state.flagLastCrossedAt !== 0 && now - state.flagLastCrossedAt <= FLAG_CROSS_GRACE_MS));

  // Set when the checkered raise arms its deferral on THIS tick — the
  // resolution block below must not consume a crossing that landed on the
  // raise tick itself (a non-leader crossing just as the flag rises predates
  // the flag and is scored for one more lap).
  let checkeredPendingSetThisTick = false;

  // New "raised" transitions
  for (const flag of current) {
    if (!state.activeFlags.has(flag)) {
      switch (flag) {
        case "yellow":
          emit({ event: "flag.yellow.raised", data: { scope: yellowScope ?? "local" } });
          break;
        case "green":
          // Suppress green at a race start — the start-light family owns the
          // "go" (issue #480). Guard on StartGo OR StartSet so a green that
          // leads StartGo by a tick (still in the red-lights phase) is also
          // suppressed. Restarts have neither bit set, so green still fires.
          if (!hasFlag(sessionFlags, Flags.StartGo) && !hasFlag(sessionFlags, Flags.StartSet)) {
            emit({ event: "flag.green.raised", data: {} });
          }

          break;
        case "blue":
          emit({ event: "flag.blue.raised", data: {} });
          break;
        case "black":
          emit({ event: "flag.black.raised", data: {} });
          break;
        case "disqualify":
          emit({ event: "flag.disqualify.raised", data: {} });
          break;
        // NOTE: no "furled" case — the furled rising edge is owned by the
        // debounce block below (issue #669).
        case "dq-scoring-invalid":
          emit({ event: "flag.dq-scoring-invalid.raised", data: {} });
          break;
        case "red":
          emit({ event: "flag.red.raised", data: {} });
          break;
        case "white":
          // Two-stage white (issue #772): the raise is the heads-up
          // ("about to start the final lap" — iRacing shows the white while
          // the leader is still ~5-10 s from the line); the player's S/F
          // crossing under the flag is the definitive last-lap call. Should
          // the raise ever land at/after the race leader's own crossing
          // (`leaderTookTheLine` — race- and leader-gated), skip the
          // heads-up and speak the last-lap line directly — playing both
          // back-to-back would preempt one mid-sentence.
          // Practice/qualifying always take the plain raise: their white is
          // shown when the PLAYER starts their own final lap, so the split
          // would swallow the callout (the last-lap scenario is race-only).
          if (leaderTookTheLine) {
            emit({ event: "flag.white-last-lap.raised", data: {} });
            state.whiteLastLapFired = true;
          } else {
            emit({ event: "flag.white.raised", data: {} });
            state.whiteRaisedAt = now;
          }

          break;
        case "checkered": {
          // Deferral (issue #771) — iRacing raises the bit for the whole
          // field at once; hold the callout until the player takes the flag
          // at the line. Practice/testing speaks IMMEDIATELY: the flag there
          // just means the session is over — there is no flag-taking lap,
          // so waiting for a crossing would only delay the news. Also
          // immediate when the player isn't in the car, crossings can't be
          // tracked (never hold a callout hostage to missing data), the
          // player is already in the pits in qualifying (parked in the box
          // at expiry — the common case; no crossing is ever coming), or
          // the player's own finish raised the flag (`leaderTookTheLine` —
          // race-gated, and a same-tick crossing counts only for the leader
          // too, since a mid-pack car crossing on the raise tick is scored
          // for one more lap). In a race, a car on pit road at the raise
          // still defers — it finishes by crossing the line.
          const parkedInPits =
            !isRaceSession && (telemetry.OnPitRoad === true || telemetry.PlayerCarInPitStall === true);

          if (
            isPracticeSession ||
            telemetry.IsOnTrack !== true ||
            lapCompleted === null ||
            parkedInPits ||
            leaderTookTheLine
          ) {
            emit({ event: "flag.checkered.raised", data: {} });
          } else {
            state.checkeredPendingCross = true;
            checkeredPendingSetThisTick = true;
          }

          break;
        }
        case "debris":
          emit({ event: "flag.debris.raised", data: {} });
          break;
        case "meatball":
          emit({ event: "flag.meatball.raised", data: {} });
          break;
        case "crossed":
          emit({ event: "flag.crossed.raised", data: {} });
          break;
        case "green-held":
          emit({ event: "flag.green-held.raised", data: {} });
          break;
        case "ten-to-go":
          emit({ event: "flag.ten-to-go.raised", data: {} });
          break;
        case "five-to-go":
          emit({ event: "flag.five-to-go.raised", data: {} });
          break;
        case "yellow-waving":
          emit({ event: "flag.yellow-waving.raised", data: {} });
          break;
        case "caution-waving":
          emit({ event: "flag.caution-waving.raised", data: {} });
          break;
      }
    }
  }

  // Deferred checkered resolution (issue #771): the flag is flying and the
  // callout is waiting for the player to take it at the line. Resolves on
  // the player's next scored S/F crossing; immediately when the player
  // leaves the car (tow / garage — they will never take the flag, so speak
  // now rather than never); or, outside a race, when they drive into the
  // pits (an in-lap after the qualifying checkered ends their session —
  // a race car in the pits still finishes by crossing the line, so races
  // keep waiting). If the bit drops while still pending (cool-down rolling
  // into the next session's grid), the stale fire dies silently — the flag
  // is no longer flying. The raise tick is skipped (`checkeredPendingSetThisTick`)
  // so a crossing that landed on the raise tick itself — which predates the
  // flag — can't resolve the deferral it just armed.
  if (state.checkeredPendingCross && !checkeredPendingSetThisTick) {
    const enteredPits = !isRaceSession && (telemetry.OnPitRoad === true || telemetry.PlayerCarInPitStall === true);

    if (!current.has("checkered")) {
      state.checkeredPendingCross = false;
    } else if (crossedThisTick || telemetry.IsOnTrack === false || enteredPits) {
      emit({ event: "flag.checkered.raised", data: {} });
      state.checkeredPendingCross = false;
    }
  }

  // Last-lap start (issue #772) — race sessions only: the player crosses S/F
  // while the white flag flies, starting THEIR last lap. Latched once per
  // white episode; the latch and the raise timestamp re-arm when the flag
  // drops. Two extra guards: the checkered must not be up (the two bits can
  // overlap for a tick on the finish crossing — the checkered call owns that
  // crossing), and the crossing must land at least WHITE_LAST_LAP_MIN_GAP_MS
  // after the heads-up — a close follower crosses seconds after the leader
  // raised the white, and firing stage 2 then would same-family-preempt the
  // still-playing heads-up mid-sentence (a crossing inside the gap is
  // already covered by the heads-up that just played, so it's skipped, not
  // delayed). A zero raise timestamp (connect mid-white — no heads-up was
  // ever spoken) allows the last-lap line immediately. The raise-tick leader
  // case above already latched, so it can't double-fire here.
  if (!current.has("white")) {
    state.whiteLastLapFired = false;
    state.whiteRaisedAt = 0;
  } else if (
    isRaceSession &&
    !state.whiteLastLapFired &&
    crossedThisTick &&
    !current.has("checkered") &&
    (state.whiteRaisedAt === 0 || now - state.whiteRaisedAt >= WHITE_LAST_LAP_MIN_GAP_MS)
  ) {
    emit({ event: "flag.white-last-lap.raised", data: {} });
    state.whiteLastLapFired = true;
  }

  // Yellow cleared transition (issue #671 — validated clear). The drop edge
  // (ALL yellow-ish bits clear after at least one was set — NOT a
  // static→waving escalation) only ARMS the hold window; the event fires
  // once the all-clear has been sustained for YELLOW_CLEARED_HOLD_MS, and
  // any yellow-ish re-raise meanwhile cancels the pending clear.
  if (anyYellow) {
    state.yellowClearPendingSince = null;
  } else if (state.lastAnyYellow) {
    state.yellowClearPendingSince = now;
  } else if (state.yellowClearPendingSince !== null && now - state.yellowClearPendingSince >= YELLOW_CLEARED_HOLD_MS) {
    emit({ event: "flag.yellow.cleared", data: {} });
    state.yellowClearPendingSince = null;
  }

  // Furled debounce + paired cleared (issue #669). The rising edge only ARMS
  // the debounce window — running briefly off track flashes the bit for
  // ~0.5 s without a genuine warning. The raised callout fires once the bit
  // has stayed set for FURLED_DEBOUNCE_MS; the cleared callout fires on the
  // falling edge only when the raised callout was actually announced, so a
  // transient flicker fires neither. Connect-while-furled seeds silently
  // (no rising edge), matching every other flag. NOTE: `state.activeFlags`
  // still holds the PREVIOUS tick's set here — the baseline advances below.
  const furledNow = current.has("furled");

  if (!furledNow) {
    state.furledPendingAt = 0;

    if (state.furledAnnounced) {
      emit({ event: "flag.furled.cleared", data: {} });
      state.furledAnnounced = false;
    }
  } else if (!state.activeFlags.has("furled")) {
    state.furledPendingAt = now;
  } else if (state.furledPendingAt !== 0 && now - state.furledPendingAt >= FURLED_DEBOUNCE_MS) {
    emit({ event: "flag.furled.raised", data: {} });
    state.furledAnnounced = true;
    state.furledPendingAt = 0;
  }

  state.activeFlags = current as Set<string>;
  state.lastYellowScope = yellowScope;
  state.lastAnyYellow = anyYellow;
}
