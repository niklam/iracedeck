/**
 * The full-course caution sequence (issue #1127): the pace car's comings and
 * goings, the pickup, the laps behind it, one to go, and the restart.
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
 * **The episode** is one state machine per caution, driven by `SessionFlags`
 * edges and the leader's scored crossings:
 *
 * - **Waving** — `CautionWaving` is set: the caution is out and the field is
 *   still spread around the track.
 * - **Caught** — `Caution` is set and `CautionWaving` has gone. The pickup is a
 *   flag DE-ESCALATION, not a new yellow, and it lands on the leader's
 *   start/finish crossing about 90 s after the throw (measured at 333.57 and
 *   630.95). A `Caution` that was never preceded by a watched `CautionWaving`
 *   moves to this phase WITHOUT emitting: the pickup is a transition we have to
 *   have seen to report, so a plugin started mid-caution — and a discipline
 *   whose cautions may not wave first — is never told the field has just been
 *   caught.
 * - **One to go** — `OneLapToGreen` rises while caught. By then `PaceMode` is a
 *   RESTART mode (2 or 3 in the capture, never a start mode), so
 *   `DoubleFileRestart` is the double-file reading and everything else single.
 * - **Restarted** — `Green` rises while a caution is out. Deliberately not
 *   gated on `StartGo`: a restart does carry it (which is why the green-flag
 *   callout has never spoken at one), but nothing here needs to tell a restart
 *   apart from a race start — a race start finds no caution phase to end.
 *
 * **The pickup consumes the crossing it landed on.** The static flag precedes
 * the leader's `CarIdxLapCompleted` increment by about half a second in both
 * captured cautions (333.57 → 334.07, 630.95 → 631.43), so counting that
 * increment would report an extra lap at every single pickup. The baseline is
 * therefore moved one past the leader's PRE-pickup lap — pre-pickup rather than
 * current, so the swallow still lands on the right crossing were iRacing ever
 * to score the counter before flipping the flag.
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
 * **The leader is the car on pace row 1** — row 0 is the pace car — with the
 * official `CarIdxPosition` leader as the fallback for when no row is assigned.
 * Under a caution the pace rows are the authority, a deliberate exception to
 * `@.claude/rules/race-positions.md`: they ARE the restart order, and the
 * capture shows them leading the official positions by up to a lap.
 */
import { Flags, hasFlag, PaceMode, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { resolvePaceCarIdx } from "./pace-laps.js";
import type { EmitFn } from "./types.js";

/** The pace car is on the road when its surface is a track surface rather than a pit one. */
function onTrack(surface: number | undefined): boolean {
  return surface === TrkLoc.OnTrack || surface === TrkLoc.OffTrack;
}

/**
 * The car at the front of the field's own pace order — row 1, since row 0 is
 * the pace car — falling back to the official leader, which is all there is
 * outside a caution (the pace arrays read −1 for every car).
 */
function resolveLeaderIdx(telemetry: TelemetryData): number | null {
  const rows = telemetry.CarIdxPaceRow;

  if (Array.isArray(rows)) {
    const byRow = rows.indexOf(1);

    if (byRow >= 0) return byRow;
  }

  const positions = telemetry.CarIdxPosition;

  if (Array.isArray(positions)) {
    const byPosition = positions.indexOf(1);

    if (byPosition >= 0) return byPosition;
  }

  return null;
}

/**
 * The leader's scored lap count, or `null` when it can't be read — iRacing's
 * −1 sentinel included, since a baseline taken from it would report the first
 * real value as a crossing.
 */
function resolveLeaderLapCompleted(telemetry: TelemetryData): number | null {
  const idx = resolveLeaderIdx(telemetry);
  const laps = telemetry.CarIdxLapCompleted;

  if (idx === null || !Array.isArray(laps)) return null;

  const lap = laps[idx];

  return typeof lap === "number" && lap >= 0 ? lap : null;
}

export function diffCaution(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  const paceCarIdx = resolvePaceCarIdx(sessionInfo);
  const surfaces = telemetry.CarIdxTrackSurface;
  const surface = paceCarIdx !== null && Array.isArray(surfaces) ? surfaces[paceCarIdx] : undefined;

  const flags = telemetry.SessionFlags ?? 0;
  const waving = hasFlag(flags, Flags.CautionWaving);
  const caution = hasFlag(flags, Flags.Caution);
  const oneToGo = hasFlag(flags, Flags.OneLapToGreen);
  const leaderLap = resolveLeaderLapCompleted(telemetry);

  if (!state.cautionInitialized) {
    state.cautionInitialized = true;
    state.cautionPaceCarSurface = surface ?? null;
    state.cautionLastFlags = flags;
    state.cautionLeaderLapCompleted = leaderLap;
    // `cautionPhase` is deliberately left alone: a phase preserved across a
    // replay wipe must survive the re-seed, and a phase derived from the bits
    // here would claim knowledge of an episode this run never watched begin.

    return;
  }

  const wasSurface = state.cautionPaceCarSurface;
  const wasFlags = state.cautionLastFlags;
  const wasLeaderLap = state.cautionLeaderLapCompleted;

  state.cautionPaceCarSurface = surface ?? null;
  state.cautionLastFlags = flags;

  if (surface !== undefined && wasSurface !== null) {
    if (!onTrack(wasSurface) && onTrack(surface)) emit({ event: "paceCar.deployed", data: {} });
    else if (onTrack(wasSurface) && !onTrack(surface)) emit({ event: "paceCar.off", data: {} });
  }

  // The crossing baseline for THIS tick — the pickup below may move it past the
  // leader's own counter, so the extra-lap test reads this rather than state.
  let crossingBaseline = wasLeaderLap;

  if (hasFlag(flags, Flags.Green) && !hasFlag(wasFlags, Flags.Green) && state.cautionPhase !== "none") {
    emit({ event: "caution.restarted", data: {} });
    state.cautionPhase = "none";
  } else if (waving) {
    state.cautionPhase = "waving";
  } else if (caution && state.cautionPhase === "waving") {
    emit({ event: "caution.fieldCaught", data: { restartPosition: null } });
    state.cautionPhase = "caught";

    // Consume the leader crossing the pickup itself landed on; see the module
    // comment. `wasLeaderLap` is the pre-pickup reading, so this points at the
    // crossing being scored whichever side of the flag the counter lands on.
    const pickupLap = wasLeaderLap ?? leaderLap;

    if (pickupLap !== null) crossingBaseline = pickupLap + 1;
  } else if (caution && state.cautionPhase === "none") {
    state.cautionPhase = "caught";
  }

  if (oneToGo && !hasFlag(wasFlags, Flags.OneLapToGreen) && state.cautionPhase === "caught") {
    const file = telemetry.PaceMode === PaceMode.DoubleFileRestart ? "double" : "single";

    emit({ event: "caution.oneLapToGreen", data: { file } });
    state.cautionPhase = "one-to-go";
  } else if (
    state.cautionPhase === "caught" &&
    !oneToGo &&
    leaderLap !== null &&
    crossingBaseline !== null &&
    leaderLap > crossingBaseline
  ) {
    emit({ event: "caution.extraLap", data: {} });
  }

  // High-water, never lowered: it carries the pickup's consumed crossing until
  // the counter catches up, and a leader swap to a car with fewer laps scored
  // then goes quiet rather than manufacturing an extra lap.
  state.cautionLeaderLapCompleted =
    leaderLap === null || (crossingBaseline !== null && crossingBaseline > leaderLap) ? crossingBaseline : leaderLap;
}
