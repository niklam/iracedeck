/**
 * Toggle-confirmation scenarios — short engineer voice lines played when the
 * driver toggles a pit-service option or an on-board driver-aid (DRS / P2P).
 *
 * Flow: `@radio-open → pool:acknowledgment → <toggle clip(s)> → @radio-close`.
 * The acknowledgment pool (copy that / got it / …) preserves the walkie
 * talkie feel where the engineer confirms the request before echoing the
 * state change.
 *
 * Registered scenarios:
 *   - `FUEL_TOGGLE_SCENARIOS` — fuel on/off via `pitService.toggled`
 *   - `TIRE_TOGGLE_SCENARIOS` — every meaningful tire-set selection via
 *     `tireService.changed`: the 5 standard patterns (all/fronts/rears/
 *     lefts/rights), all 4 single-corner picks, both diagonals, all 4
 *     three-corner combos, and the full-clear ("skip tires") case
 *   - `TIRE_COMPOUND_SCENARIOS` — dry/wet compound switches via
 *     `tireService.compoundChanged`
 *
 * All registered scenarios use `priority: "normal"` so pit-lane callouts
 * still take precedence.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

// ── Shared sequence wrapper ─────────────────────────────────────────────

function toggleSequence(steps: Scenario["sequence"]): Scenario["sequence"] {
  return ["@pit-crew.radio-open", "pool:acknowledgment", ...steps, "@pit-crew.radio-close"];
}

// ── Fuel toggle (registered) ────────────────────────────────────────────

function fuelScenario(on: boolean): Scenario {
  return {
    id: `pit-crew.toggle-fuel-${on ? "on" : "off"}`,
    when: {
      event: "pitService.toggled",
      where: (e) => {
        const data = (e as SimEventOf<"pitService.toggled">).data;

        return data.service === "fuel" && data.on === on;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "pit-service.fuel",
    sequence: toggleSequence([`pit-actions/fuel-${on ? "on" : "off"}.mp3`]),
  };
}

export const FUEL_TOGGLE_SCENARIOS: readonly Scenario[] = [fuelScenario(true), fuelScenario(false)];

// ── Tire toggle (registered) ────────────────────────────────────────────

/**
 * Tire-set patterns. Each scenario filters on the **resulting** tire set
 * (`current`) rather than the deltas (`added`/`removed`). This is critical
 * because iRacing's "Left tires" / "Right tires" / "Front tires" / etc.
 * buttons emit events whose deltas look like mid-transition removals
 * (going from all four set to lefts-only emits `removed: [RF, RR]` with
 * `added: []`, which would spuriously match a pure-removal "skipping
 * tires" scenario). Filtering on `current` produces the right callout
 * regardless of how the user got there — including direct side-switches.
 *
 * Coverage is exhaustive across the 16 possible 4-corner combinations:
 *   - empty set → `TIRE_OFF_SCENARIO` ("skip tires")
 *   - 1 corner  → 4 single-corner scenarios (`lf` / `rf` / `lr` / `rr`)
 *   - 2 corners → 6 scenarios: fronts / rears / lefts / rights /
 *                 diagonals (`lf-rr`, `rf-lr`)
 *   - 3 corners → 4 "all except X" scenarios (`skip-lf` / `skip-rf` /
 *                 `skip-lr` / `skip-rr`)
 *   - 4 corners → `all`
 */
type TireSet = {
  name:
    | "all"
    | "fronts"
    | "rears"
    | "lefts"
    | "rights"
    | "lf"
    | "rf"
    | "lr"
    | "rr"
    | "lf-rr"
    | "rf-lr"
    | "skip-rr"
    | "skip-lr"
    | "skip-rf"
    | "skip-lf";
  tires: ReadonlyArray<string>;
};

const TIRE_SET_PATTERNS: ReadonlyArray<TireSet> = [
  // Standard 5 patterns (iRacing's preset buttons).
  { name: "all", tires: ["LF", "RF", "LR", "RR"] },
  { name: "fronts", tires: ["LF", "RF"] },
  { name: "rears", tires: ["LR", "RR"] },
  { name: "lefts", tires: ["LF", "LR"] },
  { name: "rights", tires: ["RF", "RR"] },
  // Single-corner picks (intentional puncture-only changes).
  { name: "lf", tires: ["LF"] },
  { name: "rf", tires: ["RF"] },
  { name: "lr", tires: ["LR"] },
  { name: "rr", tires: ["RR"] },
  // Diagonals (setup tests, asymmetric wear).
  { name: "lf-rr", tires: ["LF", "RR"] },
  { name: "rf-lr", tires: ["RF", "LR"] },
  // Three-corner combos (skip one fresh corner).
  { name: "skip-rr", tires: ["LF", "RF", "LR"] },
  { name: "skip-lr", tires: ["LF", "RF", "RR"] },
  { name: "skip-rf", tires: ["LF", "LR", "RR"] },
  { name: "skip-lf", tires: ["RF", "LR", "RR"] },
];

function setMatches(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  if (actual.length !== expected.length) return false;

  for (const t of expected) if (!actual.includes(t)) return false;

  return true;
}

function tireSetOnScenario(set: TireSet): Scenario {
  return {
    id: `pit-crew.tire-set-on-${set.name}`,
    when: {
      event: "tireService.changed",
      where: (e) => {
        const { current } = (e as SimEventOf<"tireService.changed">).data;

        return setMatches(current, set.tires);
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "tire-service",
    sequence: toggleSequence([
      `pit-actions/tires-on-${set.name}.mp3`,
    ]),
  };
}

const TIRE_OFF_SCENARIO: Scenario = {
  id: "pit-crew.tire-set-off",
  when: {
    event: "tireService.changed",
    where: (e) => (e as SimEventOf<"tireService.changed">).data.current.length === 0,
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  priority: "normal",
  family: "tire-service",
  sequence: toggleSequence(["pit-actions/tires-off.mp3"]),
};

export const TIRE_TOGGLE_SCENARIOS: readonly Scenario[] = [
  ...TIRE_SET_PATTERNS.map(tireSetOnScenario),
  TIRE_OFF_SCENARIO,
];

// ── Tire compound switching (registered) ────────────────────────────────

/**
 * Tire-compound switch confirmations. Filters on the resulting compound
 * id from `tireService.compoundChanged`. iRacing exposes `0=dry, 1=wet`
 * via the pit-service compound toggle (per `iracing-sdk/README.md` —
 * `pit.tireCompound(compound)`). Other sims may emit a richer compound
 * roster; for now we cover the iRacing-supported pair.
 *
 * Shares `family: "tire-service"` with the tire-set scenarios so a tire
 * pick immediately after a compound flip preempts cleanly. The translator
 * suppresses the cascading "all four tires" event that iRacing fires
 * alongside a compound flip, so the compound voice line is the single
 * canonical confirmation for the dry↔wet transition.
 */
const TIRE_COMPOUND_LABEL: Record<0 | 1, "dry" | "wet"> = { 0: "dry", 1: "wet" };

function compoundScenario(to: 0 | 1): Scenario {
  const name = TIRE_COMPOUND_LABEL[to];

  return {
    id: `pit-crew.tire-compound-${name}`,
    when: {
      event: "tireService.compoundChanged",
      where: (e) => (e as SimEventOf<"tireService.compoundChanged">).data.to === to,
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    priority: "normal",
    family: "tire-service",
    sequence: toggleSequence([
      `pit-actions/tires-compound-${name}.mp3`,
    ]),
  };
}

export const TIRE_COMPOUND_SCENARIOS: readonly Scenario[] = [compoundScenario(0), compoundScenario(1)];
