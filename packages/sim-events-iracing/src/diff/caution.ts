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
 * exception, and belongs to `caution-lineup.ts`, which also carries the
 * interleave the two lines restart in and why the pace car anchors it.)
 */
import { Flags, hasFlag, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";

import type { TranslatorState } from "../state.js";
import { isOvalTrack } from "../track-type.js";
import { resolveCautionLineup } from "./caution-lineup.js";
import { resolvePaceCarIdx } from "./pace-laps.js";
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

  // A tick that cannot read the pace car — session info naming none, or no
  // surface array — is a gap in the reading, not a reading. The baseline is
  // kept through it, so a transition that straddles the gap is still an edge
  // on the next tick that can read; writing `null` here instead would turn
  // that tick into a fresh seed and swallow "Pace car's out" for good.
  if (surface === undefined) return;

  const was = state.cautionPaceCarSurface;

  state.cautionPaceCarSurface = surface;

  if (was === null) return;

  if (!onTrack(was) && onTrack(surface)) emit({ event: "paceCar.deployed", data: {} });
  else if (onTrack(was) && !onTrack(surface)) emit({ event: "paceCar.off", data: {} });
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
  emit: EmitFn,
  now: number,
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
  if (green && !hasFlag(wasFlags, Flags.Green) && state.cautionPhase !== "none" && !caution && !waving) {
    // The restart: the green rising AND the caution bits gone on the same
    // tick, which is what both captures show. A green rising with `Caution`
    // still set (a yellow-checkered tick) is deliberately not this branch —
    // see the module comment — and falls through to leave the phase where it
    // is, so no "Go, go, go!" reaches a driver who must not go.
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

  // Last, so it reads the phase this tick actually settled on.
  diffLineup(state, telemetry, sessionInfo, emit);
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
  emit: EmitFn,
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
 * over the car slots, and this is its only reader — so on the green-flag
 * ticks that are almost every tick of a race, nothing is resolved at all.
 */
function diffLineup(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  emit: EmitFn,
): void {
  if (state.cautionPhase === "none" || hasFlag(telemetry.SessionFlags ?? 0, Flags.Green)) {
    state.cautionFollowCarIdx = null;

    return;
  }

  const lineup = resolveCautionLineup(telemetry, sessionInfo, isOvalTrack(sessionInfo));

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

/**
 * `now` is the tick's clock (ms), the same value `diffFlags` takes: it stamps
 * the restart so `diffStartLights` can hold the race-start line down for a
 * `StartGo` trailing the green. Defaulted for the tests that never reach a
 * restart; the translator always passes its own.
 */
export function diffCaution(
  state: TranslatorState,
  telemetry: TelemetryData,
  sessionInfo: Record<string, unknown> | null,
  canonicalPositions: number[] | null,
  emit: EmitFn,
  now: number = Date.now(),
): void {
  const seeding = !state.cautionInitialized;

  state.cautionInitialized = true;

  diffPaceCar(state, telemetry, sessionInfo, seeding, emit);
  diffCautionEpisode(state, telemetry, sessionInfo, canonicalPositions, seeding, emit, now);
}
