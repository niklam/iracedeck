/**
 * Estimated "laps of fuel left" callouts (issue #838) — fire on
 * `fuel.lapsLeft.crossed` events the translator emits once per lap at the
 * mid-lap sample, on descending crossings only. Eleven scenarios: one per
 * count 10 → 1 plus the dedicated count-0 **"Box this lap for fuel."** call.
 * The dedup / margin / refuel re-arm logic all lives in the translator diff
 * (`diff/fuel-laps-left.ts`) — each scenario here just filters its count.
 *
 * **Scheduling.** `family: "fuel"` so a fresher count supersedes an in-flight
 * one (a rapid estimate drop never plays two stale counts back-to-back).
 * Weights follow the issue's bands: the box call and the 1-lap warning are
 * `WEIGHT.CRITICAL` + `interrupt: true` (must be heard, cut lesser lines);
 * 2–3 laps sit at `WEIGHT.SAFETY` with the flag callouts; 4–10 laps are
 * ordinary `WEIGHT.NORMAL` commentary. All are `queueable` — the estimate
 * moves at lap cadence, so a fire deferred a few seconds behind a busier bus
 * is still accurate when it replays (the YELLOW_CLEARED precedent), and a
 * dropped fire would otherwise never re-announce because the diff has already
 * marked the count spoken.
 *
 * Pool-driven clips (mirrors `flag-alerts.ts` / `pit-box.ts`) so future
 * variants are clip-file appends with no code change.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";

/** Single source for the fuel family's shared defaults (channel, bus, weight
 *  band handling, queueable, family, radio-framed sequence) — every fuel
 *  scenario must construct through this so the defaults can't diverge. */
function fuelScenario(subject: string, weight: number, when: Scenario["when"], interrupt?: boolean): Scenario {
  return {
    id: `pit-crew.fuel-laps-left-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight,
    interrupt,
    queueable: true,
    family: "fuel",
    sequence: ["@pit-crew.radio-open", `pool:fuel-laps-left-${subject}`, "@pit-crew.radio-close"],
    when,
  };
}

function fuelLapsLeftScenario(subject: string, count: number, weight: number, interrupt?: boolean): Scenario {
  return fuelScenario(
    subject,
    weight,
    {
      event: "fuel.lapsLeft.crossed",
      where: (e) => (e as SimEventOf<"fuel.lapsLeft.crossed">).data.count === count,
    },
    interrupt,
  );
}

/**
 * Enough-fuel confirmation (issue #880) — the diff emits
 * `fuel.lapsLeft.raceCovered` at most once per stint, once the race is
 * inside its last 10 laps (by the binding limit) and the tank covers the
 * remaining distance with a lap in hand — regardless of how large the
 * surplus is. Ordinary commentary weight (good news never needs to cut
 * anything), `queueable` for the same reason as the warnings: the diff
 * latches on EMIT, so a dropped fire would never replay.
 */
const FUEL_RACE_COVERED_ALERT: Scenario = fuelScenario("race-covered", WEIGHT.NORMAL, {
  event: "fuel.lapsLeft.raceCovered",
});

export const FUEL_LAPS_LEFT_ALERTS: readonly Scenario[] = [
  fuelLapsLeftScenario("10", 10, WEIGHT.NORMAL),
  fuelLapsLeftScenario("9", 9, WEIGHT.NORMAL),
  fuelLapsLeftScenario("8", 8, WEIGHT.NORMAL),
  fuelLapsLeftScenario("7", 7, WEIGHT.NORMAL),
  fuelLapsLeftScenario("6", 6, WEIGHT.NORMAL),
  fuelLapsLeftScenario("5", 5, WEIGHT.NORMAL),
  fuelLapsLeftScenario("4", 4, WEIGHT.NORMAL),
  fuelLapsLeftScenario("3", 3, WEIGHT.SAFETY),
  fuelLapsLeftScenario("2", 2, WEIGHT.SAFETY),
  fuelLapsLeftScenario("1", 1, WEIGHT.CRITICAL, true),
  fuelLapsLeftScenario("box", 0, WEIGHT.CRITICAL, true),
  FUEL_RACE_COVERED_ALERT,
];

/** Scenario ids exported for tests so a typo here surfaces as a test failure. */
export const FUEL_LAPS_LEFT_SCENARIO_IDS: readonly string[] = FUEL_LAPS_LEFT_ALERTS.map((s) => s.id);

/** Pool names this catalog draws from — kept here so tests can register them
 *  on the scenario engine without duplicating the list. */
export const FUEL_LAPS_LEFT_POOL_NAMES: readonly string[] = [
  "fuel-laps-left-race-covered",
  "fuel-laps-left-10",
  "fuel-laps-left-9",
  "fuel-laps-left-8",
  "fuel-laps-left-7",
  "fuel-laps-left-6",
  "fuel-laps-left-5",
  "fuel-laps-left-4",
  "fuel-laps-left-3",
  "fuel-laps-left-2",
  "fuel-laps-left-1",
  "fuel-laps-left-box",
];
