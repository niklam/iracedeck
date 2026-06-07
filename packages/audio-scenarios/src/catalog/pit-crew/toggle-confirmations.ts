/**
 * Toggle-confirmation scenarios — short engineer voice lines played when the
 * driver toggles a pit-service option or an on-board driver-aid (DRS / P2P).
 *
 * Flow: `@radio-open → pool:pit-action-acknowledgment → <toggle clip(s)> → @radio-close`.
 * The pit-action ack pool (got it / roger that / copy that) preserves the
 * walkie-talkie feel where the engineer confirms the request before echoing
 * the state change. It's a separate pool from the generic `acknowledgment`
 * one so the two pools' no-repeat trackers stay independent — see `pools.ts`
 * for the rationale.
 *
 * Registered scenarios:
 *   - `FUEL_TOGGLE_SCENARIOS` — fuel on/off via `pitService.toggled`
 *   - `TIRE_TOGGLE_SCENARIOS` — every meaningful tire-set selection via
 *     `tireService.changed`: the 5 standard patterns (all/fronts/rears/
 *     lefts/rights), all 4 single-corner picks, both diagonals, all 4
 *     three-corner combos, and the full-clear ("skip tires") case
 *   - `TIRE_COMPOUND_SCENARIOS` — dry/wet compound switches via
 *     `tireService.compoundChanged`
 *   - `WINDSHIELD_TOGGLE_SCENARIOS` — windshield-tearoff on/off via
 *     `pitService.toggled`
 *   - `FAST_REPAIR_TOGGLE_SCENARIOS` — fast-repair on/off via
 *     `pitService.toggled`
 *
 * All registered scenarios use the default weight (`WEIGHT.NORMAL`) so
 * higher-weight pit-lane callouts still take precedence.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { Scenario } from "../../dsl.js";

// ── Shared sequence wrapper ─────────────────────────────────────────────

function toggleSequence(steps: Scenario["sequence"]): Scenario["sequence"] {
  return ["@pit-crew.radio-open", "pool:pit-action-acknowledgment", ...steps, "@pit-crew.radio-close"];
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
    family: "pit-service.fuel",
    sequence: toggleSequence([`pool:pit-action-fuel-${on ? "on" : "off"}`]),
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
  family: "tire-service",
  sequence: toggleSequence(["pool:pit-action-tires-off"]),
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
    family: "tire-service",
    sequence: toggleSequence([
      `pit-actions/tires-compound-${name}.mp3`,
    ]),
  };
}

export const TIRE_COMPOUND_SCENARIOS: readonly Scenario[] = [compoundScenario(0), compoundScenario(1)];

// ── Windshield tearoff (registered) ─────────────────────────────────────

function windshieldScenario(on: boolean): Scenario {
  return {
    id: `pit-crew.toggle-windshield-${on ? "on" : "off"}`,
    when: {
      event: "pitService.toggled",
      where: (e) => {
        const data = (e as SimEventOf<"pitService.toggled">).data;

        return data.service === "windshield" && data.on === on;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "pit-service.windshield",
    sequence: toggleSequence([`pit-actions/windshield-${on ? "on" : "off"}.mp3`]),
  };
}

export const WINDSHIELD_TOGGLE_SCENARIOS: readonly Scenario[] = [windshieldScenario(true), windshieldScenario(false)];

// ── Fast repair (registered) ────────────────────────────────────────────

function fastRepairScenario(on: boolean): Scenario {
  return {
    id: `pit-crew.toggle-fast-repair-${on ? "on" : "off"}`,
    when: {
      event: "pitService.toggled",
      where: (e) => {
        const data = (e as SimEventOf<"pitService.toggled">).data;

        return data.service === "fastRepair" && data.on === on;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    family: "pit-service.fast-repair",
    sequence: toggleSequence([`pit-actions/fast-repair-${on ? "on" : "off"}.mp3`]),
  };
}

export const FAST_REPAIR_TOGGLE_SCENARIOS: readonly Scenario[] = [fastRepairScenario(true), fastRepairScenario(false)];
