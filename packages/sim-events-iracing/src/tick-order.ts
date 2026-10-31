/**
 * The order in which one translator tick publishes its events (issue #1499).
 *
 * #1407 gave the Race Engineer DSL `endsOn`: a contract's line is dropped once
 * its `endsOn.event` arrives. That only works if the trigger (`when.event`) is
 * never published AFTER the end event in the same `handleTick` call — published
 * after, the line plays once its condition has already stopped holding.
 * `pit-crew.limiter-dropped` (trigger `limiter.dropped`, end `pitLane.exited`)
 * is the first such contract, and it held only because `diffLimiter` happens
 * to be called before `diffPitLane`. This table makes that order a checked
 * fact for every `endsOn` contract: `tick-order.test.ts` proves the table is
 * the code (it spies on the real call order and the real publishes), and
 * {@link findEndsOnOrderViolations} answers, from the table alone, whether a
 * trigger can come after its end.
 *
 * What it proves: the order of STAGES. It does not prove that two events can
 * co-occur on one tick, so it is conservative — a pair the sim could never
 * produce together is still reported if its stages are in the wrong order —
 * and it cannot see inside one stage, so a stage that emits both events fails
 * closed. A `handleDisconnect` teardown is not a tick and is not listed.
 */
import type { SimEventName } from "@iracedeck/event-bus";

import { CAUTION_EVENTS } from "./diff/caution.js";
import { CORNER_NAME_EVENTS } from "./diff/corner-name.js";
import { DAMAGE_EVENTS } from "./diff/damage.js";
import { FLAGS_EVENTS } from "./diff/flags.js";
import { FUEL_LAPS_LEFT_EVENTS } from "./diff/fuel-laps-left.js";
import { GAPS_EVENTS } from "./diff/gaps.js";
import { INCIDENTS_EVENTS } from "./diff/incidents.js";
import { LAPS_EVENTS } from "./diff/laps.js";
import { LEADER_WHITE_EVENTS } from "./diff/leader-white.js";
import { LIFECYCLE_EVENTS } from "./diff/lifecycle.js";
import { LIMITER_EVENTS } from "./diff/limiter.js";
import { OPPONENT_FLAGS_EVENTS } from "./diff/opponent-flags.js";
import { OPPONENT_PIT_EVENTS } from "./diff/opponent-pit.js";
import { OVERTAKES_EVENTS } from "./diff/overtakes.js";
import { PACE_LAPS_EVENTS } from "./diff/pace-laps.js";
import { PIT_BOX_COUNTDOWN_EVENTS } from "./diff/pit-box-countdown.js";
import { PIT_LANE_EVENTS } from "./diff/pit-lane.js";
import { PIT_READBACK_EVENTS } from "./diff/pit-readback.js";
import { PIT_SPEEDING_EVENTS } from "./diff/pit-speeding.js";
import { PIT_STATUS_EVENTS } from "./diff/pit-status.js";
import { PITS_OPEN_EVENTS } from "./diff/pits-open.js";
import { RADAR_EVENTS } from "./diff/radar.js";
import { REPLAY_GREENS_EVENTS } from "./diff/replay-greens.js";
import { REPLAY_INCIDENTS_EVENTS } from "./diff/replay-incidents.js";
import { REPLAY_LAPS_EVENTS } from "./diff/replay-laps.js";
import { REPLAY_SESSIONS_EVENTS } from "./diff/replay-sessions.js";
import { ROLLING_START_EVENTS } from "./diff/rolling-start.js";
import { START_COUNTDOWN_EVENTS, START_LIGHTS_EVENTS } from "./diff/start-lights.js";
import { TIRE_WEAR_EVENTS } from "./diff/tire-wear.js";
import { TOGGLES_EVENTS } from "./diff/toggles.js";
import { TRACK_WETNESS_EVENTS } from "./diff/track-wetness.js";

/**
 * One stage of a tick that can publish.
 *
 * - `stage` — the diff function's name, or a label for a publish site in
 *   `translator.ts` itself.
 * - `source` — where the stage lives: `diff/<module>.ts` or `translator.ts`.
 * - `via` — `direct`: the stage's publishes reach the bus the moment it makes
 *   them; `pending`: they are queued and flushed at the end of the tick, in
 *   call order, after every direct publish.
 * - `events` — every event the stage can publish. For a diff module this is
 *   the module's own `<NAME>_EVENTS` list, which its emitter's type enforces.
 */
export type TickStage = {
  readonly stage: string;
  readonly source: string;
  readonly via: "direct" | "pending";
  readonly events: readonly SimEventName[];
};

/** The publish sites in `translator.ts` that end active-state loops (`publishActiveStateTeardown`). */
const TEARDOWN_EVENTS = ["radar.changed", "pitSpeeding.ended"] as const satisfies readonly SimEventName[];

/**
 * Every stage that can publish during one `handleTick` call, in the order its
 * publishes reach the bus. A stage that runs only on some ticks — a session
 * change, the entry into a replay, which returns before the live diffs — is
 * listed where it runs. A reorder of any diff call in `handleTick` must update
 * this table; `tick-order.test.ts` fails until it does. Diffs that publish
 * nothing (`diffTireTemps`, `diffFuelLaps`) are not listed.
 */
export const TICK_ORDER: readonly TickStage[] = [
  // Pre-guard, published directly.
  { stage: "session.changed (fresh connect)", source: "translator.ts", via: "direct", events: ["session.changed"] },
  // `resetPerSessionState` runs the teardown before the session-change publish.
  {
    stage: "publishActiveStateTeardown (session change)",
    source: "translator.ts",
    via: "direct",
    events: TEARDOWN_EVENTS,
  },
  { stage: "session.changed (session change)", source: "translator.ts", via: "direct", events: ["session.changed"] },
  { stage: "diffStartCountdown", source: "diff/start-lights.ts", via: "direct", events: START_COUNTDOWN_EVENTS },
  { stage: "diffReplayLaps", source: "diff/replay-laps.ts", via: "direct", events: REPLAY_LAPS_EVENTS },
  { stage: "diffReplayGreens", source: "diff/replay-greens.ts", via: "direct", events: REPLAY_GREENS_EVENTS },
  { stage: "diffReplaySessions", source: "diff/replay-sessions.ts", via: "direct", events: REPLAY_SESSIONS_EVENTS },
  { stage: "diffReplayIncidents", source: "diff/replay-incidents.ts", via: "direct", events: REPLAY_INCIDENTS_EVENTS },
  { stage: "diffFirstOnTrack", source: "translator.ts", via: "direct", events: ["driver.firstOnTrack"] },
  // The replay guard's entry edge; the tick returns right after it.
  {
    stage: "publishActiveStateTeardown (replay entry)",
    source: "translator.ts",
    via: "direct",
    events: TEARDOWN_EVENTS,
  },
  // Live diffs: queued in `pending`, flushed in call order at the end of the tick.
  { stage: "diffLifecycle", source: "diff/lifecycle.ts", via: "pending", events: LIFECYCLE_EVENTS },
  { stage: "diffFlags", source: "diff/flags.ts", via: "pending", events: FLAGS_EVENTS },
  { stage: "diffLaps", source: "diff/laps.ts", via: "pending", events: LAPS_EVENTS },
  { stage: "diffLimiter", source: "diff/limiter.ts", via: "pending", events: LIMITER_EVENTS },
  { stage: "diffPitLane", source: "diff/pit-lane.ts", via: "pending", events: PIT_LANE_EVENTS },
  { stage: "diffStartLights", source: "diff/start-lights.ts", via: "pending", events: START_LIGHTS_EVENTS },
  { stage: "diffPaceLaps", source: "diff/pace-laps.ts", via: "pending", events: PACE_LAPS_EVENTS },
  { stage: "diffRollingStart", source: "diff/rolling-start.ts", via: "pending", events: ROLLING_START_EVENTS },
  { stage: "diffPitsOpen", source: "diff/pits-open.ts", via: "pending", events: PITS_OPEN_EVENTS },
  { stage: "diffToggles", source: "diff/toggles.ts", via: "pending", events: TOGGLES_EVENTS },
  { stage: "diffPitStatus", source: "diff/pit-status.ts", via: "pending", events: PIT_STATUS_EVENTS },
  { stage: "diffPitReadback", source: "diff/pit-readback.ts", via: "pending", events: PIT_READBACK_EVENTS },
  { stage: "diffTireWear", source: "diff/tire-wear.ts", via: "pending", events: TIRE_WEAR_EVENTS },
  { stage: "diffIncidents", source: "diff/incidents.ts", via: "pending", events: INCIDENTS_EVENTS },
  { stage: "diffDamage", source: "diff/damage.ts", via: "pending", events: DAMAGE_EVENTS },
  { stage: "diffCaution", source: "diff/caution.ts", via: "pending", events: CAUTION_EVENTS },
  { stage: "diffOpponentPit", source: "diff/opponent-pit.ts", via: "pending", events: OPPONENT_PIT_EVENTS },
  { stage: "diffOpponentFlags", source: "diff/opponent-flags.ts", via: "pending", events: OPPONENT_FLAGS_EVENTS },
  { stage: "diffLeaderWhite", source: "diff/leader-white.ts", via: "pending", events: LEADER_WHITE_EVENTS },
  { stage: "diffOvertakes", source: "diff/overtakes.ts", via: "pending", events: OVERTAKES_EVENTS },
  { stage: "diffGaps", source: "diff/gaps.ts", via: "pending", events: GAPS_EVENTS },
  {
    stage: "diffPitBoxCountdown",
    source: "diff/pit-box-countdown.ts",
    via: "pending",
    events: PIT_BOX_COUNTDOWN_EVENTS,
  },
  { stage: "diffCornerName", source: "diff/corner-name.ts", via: "pending", events: CORNER_NAME_EVENTS },
  { stage: "diffFuelLapsLeft", source: "diff/fuel-laps-left.ts", via: "pending", events: FUEL_LAPS_LEFT_EVENTS },
  { stage: "diffRadar", source: "diff/radar.ts", via: "pending", events: RADAR_EVENTS },
  { stage: "diffPitSpeeding", source: "diff/pit-speeding.ts", via: "pending", events: PIT_SPEEDING_EVENTS },
  { stage: "diffTrackWetness", source: "diff/track-wetness.ts", via: "pending", events: TRACK_WETNESS_EVENTS },
];

/** One way `trigger` can be published after `end` in one tick, with a message fit for a test failure. */
export type EndsOnOrderViolation =
  | {
      readonly kind: "trigger-after-end";
      readonly triggerStage: string;
      readonly endStage: string;
      readonly message: string;
    }
  | { readonly kind: "same-stage"; readonly stage: string; readonly message: string }
  | { readonly kind: "never-published"; readonly event: SimEventName; readonly message: string };

/**
 * Every way `trigger` can reach the bus after `end` within one tick, judged
 * from `order` alone (issue #1499; the `endsOn` contract of #1407).
 *
 * - `trigger-after-end` — a stage that can publish `trigger` comes after a
 *   stage that can publish `end`.
 * - `same-stage` — one stage can publish both. The table cannot see the order
 *   inside a stage, so this fails closed.
 * - `never-published` — no stage publishes the event. A misspelt or dropped
 *   event would otherwise pass vacuously, so a caller treats this as an error.
 *
 * Conservative by construction: it reports an order the code allows, whether
 * or not the sim can ever produce both events on one tick. An empty result
 * means no tick can publish `trigger` after `end`.
 */
export function findEndsOnOrderViolations(
  order: readonly TickStage[],
  trigger: SimEventName,
  end: SimEventName,
): EndsOnOrderViolation[] {
  const violations: EndsOnOrderViolation[] = [];
  const pair = `\`${trigger}\` → endsOn \`${end}\``;
  const triggerAt = order.flatMap((s, i) => (s.events.includes(trigger) ? [i] : []));
  const endAt = order.flatMap((s, i) => (s.events.includes(end) ? [i] : []));

  for (const [event, at] of [
    [trigger, triggerAt],
    [end, endAt],
  ] as const) {
    if (at.length === 0) {
      violations.push({
        kind: "never-published",
        event,
        message: `${pair}: no stage of TICK_ORDER publishes \`${event}\` — the translator never emits it, so the pair cannot be checked (misspelt or dropped event?).`,
      });
    }
  }

  for (const i of triggerAt) {
    for (const j of endAt) {
      const triggerStage = order[i]!.stage;
      const endStage = order[j]!.stage;

      if (i === j) {
        violations.push({
          kind: "same-stage",
          stage: triggerStage,
          message:
            `${pair}: \`${triggerStage}\` publishes both, and TICK_ORDER cannot see the order inside one stage, so this fails closed. ` +
            `Prove in that module's own tests that one call never emits \`${trigger}\` after \`${end}\` (drive a single call that would emit both and assert the emit order, ` +
            `or show the two are gated apart), then exempt this pair where the check is applied, citing that test.`,
        });
      } else if (i > j) {
        violations.push({
          kind: "trigger-after-end",
          triggerStage,
          endStage,
          message:
            `${pair}: \`${triggerStage}\` (stage ${i}) publishes \`${trigger}\` after \`${endStage}\` (stage ${j}) publishes \`${end}\` on the same tick, ` +
            `so the line could play after its condition ended. Move \`${triggerStage}\` ahead of \`${endStage}\` in handleTick and in TICK_ORDER.`,
        });
      }
    }
  }

  return violations;
}
