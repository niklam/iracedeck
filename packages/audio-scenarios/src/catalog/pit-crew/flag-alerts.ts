/**
 * Flag alert contracts — one contract per flag transition the translator
 * publishes. This is the first family migrated to pack-owned scripts (issue
 * #1064): the code below decides WHETHER and WHEN the engineer speaks and
 * how the fire is scheduled; WHAT he says lives in the active voice's
 * `callouts.json` under the same ids (`scenarios["pit-crew.flag-red"]`,
 * …), paired at `setScripts` time. A voice whose script has no entry for a
 * flag is silent for it — absent means skipped, never an error.
 *
 * **Pool-driven clips.** Every flag line is a pool — all the takes sharing
 * one `(group, base)` in the voice's manifest — and the script addresses
 * each one directly as `pool:flags/<base>` (`pool:flags/yellow-local`,
 * `pool:flags/blue`), even the single-clip flags. The interpreter picks
 * from multi-element pools at random (no immediate repeat) and resolves
 * single-element pools deterministically, so adding a variant is a
 * clip-file change, not a code change. No flag pool carries a NAME: a
 * script's `pools` key is an alias facility, worth using only where the
 * name decides something the path does not (an alias onto another group,
 * or a second line that must not share a no-repeat tracker with the first),
 * and every flag name would merely have restated its path. The thirty
 * sources are pinned here in {@link FLAG_CLIP_SOURCES} for the completeness
 * tests; the clips themselves are authored in
 * `packages/audio-assets/configs/default.voice.json`.
 *
 * **Family preemption.** All non-meatball flag contracts share
 * `family: "flag"` so a newer flag callout supersedes the in-flight one
 * (yellow → green at restart no longer plays both back-to-back; whichever
 * flag fires last wins). Meatball is intentionally excluded from the
 * family — we want it to preempt anything in flight (handled by
 * `weight: WEIGHT.CRITICAL` + `interrupt: true`), but we do NOT want a routine
 * yellow to cancel a still-playing meatball.
 *
 * **Yellow scope.** `flag.yellow.raised` carries `data.scope` (`"local"` or
 * `"full"` — set by the translator from the iRacing SessionFlags bits).
 * Two contracts filter on the scope so we get a meaningfully different
 * line for full-course yellows ("pace car deployed") vs local sector
 * yellows ("mind the slow cars").
 *
 * **Session-aware flags.** Green, white and checkered all have three
 * recorded variants — practice, qualifying, race — because the engineer's
 * wording differs per session ("that's it for the race, well done" only
 * fits after a race; a green-flag "push now!" only fits a race start).
 * The script branches on the `session.type` case var registered by
 * {@link registerFlagVocabulary}; the key comes from code, the mapping from
 * the pack.
 *
 * **Yellow-cleared delivery + waving debounce (issue #671).**
 * `flag.yellow.cleared` is a one-shot event, so the cleared contract is
 * `queueable` — a fire deferred behind an equal-weight non-flag line
 * (spotter call, pit chatter) replays when the bus idles instead of being
 * silently dropped. The waving contracts carry a 30 s `cooldown`
 * ({@link WAVING_FLAG_COOLDOWN_MS}) because iRacing re-raises the waving
 * bits on every re-approach of a persistent incident zone.
 *
 * **Penalty-flag delivery (issue #923).** The penalty raises — `BLACK`,
 * `DISQUALIFY`, `DQ_SCORING_INVALID` — are `queueable`: each is a one-shot
 * edge that never re-fires, and a raise landing while an equal- or
 * higher-weight line held the Voice bus (another flag, a spotter call, a
 * CRITICAL line) was silently dropped — a penalty the driver was never told
 * about. The penalty is a sustained state (serving requires a pit visit), so
 * a replay a few seconds late is always still correct and no speak-time gate
 * is needed (the #867 meatball reasoning); a black→DQ escalation while
 * queued resolves structurally — the queueable DQ fire replaces the pending
 * black in the single pending slot (equal weight, ties → newest).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventName, SimEventOf } from "@iracedeck/event-bus";
import {
  Flags,
  hasFlag,
  isLiveOnTrack,
  isPenaltyFlagActive,
  isPostRace,
  isPreGreen,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import { getLatestTelemetry, getSessionType, getStandingStart } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { classifySessionType, isRaceSession, type SessionKind } from "./race-start.js";

// Race-progression / formation flags (one-pace-lap-to-go, green-held, ten-to-go,
// five-to-go, crossed) are race-only concepts. iRacing raises the grid bits
// while forming the race grid at the END of a qualifying session, so without
// this gate they fired at the qualifying checkered (issue #480 follow-up).
// Live-read at fire time, mirroring the session branching the
// green/white/checkered scripts do through `session.type`.
const raceOnly = () => isRaceSession(getSessionType());

// These callouts only make sense to a driver IN the car and live, so also gate
// on `isLiveOnTrack` — silent while out of the car at the grid / in a replay
// (issue #480 follow-up). And gate OFF after the race finishes (`isPostRace` —
// Checkered / CoolDown): iRacing re-asserts the grid bits during cool-down /
// next-session grid formation, which would otherwise re-fire the bit-driven
// progression callouts (crossed / green-held / ten- / five-to-go) after the
// checkered — the #657 post-race misfire. (`one-pace-lap-to-go` is additionally
// ParadeLaps-gated in its own diff, so it can't reach post-race regardless.)
// Read from the event's telemetry at fire time.
const liveRaceCar = (e: SimEventOf<SimEventName>): boolean =>
  raceOnly() && isLiveOnTrack(e.telemetry as TelemetryData | null) && !isPostRace(e.telemetry as TelemetryData | null);

// Rolling-only formation cue (green-held). A standing start has no pace lap, yet
// iRacing sets the grid bits throughout the standing grid — so suppress during a
// standing-start pre-green phase (the start-light family owns that lead-in).
// Restarts (Racing state) and rolling starts still fire (issue #480 follow-up).
// (The sibling "one pace lap to go" cue is gated rolling-only in its diff
// instead — `diff/pace-laps.ts`, issue #657 — so it uses `liveRaceCar` here.)
const rollingFormationOnly = (e: SimEventOf<SimEventName>): boolean =>
  liveRaceCar(e) && !(getStandingStart() && isPreGreen(e.telemetry as TelemetryData | null));

function flagContract(id: string): ScenarioContract {
  return {
    id: `pit-crew.flag-${id}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    family: "flag",
  };
}

const YELLOW_LOCAL: ScenarioContract = {
  ...flagContract("yellow-local"),
  when: {
    event: "flag.yellow.raised",
    where: (e) => (e as SimEventOf<"flag.yellow.raised">).data.scope === "local",
  },
};

const YELLOW_FULL: ScenarioContract = {
  ...flagContract("yellow-full"),
  when: {
    event: "flag.yellow.raised",
    where: (e) => (e as SimEventOf<"flag.yellow.raised">).data.scope === "full",
  },
};

// `queueable: true` (issue #671) mirrors the FURLED precedent below: the
// cleared event is one-shot and the all-clear is a sustained state, so a fire
// deferred behind an equal-weight line (spotter call, pit chatter) must replay
// when the bus idles instead of being dropped — the "no Yellow cleared heard"
// bug.
const YELLOW_CLEARED: ScenarioContract = {
  ...flagContract("yellow-cleared"),
  queueable: true,
  when: { event: "flag.yellow.cleared" },
};

const GREEN: ScenarioContract = {
  ...flagContract("green"),
  when: { event: "flag.green.raised" },
};

const BLUE: ScenarioContract = {
  ...flagContract("blue"),
  when: { event: "flag.blue.raised" },
};

const WHITE: ScenarioContract = {
  ...flagContract("white"),
  when: { event: "flag.white.raised" },
};

// Stage 2 of the two-stage white (issue #772): the player crosses S/F while
// the white flag flies — the start of THEIR last lap. Race-only BOTH in the
// translator's diff (in practice/qualifying the white is shown exactly when
// the player starts their own final lap, so a split would swallow the only
// callout those sessions get) and on the contract `where:` here (belt and
// suspenders — it also keeps a harness-fired event honest about the session
// the catalog designed it for). Shares `family: "flag"`, so
// when the player IS the leader the diff skips the heads-up entirely rather
// than letting this fire preempt it mid-sentence. Rides the same
// `calloutEnabledFlagWhite` opt-in as the raise (a stage of the same callout,
// the #572 modifier precedent).
// `queueable: true` (the YELLOW_CLEARED / FURLED precedent): the crossing is
// a one-shot event and the last lap is a sustained state, so a fire deferred
// behind an equal-weight line (a spotter call while battling into the last
// lap — exactly when this fires) must replay when the bus idles instead of
// being silently dropped; the translator's per-episode latch means it would
// never re-fire.
const WHITE_LAST_LAP: ScenarioContract = {
  ...flagContract("white-last-lap"),
  queueable: true,
  when: { event: "flag.white-last-lap.raised", where: () => raceOnly() },
};

// The leader's final lap (issue #936, stage 3 of the white family): fired by
// the translator's lap-count detection — most valuable when we're far behind
// the leader and our own white is still minutes away. The diff latches once
// per race (green re-arms) and suppresses when the player IS the leader or
// already has their own white up, so this can never double up with the
// #772 heads-up. Rides `calloutEnabledFlagWhite` (one subject, the #772
// precedent); `queueable: true` for the same one-shot-latch reason as
// WHITE_LAST_LAP.
const WHITE_LEADER: ScenarioContract = {
  ...flagContract("white-leader"),
  queueable: true,
  when: { event: "flag.white-leader.raised", where: () => raceOnly() },
};

const RED: ScenarioContract = {
  ...flagContract("red"),
  when: { event: "flag.red.raised" },
};

// `queueable: true` (issue #923): a directly-issued black flag — pit-lane
// speeding, a race-admin `!black`, escalation after an ignored meatball —
// arrives with no furled warning phase, and the raise is a one-shot edge that
// never re-fires. Without queueable, a raise landing while an equal-weight
// line (another flag, pit-approach, the spotter info line) or a higher-weight
// line (meatball, a proximity call) held the Voice bus was dropped and the
// driver never told about the penalty. Serving takes a pit visit (≥ 30 s),
// far beyond the seconds a queued fire waits, so a replay at idle is always
// still correct — no speak-time gate (the #867 meatball precedent); a
// black→DQ escalation while queued is covered structurally (the queueable
// DISQUALIFY fire replaces the pending black — equal weight, ties → newest).
const BLACK: ScenarioContract = {
  ...flagContract("black"),
  queueable: true,
  when: { event: "flag.black.raised" },
};

const CHECKERED: ScenarioContract = {
  ...flagContract("checkered"),
  when: { event: "flag.checkered.raised" },
};

const DEBRIS: ScenarioContract = {
  ...flagContract("debris"),
  when: { event: "flag.debris.raised" },
};

// Meatball is the one flag the driver may genuinely miss — failing to
// pit on a meatball is a black-flag penalty. Give it `weight: WEIGHT.CRITICAL`
// with `interrupt: true` so it cuts in-flight engineer chatter mid-message.
// Intentionally NOT in `family: "flag"`: a routine yellow must not cancel
// a still-playing meatball. `queueable: true` (issue #867): a spotter
// proximity call at `WEIGHT.PROXIMITY` outranks the meatball, so a collision
// (either the spotter cutting a playing meatball line, or the meatball raise
// arriving during a spotter clip) defers it for replay the moment the clip
// ends instead of losing the box-for-repairs instruction forever — the raise
// is a one-shot edge that never re-fires, and the instruction stays valid
// until obeyed, so a ~1 s-late replay is always correct.
const MEATBALL: ScenarioContract = {
  id: "pit-crew.flag-meatball",
  when: { event: "flag.meatball.raised" },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  weight: WEIGHT.CRITICAL,
  interrupt: true,
  queueable: true,
};

// Driver-black splits (issue #480). `Disqualify` is split out of the generic
// `black` callout — "Disqualified. Pull off." carries different urgency than a
// routine black flag. `Furled` and `DqScoringInvalid` are new bits the engineer
// previously ignored. All share `family: "flag"` + `WEIGHT.SAFETY` like the
// other flags. `queueable: true` (issue #923): the same one-shot loss paths as
// BLACK above — and a DQ is even more must-hear.
const DISQUALIFY: ScenarioContract = {
  ...flagContract("disqualify"),
  queueable: true,
  when: { event: "flag.disqualify.raised" },
};

// ── Furled raised/cleared pairing state (issue #669) ──
// The queueable FURLED fire can sit behind a longer call (incident points,
// readbacks) and replay only when the bus idles — by which time the warning
// may already be withdrawn. A deferred fire's `where:` is NOT re-run, but a
// script's `if:` expands at speak time, so the raised script names the
// `flag.furledStillShown` condition (registered below) to re-check the LIVE
// `Furled` bit just before speaking and expand to nothing (no line, and the
// engine adds no frame around an empty body) when the flag is already down.
// `furledRaisedSpoken` records that the raised line actually reached the
// speaker; the cleared script's `flag.furledWithdrawn` consumes it so "Black
// flag cleared." never plays for a warning the driver was never told about.
// The translator's own `furledAnnounced` gate can't cover this — it tracks
// event emission, not audio playback.
let furledRaisedSpoken = false;

/** @internal Test seam — seed/reset the raised-spoken pairing state. */
export function _setFurledRaisedSpoken(value: boolean): void {
  furledRaisedSpoken = value;
}

// Live `Furled`-bit read for the speak-time gates. `fallbackWhenUnknown`
// decides the missing-telemetry answer (scenario harness, disconnect): each
// gate passes the value that keeps it from suppressing on missing data (the
// #574 precedent) — the raised gate treats unknown as still-up (`true`), the
// cleared gate treats unknown as not-re-raised (`false`). With iRacing
// connected the translator's latest tick is always available, which is the
// only case the gates exist for.
function furledBitUp(fallbackWhenUnknown: boolean): boolean {
  const telemetry = getLatestTelemetry() as TelemetryData | null;

  if (telemetry === null) return fallbackWhenUnknown;

  return hasFlag(telemetry.SessionFlags ?? 0, Flags.Furled);
}

// Live Black/Disqualify read for the cleared gate's escalation check (issue
// #846). iRacing raises the actual black flag by CLEARING `Furled` and setting
// `Black` in one transition, so a furled-cleared meeting either penalty bit at
// speak time is the ESCALATION, not a withdrawal — the black/DQ callout owns
// that moment, and "Black flag cleared." would announce the opposite. The
// translator suppresses the same-tick case; this covers a legitimately-emitted
// clear that queued behind a longer line and was overtaken by the escalation
// before the bus idled. Delegates to the SAME `isPenaltyFlagActive` predicate
// the translator's suppression uses, so the two layers' definitions of
// "escalated" can't diverge. Missing telemetry reads as not-escalated so the
// gate never suppresses on missing data (the #574 precedent — keeps the
// scenario harness firable without iRacing).
function penaltyBitUp(): boolean {
  return isPenaltyFlagActive(getLatestTelemetry() as TelemetryData | null);
}

// The speak-time gate of the raised line (`flag.furledStillShown`): true while
// the warning is still up — and speaking it is what marks the raise as
// announced, so the side effect lives in the predicate on purpose.
function furledStillShown(): boolean {
  if (!furledBitUp(true)) return false;

  furledRaisedSpoken = true;

  return true;
}

// The speak-time gate of the cleared line (`flag.furledWithdrawn`), the mirror
// of the raised one: a queued clear is stale when the warning is already BACK
// UP by the time the bus idles (the re-raise is debounced upstream, so a fresh
// raised fire may not have displaced this one from the pending slot yet), or
// when a fresh raised fire reset the spoken marker while this clear sat in the
// queue. A clear meeting Black/Disqualify is the escalation (issue #846) — the
// episode is over for good (no further cleared event is coming: the diff
// consumed its announce), so the marker is consumed WITHOUT playing. Otherwise
// only a clear that actually plays consumes the marker.
function furledWithdrawn(): boolean {
  if (furledBitUp(false) || !furledRaisedSpoken) return false;

  furledRaisedSpoken = false;

  return !penaltyBitUp();
}

// `queueable: true` so a furled-black-flag call deferred behind another
// safety-level line (another flag / spotter focus) replays when the bus next
// idles instead of being dropped — it carries a give-the-time-back instruction
// the driver needs to hear, and the furled state is sustained so a slightly
// late call is still correct. The script's speak-time `if` on
// `flag.furledStillShown` covers the case where the state ISN'T sustained: a
// warning withdrawn while the call sat in the queue expands to silence instead
// of announcing a flag that's already gone.
const FURLED: ScenarioContract = {
  ...flagContract("furled"),
  queueable: true,
  when: {
    event: "flag.furled.raised",
    // A fresh raised episode invalidates any stale spoken marker a previous
    // episode left behind (e.g. a session change wiped the translator's state
    // before the falling edge, so no cleared event ever consumed it).
    where: () => {
      furledRaisedSpoken = false;

      return true;
    },
  },
};

// Fires when an announced furled warning is withdrawn (issue #669) — the
// translator gates `flag.furled.cleared` on the raised EVENT having fired, and
// the `where:` below narrows that to the raised LINE having actually been
// spoken: a raised fire that was queued behind a longer call and then dropped
// at speak time (flag already down) must not be followed by a stray "Black
// flag cleared.". `queueable: true` like YELLOW_CLEARED: the all-clear is a
// sustained state, so a fire deferred behind an equal-weight line replays when
// the bus next idles instead of being dropped. The script's speak-time `if`
// on `flag.furledWithdrawn` is what consumes the marker.
const FURLED_CLEARED: ScenarioContract = {
  ...flagContract("furled-cleared"),
  queueable: true,
  when: {
    event: "flag.furled.cleared",
    // Passive read — consumption happens at speak time in the script's
    // condition, so the marker pairs with the line actually reaching the
    // speaker on both sides.
    where: () => furledRaisedSpoken,
  },
};

// `queueable: true` (issue #923) — the same one-shot penalty edge as BLACK /
// DISQUALIFY above, with the same loss paths and sustained-state reasoning.
const DQ_SCORING_INVALID: ScenarioContract = {
  ...flagContract("dq-scoring-invalid"),
  queueable: true,
  when: { event: "flag.dq-scoring-invalid.raised" },
};

// Race-progression flags (issue #480) — crossed, one-pace-lap-to-go, green-held,
// ten-to-go, five-to-go.
const CROSSED: ScenarioContract = {
  ...flagContract("crossed"),
  when: { event: "flag.crossed.raised", where: liveRaceCar },
};

// "One pace lap to go" on a rolling start (issue #657). The translator's
// `diff/pace-laps.ts` already owns the rolling-only / ParadeLaps / final-lap
// gating, so the contract only needs the shared live-race-car gate (race
// session + in the car + not post-race).
const ONE_PACE_LAP_TO_GO: ScenarioContract = {
  ...flagContract("one-pace-lap-to-go"),
  when: { event: "flag.one-pace-lap-to-go.raised", where: liveRaceCar },
};

const GREEN_HELD: ScenarioContract = {
  ...flagContract("green-held"),
  when: { event: "flag.green-held.raised", where: rollingFormationOnly },
};

const TEN_TO_GO: ScenarioContract = {
  ...flagContract("ten-to-go"),
  when: { event: "flag.ten-to-go.raised", where: liveRaceCar },
};

const FIVE_TO_GO: ScenarioContract = {
  ...flagContract("five-to-go"),
  when: { event: "flag.five-to-go.raised", where: liveRaceCar },
};

/**
 * Issue #671 — iRacing re-raises the waving bits on every zone re-approach
 * while an incident persists; the cooldown collapses the repeats to one
 * callout per 30 s window, mirroring CrewChief's
 * `timeBetweenYellowFlagMessages`.
 */
export const WAVING_FLAG_COOLDOWN_MS = 30_000;

// Caution-waving variants (issue #480) — separate, more-urgent callouts than the
// base static yellows. The translator's reworked yellow detection guarantees a
// base yellow and its waving variant never double-fire. Both carry the 30 s
// cooldown (issue #671): the iRacing YellowWaving bit re-raises each time the
// player re-approaches a persistent incident, which replayed the callout on
// every pass.
const YELLOW_WAVING: ScenarioContract = {
  ...flagContract("yellow-waving"),
  cooldown: WAVING_FLAG_COOLDOWN_MS,
  when: { event: "flag.yellow-waving.raised" },
};

const CAUTION_WAVING: ScenarioContract = {
  ...flagContract("caution-waving"),
  cooldown: WAVING_FLAG_COOLDOWN_MS,
  when: { event: "flag.caution-waving.raised" },
};

export const FLAG_CONTRACTS: readonly ScenarioContract[] = [
  YELLOW_LOCAL,
  YELLOW_FULL,
  YELLOW_CLEARED,
  GREEN,
  BLUE,
  WHITE,
  WHITE_LAST_LAP,
  WHITE_LEADER,
  RED,
  BLACK,
  CHECKERED,
  DEBRIS,
  MEATBALL,
  DISQUALIFY,
  FURLED,
  FURLED_CLEARED,
  DQ_SCORING_INVALID,
  CROSSED,
  ONE_PACE_LAP_TO_GO,
  GREEN_HELD,
  TEN_TO_GO,
  FIVE_TO_GO,
  YELLOW_WAVING,
  CAUTION_WAVING,
];

export const FLAG_SCENARIO_IDS: readonly string[] = FLAG_CONTRACTS.map((s) => s.id);

/**
 * The clip sources the flag scripts draw from — every `pool:flags/<base>`
 * the bundled script may write, as a literal list, since nothing derives it
 * (no registry pool exists for this family). The completeness tests read
 * it: the bundled voice must ship at least one clip for each, and the
 * bundled script must reference exactly this set. A `(group, base)` a
 * script addresses is published — renaming a base is a rename in every
 * pack's script and every pack's clip folder.
 */
export const FLAG_CLIP_SOURCES: readonly { group: "flags"; base: string }[] = [
  { group: "flags", base: "yellow-local" },
  { group: "flags", base: "yellow-full" },
  { group: "flags", base: "yellow-cleared" },
  { group: "flags", base: "blue" },
  { group: "flags", base: "red" },
  { group: "flags", base: "black" },
  { group: "flags", base: "debris" },
  { group: "flags", base: "meatball" },
  { group: "flags", base: "green-practice" },
  { group: "flags", base: "green-qualifying" },
  { group: "flags", base: "green-race" },
  { group: "flags", base: "white-practice" },
  { group: "flags", base: "white-qualifying" },
  { group: "flags", base: "white-race" },
  { group: "flags", base: "white-last-lap" },
  { group: "flags", base: "white-leader" },
  { group: "flags", base: "checkered-practice" },
  { group: "flags", base: "checkered-qualifying" },
  { group: "flags", base: "checkered-race" },
  { group: "flags", base: "disqualify" },
  { group: "flags", base: "furled" },
  { group: "flags", base: "furled-cleared" },
  { group: "flags", base: "dq-scoring-invalid" },
  { group: "flags", base: "crossed" },
  { group: "flags", base: "one-pace-lap-to-go" },
  { group: "flags", base: "green-held" },
  { group: "flags", base: "ten-to-go" },
  { group: "flags", base: "five-to-go" },
  { group: "flags", base: "yellow-waving" },
  { group: "flags", base: "caution-waving" },
];

// The one classifier behind the whole `session.*` vocabulary — the package's
// shared session rule (`classifySessionType`, the same one `raceOnly` above
// reads through `isRaceSession`), so the case var, the three conditions and
// every `where:` gate in this family agree on what a session is. Before
// #1064 the green/white/checkered branching tested `=== "Practice"` exactly,
// which called "Lone Practice" and "Offline Testing" a race while the gates
// beside it did not; now that `session.type` is public vocabulary the rule
// is the shared one. `null` — no session type known yet — is reported
// honestly and left to the script's `default` branch.
function classifySession(): SessionKind | null {
  return classifySessionType(getSessionType());
}

/**
 * Register the vocabulary the flag scripts reference (issue #1064): the
 * `session.type` case var the green/white/checkered scripts branch on, the
 * two speak-time furled gates, and — published generously, the spec's own
 * smallest illustration — the three `session.is*` conditions so a pack can
 * write a binary `if` on the session instead of a three-way `case`. Names
 * and descriptions are the public API of the format; the descriptions feed
 * the generated reference (#1066).
 */
export function registerFlagVocabulary(engine: Pick<IScenarioEngine, "defineCond" | "defineCase">): void {
  engine.defineCase(
    "session.type",
    classifySession,
    {
      practice: "A practice session.",
      qualifying: "Any qualifying session (open or lone).",
      race: "A race session.",
    },
    "The type of the current session.",
  );

  engine.defineCond(
    "flag.furledStillShown",
    furledStillShown,
    "The furled black flag is still being shown at speak time; speaking it marks the raise as announced.",
  );
  engine.defineCond(
    "flag.furledWithdrawn",
    furledWithdrawn,
    "An announced furled flag has been withdrawn; speaking it consumes the announcement.",
  );

  engine.defineCond(
    "session.isPractice",
    () => classifySession() === "practice",
    "The current session is a practice session.",
  );
  engine.defineCond(
    "session.isQualifying",
    () => classifySession() === "qualifying",
    "The current session is a qualifying session (open or lone).",
  );
  engine.defineCond(
    "session.isRace",
    () => classifySession() === "race",
    "The current session is a race session (anything that is not practice or qualifying).",
  );
}
