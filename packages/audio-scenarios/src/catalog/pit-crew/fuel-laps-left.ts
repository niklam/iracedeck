/**
 * Estimated "laps of fuel left" contracts (issue #838; scripted since #1065)
 * — fire on `fuel.lapsLeft.crossed` events the translator emits once per lap
 * at the mid-lap sample, on descending crossings only. Eleven contracts: one
 * per count 10 → 1 plus the dedicated count-0 **"Box this lap for fuel."**
 * call, and the enough-fuel confirmation (issue #880). The dedup / margin /
 * refuel re-arm logic all lives in the translator diff
 * (`diff/fuel-laps-left.ts`) — each contract here just filters its count.
 *
 * The code below decides WHICH count is worth a line and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same ids (`scenarios["pit-crew.fuel-laps-left-3"]`, …), paired at
 * `setScripts` time. Each line is a single pool the script addresses
 * directly as `pool:fuel/<base>`; no vocabulary is needed, since the count is
 * decided by the contract's `where:` before the script is ever read — a
 * count is a contract, not a variable, so a pack can phrase the three-lap
 * warning differently from the ten-lap one.
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
 * **Speak-time gate.** A queued fire replays without its `where:` being asked
 * again, so every contract carries a `speakGate` that refuses once the
 * session's checkered flag is out (`isPostRace` on the latest telemetry): a
 * count queued just before a practice clock runs out or a race leader takes
 * the flag would otherwise be heard after it, within the queue wait. With no
 * telemetry (no sim, the scenario harness) the gate admits. The contracts are
 * built by {@link buildFuelLapsLeftContracts}, which `registerPitCrew` hands
 * its latest-telemetry reader.
 *
 * **Session kinds** (issue #1702). The translator emits the countdown in every
 * live session; `registerPitCrew` gates the whole family on the session kind
 * the player chose to hear it in (`fuel-countdown-sessions`), mapped from the
 * classified session by {@link fuelCountdownSessionKind}. The enough-fuel
 * confirmation is a race line and speaks only in the race kind
 * ({@link FUEL_RACE_COVERED_SCENARIO_ID}).
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { CalloutIdOf, FUEL_COUNTDOWN_SESSION_CALLOUTS } from "@iracedeck/callout-settings";
import type { SessionClass, SimEventOf } from "@iracedeck/event-bus";
import { isPostRace } from "@iracedeck/iracing-sdk";
import type { TelemetryData } from "@iracedeck/sim-events-iracing";

import type { ScenarioContract, SpeakGate } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";

/** Single source for the fuel family's shared defaults (channel, bus, weight
 *  band handling, queueable, family) — every fuel contract must construct
 *  through this so the defaults can't diverge. */
function fuelContract(
  subject: string,
  weight: number,
  when: ScenarioContract["when"],
  description: string,
  interrupt?: boolean,
): ScenarioContract {
  return {
    id: `pit-crew.fuel-laps-left-${subject}`,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight,
    interrupt,
    queueable: true,
    family: "fuel",
    // A newer estimate replaces one still waiting (issue #1185): only the
    // latest lap count is worth saying.
    supersedeGroup: "fuel",
    when,
    description,
  };
}

function fuelLapsLeftContract(
  subject: string,
  count: number,
  weight: number,
  description: string,
  interrupt?: boolean,
): ScenarioContract {
  return fuelContract(
    subject,
    weight,
    {
      event: "fuel.lapsLeft.crossed",
      where: (e) => (e as SimEventOf<"fuel.lapsLeft.crossed">).data.count === count,
    },
    description,
    interrupt,
  );
}

/**
 * The session kinds the countdown can be heard in, one opt-in each (issue
 * #1702): the ids of the `fuel-countdown-sessions` callout family.
 */
export type FuelCountdownSessionId = CalloutIdOf<typeof FUEL_COUNTDOWN_SESSION_CALLOUTS>;

/**
 * Which session-kind opt-in a classified session answers to (issue #1702).
 * The `race` category is Race, heat races and warmups included, since the
 * Race Engineer reads one classifier; `practice` is Test when `testing` is set
 * and Practice otherwise; `qualifying` is Qualifying, solo or not. A session
 * not yet classified (`null`) answers to none, so the countdown stays silent
 * until it is known — it samples once per lap, so nothing is lost.
 */
export function fuelCountdownSessionKind(session: SessionClass | null): FuelCountdownSessionId | null {
  if (session === null) return null;

  switch (session.category) {
    case "race":
      return "race";
    case "qualifying":
      return "qualifying";
    case "practice":
      return session.testing ? "test" : "practice";
  }
}

/** The enough-fuel confirmation's id: a race line, heard only in the race kind (issue #1702). */
export const FUEL_RACE_COVERED_SCENARIO_ID = "pit-crew.fuel-laps-left-race-covered";

/**
 * Enough-fuel confirmation (issue #880) — the diff emits
 * `fuel.lapsLeft.raceCovered` at most once per stint, once the race is
 * inside its last 10 laps (by the binding limit) and the tank covers the
 * remaining distance with a lap in hand — regardless of how large the
 * surplus is. Ordinary commentary weight (good news never needs to cut
 * anything), `queueable` for the same reason as the warnings: the diff
 * latches on EMIT, so a dropped fire would never replay.
 */
const FUEL_RACE_COVERED_BASE: ScenarioContract = fuelContract(
  "race-covered",
  WEIGHT.NORMAL,
  {
    event: "fuel.lapsLeft.raceCovered",
  },
  "Inside the last ten laps of a race, live in the car, the mid-lap fuel estimate shows the tank covering the rest of the race with a full lap in hand — once per stint.",
);

/** The twelve contracts before their speak-time gate is attached ({@link buildFuelLapsLeftContracts}). */
const FUEL_LAPS_LEFT_BASE: readonly ScenarioContract[] = [
  fuelLapsLeftContract(
    "10",
    10,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to ten more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "9",
    9,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to nine more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "8",
    8,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to eight more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "7",
    7,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to seven more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "6",
    6,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to six more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "5",
    5,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to five more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "4",
    4,
    WEIGHT.NORMAL,
    "Mid-lap, live in the car, your fuel estimate first drops to four more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "3",
    3,
    WEIGHT.SAFETY,
    "Mid-lap, live in the car, your fuel estimate first drops to three more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "2",
    2,
    WEIGHT.SAFETY,
    "Mid-lap, live in the car, your fuel estimate first drops to two more full laps — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
  ),
  fuelLapsLeftContract(
    "1",
    1,
    WEIGHT.CRITICAL,
    "Mid-lap, live in the car, your fuel estimate first drops to one more full lap — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
    true,
  ),
  fuelLapsLeftContract(
    "box",
    0,
    WEIGHT.CRITICAL,
    "Mid-lap, live in the car, your fuel estimate first drops below one more full lap — once per stint, and never once the tank covers the rest of the race or of a lap-limited session.",
    true,
  ),
  FUEL_RACE_COVERED_BASE,
];

/** What the fuel contracts read beyond their event: the latest telemetry, for the speak-time gate. */
export type FuelLapsLeftContractDeps = {
  /** The latest telemetry tick as the sim reported it; `null` with none (no sim, or the scenario harness). */
  getLatestTelemetry: () => TelemetryData | null;
};

/**
 * The speak-time gate every fuel contract carries (module header): refuse
 * once the session's checkered flag is out, as read from the latest
 * telemetry when the line reaches the radio, and admit with no telemetry.
 */
function stillBeforeTheCheckered(deps: FuelLapsLeftContractDeps): SpeakGate {
  return {
    description:
      "Dropped if the session's checkered flag came out while it waited for the radio, since the line no longer matters once the session is over.",
    admit: () => {
      const telemetry = deps.getLatestTelemetry();

      return telemetry === null || !isPostRace(telemetry);
    },
  };
}

/**
 * The twelve laps-of-fuel-left contracts, each with the speak-time gate that
 * reads `deps.getLatestTelemetry` (module header). `registerPitCrew` builds
 * them with the sim's reader; {@link FUEL_LAPS_LEFT_CONTRACTS} is the same set
 * with no telemetry, so its gate always admits.
 */
export function buildFuelLapsLeftContracts(deps: FuelLapsLeftContractDeps): readonly ScenarioContract[] {
  const speakGate = stillBeforeTheCheckered(deps);

  return FUEL_LAPS_LEFT_BASE.map((c) => ({ ...c, speakGate }));
}

/** The contracts with no telemetry reader, for the ids, the tests and the reference. */
export const FUEL_LAPS_LEFT_CONTRACTS: readonly ScenarioContract[] = buildFuelLapsLeftContracts({
  getLatestTelemetry: () => null,
});

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const FUEL_LAPS_LEFT_SCENARIO_IDS: readonly string[] = FUEL_LAPS_LEFT_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the fuel scripts draw from — every `pool:fuel/<base>` the
 * bundled script may write, as a literal list, since nothing derives it. The
 * completeness tests read it: the bundled voice must ship at least one clip
 * for each, and the bundled script must reference exactly this set. A
 * `(group, base)` a script addresses is published — renaming a base is a
 * rename in every pack's script and every pack's clip folder.
 */
export const FUEL_LAPS_LEFT_CLIP_SOURCES: readonly { group: "fuel"; base: string }[] = [
  { group: "fuel", base: "laps-left-10" },
  { group: "fuel", base: "laps-left-9" },
  { group: "fuel", base: "laps-left-8" },
  { group: "fuel", base: "laps-left-7" },
  { group: "fuel", base: "laps-left-6" },
  { group: "fuel", base: "laps-left-5" },
  { group: "fuel", base: "laps-left-4" },
  { group: "fuel", base: "laps-left-3" },
  { group: "fuel", base: "laps-left-2" },
  { group: "fuel", base: "laps-left-1" },
  { group: "fuel", base: "laps-left-box" },
  { group: "fuel", base: "race-covered" },
];
