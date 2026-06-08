/**
 * Pit-window family scenarios (issue #655).
 *
 * Two lines spoken when pit road opens / closes for the player, both fired off
 * the single `pitsOpen.changed` value-change event and branched on `to`
 * (`to === true` → opened, `to === false` → closed) — the same shape as
 * `radar.changed` / `pitService.statusChanged`, rather than two separate events.
 * Each wraps its pool in the shared radio frame so the engineer voice matches
 * every other Pit Crew message.
 *
 * **Shared family.** Both share `family: "pit-window"` so a rapid
 * open→closed→open flurry (the chaos of a full-course caution forming up) cleanly
 * preempts the stale in-flight family-mate rather than stacking back-to-back
 * stale callouts.
 *
 * **Weight 65.** An explicit integer between `WEIGHT.NORMAL` (50) and
 * `WEIGHT.SAFETY` (70): above routine chatter and ordinary callouts, but
 * deliberately BELOW flag callouts — if a flag is being announced it's more
 * urgent than the pit-window state, so flags win the bus. No new named band is
 * warranted for a single callout.
 *
 * **`interrupt: false`, `queueable: true`.** Never cut an in-flight line; but if
 * the callout can't take the bus now (a flag or equal/higher fire is in flight)
 * it defers for replay when the bus next idles rather than being dropped — the
 * open/closed state matters strategically, so losing it to a momentary
 * higher-weight fire would be wrong.
 *
 * **Gating.** Race-session + replay-only gating lives in the translator diff
 * (`diff/pits-open.ts`), so the event only reaches the bus in a live race. The
 * scenario `where:` therefore only discriminates direction — which keeps both
 * scenarios firable from the scenario harness (it publishes the bus event
 * directly with an explicit `to`).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

/**
 * Pit-window scheduling weight — an explicit integer between `WEIGHT.NORMAL`
 * (50) and `WEIGHT.SAFETY` (70): above ordinary callouts, but below flags so a
 * flag in flight still wins the bus. Shared by both directional scenarios so a
 * re-tune is a single edit (the test pins the literal independently).
 */
const PIT_WINDOW_WEIGHT = 65;

/**
 * Build one directional pit-window scenario. Keeps the shared
 * `family`/`weight`/`bus`/`channel`/`base`/scheduling defaults in a single place
 * (the catalog's "small constructor" convention, mirroring `track-conditions.ts`
 * / `flag-alerts.ts`) so a future re-tune is one edit. Both the scenario id and
 * the pool name derive from `direction`; `to` is the `PitsOpen` value this
 * direction fires on.
 */
function pitWindowScenario(direction: "opened" | "closed", to: boolean): Scenario {
  return {
    id: `pit-crew.pit-window-${direction}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: PIT_WINDOW_WEIGHT,
    interrupt: false,
    queueable: true,
    family: "pit-window",
    sequence: ["@pit-crew.radio-open", `pool:pit-window-${direction}`, "@pit-crew.radio-close"],
    when: { event: "pitsOpen.changed", where: (e) => (e as SimEventOf<"pitsOpen.changed">).data.to === to },
  };
}

const PIT_WINDOW_OPENED = pitWindowScenario("opened", true);
const PIT_WINDOW_CLOSED = pitWindowScenario("closed", false);

export const PIT_WINDOW_ALERTS: readonly Scenario[] = [PIT_WINDOW_OPENED, PIT_WINDOW_CLOSED];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const PIT_WINDOW_SCENARIO_IDS: readonly string[] = PIT_WINDOW_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const PIT_WINDOW_POOL_NAMES: readonly string[] = ["pit-window-opened", "pit-window-closed"];
