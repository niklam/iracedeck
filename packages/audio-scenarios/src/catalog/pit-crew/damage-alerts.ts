/**
 * Damage-alert contract — fires when the sim translator publishes
 * `damage.repairNeeded.raised` after the rising-edge debounce on
 * `EngineWarnings & (MandRepNeeded | OptRepNeeded)` (issue #489; scripted
 * since #1065).
 *
 * One contract today (`pit-crew.damage-repair-needed`). The code below
 * decides WHEN it fires and how it is scheduled; WHAT is said lives in the
 * active voice's `callouts.json` under the same id, where the bundled script
 * draws the line from `pool:damage/repair-needed` — so adding a variant is a
 * clip-file change, and rephrasing it is a script change, neither touching
 * this file. No vocabulary is registered here — the line branches on nothing.
 *
 * **Scheduling (issues #1211, #1288).** Default weight (`WEIGHT.NORMAL`) —
 * higher-weight callouts (a meatball flag at `WEIGHT.CRITICAL`) still win the
 * bus over a damage heads-up, which matches the use case (the flag carries
 * the same signal more authoritatively). Until #1211 the line was not
 * queueable, and the event fires once per damage episode, so a fire that
 * could not take the Voice bus was lost for good: below the spotter's focus
 * floor (held while a car is alongside, the usual moment of a crash), behind
 * the incident line for the same crash, or behind the `WEIGHT.SAFETY` caution
 * calls a crash brings out in the same few seconds (#1288). Now it is
 * `queueable` and waits for the bus in its queue, behind heavier lines such
 * as those caution calls rather than replaced by them (issue #1185;
 * `crash-caution-sequence.test.ts` replays the #1288 log). It waits up to
 * 30 s (`maxQueueWaitMs`) rather than the engine's default: the gate below
 * keeps it true for as long as it waits, and a caution burst ahead of it
 * runs past the default.
 *
 * When a crash produces both an incident line and this one, the incident
 * line plays first (Niklas, 2026-09-24). The translator holds the damage
 * event behind an open incident burst (`sim-events-iracing` `diff/damage.ts`),
 * so on a flush tick it is published after `incident.occurred`; `queueBehind`
 * then keeps the order when the bus is held: this line waits right behind a
 * waiting incident line (or lap-invalidation line, which replaces the
 * incident line on a flying qualifying lap), a waiting damage line moves
 * behind an incident line that arrives after it, and it stays behind an
 * escalation that replaces the incident line it waited for (the queue
 * re-links a follower behind a newcomer it names).
 *
 * A waiting line can outlive what it announces, so the `speakGate` asks the
 * translator whether the car still needs a repair when the line comes to
 * speak (`isDamageRepairNeeded()`) and refuses it once the answer is no — the
 * damage was repaired while it waited (#1288). That answer is the damage
 * diff's own debounced state, the one behind the event, never the repair
 * bits of one raw tick: the bits flicker on collision-frame rebounds and
 * during pit-stall service, and a one-shot line refused on a flicker is lost
 * for good. So the line is dropped only once the repair has settled as done.
 * The gate admits an imperative `fire(id)` (the harness buttons) and an
 * unknown state (no translator, or no live tick since a connect, session
 * change or replay), which has nothing to disprove the damage with. A line
 * cut mid-play by an `interrupt` replays whole without asking the gate again
 * (#1138's contract for an admitted fire).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { isDamageRepairNeeded } from "@iracedeck/sim-events-iracing";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { INCIDENT_SCENARIO_IDS } from "./incidents.js";
import { QUALIFYING_INVALIDATION_SCENARIO_IDS } from "./qualifying-invalidation.js";

/**
 * The damage contract's speak-time gate (issues #1211, #1288): refuses only
 * when the translator's settled damage state says the repair is done
 * (`isDamageRepairNeeded()` is `false`). Admits an imperative fire (no event)
 * and an unknown state (`null`). Pure — it claims nothing, so a refusal
 * stamps no cooldown.
 *
 * @internal Exported for tests.
 */
export function damageStillNeedsRepair(ctx: ScenarioContext): boolean {
  if (ctx.event === null) return true;

  return isDamageRepairNeeded() !== false;
}

const DAMAGE_REPAIR_NEEDED: ScenarioContract = {
  id: "pit-crew.damage-repair-needed",
  when: { event: "damage.repairNeeded.raised" },
  speakGate: {
    description:
      "The car still needs a repair when the call comes to speak — the repair indicator has not settled as cleared — or the damage state is not known yet.",
    admit: damageStillNeedsRepair,
  },
  description:
    "Your car takes damage that keeps the repair indicator lit for three seconds, and again only after a repair; the line waits for any incident being reported then and is skipped if already repaired.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "damage",
  queueable: true,
  // The line stays true for as long as it waits — its gate refuses it once
  // the repair settles as done — so a caution burst ahead of it must not
  // expire it (issues #1185, #1288).
  maxQueueWaitMs: 30_000,
  // The incident line for the same crash plays first (see the header).
  queueBehind: [...INCIDENT_SCENARIO_IDS, ...QUALIFYING_INVALIDATION_SCENARIO_IDS],
};

export const DAMAGE_CONTRACTS: readonly ScenarioContract[] = [DAMAGE_REPAIR_NEEDED];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const DAMAGE_SCENARIO_IDS: readonly string[] = DAMAGE_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the damage script draws from. The completeness tests read
 * it: the bundled voice must ship at least one clip for each, and the bundled
 * script must reference exactly this set. A `(group, base)` a script
 * addresses is published — renaming a base is a rename in every pack's script
 * and every pack's clip folder.
 */
export const DAMAGE_CLIP_SOURCES: readonly { group: "damage"; base: string }[] = [
  { group: "damage", base: "repair-needed" },
];
