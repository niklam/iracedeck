/**
 * The full-course caution sequence (issue #1127): the pace car's comings and
 * goings, the pickup, the laps behind it, one to go, and the restart.
 *
 * Two unrelated jobs against two unrelated signals, so two functions behind one
 * entry point — {@link diffPaceCar} reads the pace car's track surface,
 * {@link diffCautionEpisode} reads the flags and the leader's crossings, and
 * each seeds its own baselines on the diff's first tick. The lineup is a third
 * reading, of the pace arrays, and lives in `caution-lineup.ts` as a pure
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
 * **The phase also EXPIRES**, the moment neither caution bit is set, and that
 * is a safety property rather than a tidy-up. A green rising edge is not a
 * reliable end marker: the tick that re-seeds after a replay glance swallows
 * every edge it spans, and glancing at the replay to see the incident is
 * ordinary driver behaviour under a yellow. A phase left standing would call
 * every green-flag leader crossing for the rest of the session an extra lap
 * under caution. The expiry is therefore the SOLE guarantee that a `"caught"`
 * phase means the caution is still out, and the extra-lap branch rests on it
 * rather than re-testing the bit.
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
 * exception, and belongs to `caution-lineup.ts`, which also carries the
 * interleave the two lines restart in and why the pace car anchors it.)
 */
import { Flags, hasFlag, PaceMode, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { type CautionLineup, isOvalTrack, resolveCautionLineup } from "./caution-lineup.js";
import { resolvePaceCarIdx } from "./pace-laps.js";
import type { EmitFn } from "./types.js";

/** The pace car is on the road when its surface is a track surface rather than a pit one. */
function onTrack(surface: number | undefined): boolean {
  return surface === TrkLoc.OnTrack || surface === TrkLoc.OffTrack;
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
  emit: EmitFn,
): void {
  const paceCarIdx = resolvePaceCarIdx(sessionInfo);
  const surfaces = telemetry.CarIdxTrackSurface;
  const surface = paceCarIdx !== null && Array.isArray(surfaces) ? surfaces[paceCarIdx] : undefined;

  if (seeding) {
    state.cautionPaceCarSurface = surface ?? null;

    return;
  }

  const was = state.cautionPaceCarSurface;

  state.cautionPaceCarSurface = surface ?? null;

  if (surface === undefined || was === null) return;

  if (!onTrack(was) && onTrack(surface)) emit({ event: "paceCar.deployed", data: {} });
  else if (onTrack(was) && !onTrack(surface)) emit({ event: "paceCar.off", data: {} });
}

/**
 * The caution's own phases: the pickup, the laps behind the pace car, one to
 * go, and the restart. Seeds the flag and crossing baselines silently — but
 * deliberately NOT the phase, which is left at whatever it holds, so the value
 * preserved across a replay wipe survives the re-seed and a fresh connect
 * reports only the transitions it actually watched.
 */
function diffCautionEpisode(
  state: TranslatorState,
  telemetry: TelemetryData,
  lineup: CautionLineup | null,
  canonicalPositions: number[] | null,
  seeding: boolean,
  emit: EmitFn,
): void {
  const flags = telemetry.SessionFlags ?? 0;
  const waving = hasFlag(flags, Flags.CautionWaving);
  const caution = hasFlag(flags, Flags.Caution);
  const oneToGo = hasFlag(flags, Flags.OneLapToGreen);
  const leaderLap = resolveLeaderLapCompleted(telemetry, canonicalPositions);

  if (seeding) {
    state.cautionLastFlags = flags;
    state.cautionLeaderLapCompleted = leaderLap;

    return;
  }

  const wasFlags = state.cautionLastFlags;
  const wasLeaderLap = state.cautionLeaderLapCompleted;

  state.cautionLastFlags = flags;

  // The crossing baseline for THIS tick — the pickup below may move it past the
  // leader's own counter, so the extra-lap test reads this rather than state.
  let crossingBaseline = wasLeaderLap;

  // The precedence below is load-bearing: a green rising edge ends the episode
  // before anything else can read it, a waving caution outranks a static one
  // (both bits can be set), a static caution the diff watched wave is the
  // pickup, one it did not is caught silently, and with neither bit set the
  // phase expires.
  if (hasFlag(flags, Flags.Green) && !hasFlag(wasFlags, Flags.Green) && state.cautionPhase !== "none") {
    emit({ event: "caution.restarted", data: {} });
    state.cautionPhase = "none";
  } else if (waving) {
    state.cautionPhase = "waving";
  } else if (caution && state.cautionPhase === "waving") {
    emit({ event: "caution.fieldCaught", data: { restartPosition: lineup?.restartPosition ?? null } });
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
  } else if (caution && state.cautionPhase === "none") {
    state.cautionPhase = "caught";

    // Re-anchor rather than carry the baseline in: this is an episode the diff
    // never watched begin, so whatever the leader last scored under a lineup —
    // possibly the previous caution's — says nothing about laps run behind
    // this pace car.
    crossingBaseline = leaderLap;
  } else if (!caution && !waving) {
    state.cautionPhase = "none";
  }

  if (oneToGo && !hasFlag(wasFlags, Flags.OneLapToGreen) && state.cautionPhase === "caught") {
    const file = telemetry.PaceMode === PaceMode.DoubleFileRestart ? "double" : "single";

    emit({ event: "caution.oneLapToGreen", data: { file } });
    state.cautionPhase = "one-to-go";
    // Reaching the branch below means the caution is still out, and the expiry
    // above is what guarantees it: with neither bit set the phase has already
    // returned to "none", and a tick carrying only `CautionWaving` has moved it
    // to "waving" — so `"caught"` implies `Caution`. Stated rather than
    // re-tested, because a term no test can fail is one the next reader either
    // trusts (and relaxes the expiry behind) or deletes without knowing what it
    // stood for.
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

  // Last, so it reads the phase this tick actually settled on.
  diffLineup(state, flags, lineup, emit);
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
 */
function diffLineup(state: TranslatorState, flags: number, lineup: CautionLineup | null, emit: EmitFn): void {
  if (state.cautionPhase === "none" || hasFlag(flags, Flags.Green)) {
    state.cautionFollowCarIdx = null;

    return;
  }

  if (lineup === null || lineup.followCarIdx === null) return;

  const was = state.cautionFollowCarIdx;

  state.cautionFollowCarIdx = lineup.followCarIdx;

  if (was === null || was === lineup.followCarIdx) return;

  emit({
    event: "caution.lineup.changed",
    data: {
      followCarIdx: lineup.followCarIdx,
      followCarNumber: lineup.followCarNumber,
      line: lineup.line,
      isLeader: lineup.isLeader,
    },
  });
}

export function diffCaution(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  canonicalPositions: number[] | null,
  emit: EmitFn,
): void {
  const seeding = !state.cautionInitialized;

  state.cautionInitialized = true;

  // Read once and shared: the pickup's restart position and the follow-car
  // change are two readings of the same lineup, and resolving it twice is how
  // an event pair that must agree starts disagreeing.
  const lineup = resolveCautionLineup(telemetry, sessionInfo, isOvalTrack(sessionInfo));

  diffPaceCar(state, telemetry, sessionInfo, seeding, emit);
  diffCautionEpisode(state, telemetry, lineup, canonicalPositions, seeding, emit);
}
