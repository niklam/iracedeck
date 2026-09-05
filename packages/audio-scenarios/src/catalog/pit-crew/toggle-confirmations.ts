/**
 * Toggle-confirmation contracts — short engineer voice lines played when the
 * driver toggles a pit-service option (issues #464, #468; scripted since
 * #1065).
 *
 * The code below decides WHICH toggle fired and how the confirmation is
 * scheduled; WHAT the engineer says lives in the active voice's
 * `callouts.json` under the same ids (`scenarios["pit-crew.toggle-fuel-on"]`,
 * …). The bundled script's shape for every one of the twenty-four is
 * `pool:pit-actions/acknowledgment → pool:pit-actions/<line>`, wrapped in the
 * voice's `radio` frame by the engine (issue #1064). The pit-action
 * acknowledgment (got it / roger that / copy that) preserves the
 * walkie-talkie feel where the engineer confirms the request before echoing
 * the state change. It is a different `(group, base)` from the generic
 * `acknowledgment/acknowledgment` pool — a deliberate subset (no "Okay." /
 * "We got that.") tuned for the pit-service confirmation register — so the
 * two pools' no-repeat trackers are independent by construction: the user
 * hears variety on a toggle burst even if a generic acknowledgment just
 * played for an unrelated cue. Under direct `pool:<group>/<base>` addressing
 * that independence needs no named pool, so the script names none. No
 * vocabulary is registered here — a confirmation branches on nothing.
 *
 * Registered contracts:
 *   - `FUEL_TOGGLE_CONTRACTS` — fuel on/off via `pitService.toggled`
 *   - `TIRE_TOGGLE_CONTRACTS` — every meaningful tire-set selection via
 *     `tireService.changed`: the 5 standard patterns (all/fronts/rears/
 *     lefts/rights), all 4 single-corner picks, both diagonals, all 4
 *     three-corner combos, and the full-clear ("skip tires") case
 *   - `TIRE_COMPOUND_CONTRACTS` — dry/wet compound switches via
 *     `tireService.compoundChanged`
 *   - `WINDSHIELD_TOGGLE_CONTRACTS` — windshield-tearoff on/off via
 *     `pitService.toggled`
 *   - `FAST_REPAIR_TOGGLE_CONTRACTS` — fast-repair on/off via
 *     `pitService.toggled`
 *
 * All registered contracts use the default weight (`WEIGHT.NORMAL`) so
 * higher-weight pit-lane callouts still take precedence.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContract } from "../../dsl.js";

// ── Fuel toggle (registered) ────────────────────────────────────────────

function fuelContract(on: boolean): ScenarioContract {
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
  };
}

export const FUEL_TOGGLE_CONTRACTS: readonly ScenarioContract[] = [fuelContract(true), fuelContract(false)];

// ── Tire toggle (registered) ────────────────────────────────────────────

/**
 * Tire-set patterns. Each contract filters on the **resulting** tire set
 * (`current`) rather than the deltas (`added`/`removed`). This is critical
 * because iRacing's "Left tires" / "Right tires" / "Front tires" / etc.
 * buttons emit events whose deltas look like mid-transition removals
 * (going from all four set to lefts-only emits `removed: [RF, RR]` with
 * `added: []`, which would spuriously match a pure-removal "skipping
 * tires" contract). Filtering on `current` produces the right callout
 * regardless of how the user got there — including direct side-switches.
 *
 * Coverage is exhaustive across the 16 possible 4-corner combinations:
 *   - empty set → `TIRE_OFF_CONTRACT` ("skip tires")
 *   - 1 corner  → 4 single-corner contracts (`lf` / `rf` / `lr` / `rr`)
 *   - 2 corners → 6 contracts: fronts / rears / lefts / rights /
 *                 diagonals (`lf-rr`, `rf-lr`)
 *   - 3 corners → 4 "all except X" contracts (`skip-lf` / `skip-rf` /
 *                 `skip-lr` / `skip-rr`)
 *   - 4 corners → `all`
 *
 * The names double as the clip bases the bundled script addresses
 * (`pool:pit-actions/tires-on-<name>`) and match the readback's
 * `readback.tirePattern` keys one-to-one.
 */
export type TireSetName =
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

type TireSet = {
  name: TireSetName;
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

/** The fifteen non-empty set names, in registration order. */
export const TIRE_SET_NAMES: readonly TireSetName[] = TIRE_SET_PATTERNS.map((p) => p.name);

function setMatches(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  if (actual.length !== expected.length) return false;

  for (const t of expected) if (!actual.includes(t)) return false;

  return true;
}

function tireSetOnContract(set: TireSet): ScenarioContract {
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
  };
}

const TIRE_OFF_CONTRACT: ScenarioContract = {
  id: "pit-crew.tire-set-off",
  when: {
    event: "tireService.changed",
    where: (e) => (e as SimEventOf<"tireService.changed">).data.current.length === 0,
  },
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "tire-service",
};

export const TIRE_TOGGLE_CONTRACTS: readonly ScenarioContract[] = [
  ...TIRE_SET_PATTERNS.map(tireSetOnContract),
  TIRE_OFF_CONTRACT,
];

// ── Tire compound switching (registered) ────────────────────────────────

/**
 * Tire-compound switch confirmations. Filters on the resulting compound
 * id from `tireService.compoundChanged`. iRacing exposes `0=dry, 1=wet`
 * via the pit-service compound toggle (per `iracing-sdk/README.md` —
 * `pit.tireCompound(compound)`). Other sims may emit a richer compound
 * roster; for now we cover the iRacing-supported pair.
 *
 * Shares `family: "tire-service"` with the tire-set contracts so a tire
 * pick immediately after a compound flip preempts cleanly. The translator
 * suppresses the cascading "all four tires" event that iRacing fires
 * alongside a compound flip, so the compound voice line is the single
 * canonical confirmation for the dry↔wet transition.
 */
const TIRE_COMPOUND_LABEL: Record<0 | 1, "dry" | "wet"> = { 0: "dry", 1: "wet" };

function compoundContract(to: 0 | 1): ScenarioContract {
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
  };
}

export const TIRE_COMPOUND_CONTRACTS: readonly ScenarioContract[] = [compoundContract(0), compoundContract(1)];

// ── Windshield tearoff (registered) ─────────────────────────────────────

function windshieldContract(on: boolean): ScenarioContract {
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
  };
}

export const WINDSHIELD_TOGGLE_CONTRACTS: readonly ScenarioContract[] = [
  windshieldContract(true),
  windshieldContract(false),
];

// ── Fast repair (registered) ────────────────────────────────────────────

function fastRepairContract(on: boolean): ScenarioContract {
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
  };
}

export const FAST_REPAIR_TOGGLE_CONTRACTS: readonly ScenarioContract[] = [
  fastRepairContract(true),
  fastRepairContract(false),
];

// ── The whole family ────────────────────────────────────────────────────

/** All twenty-four toggle confirmations, in registration order. */
export const TOGGLE_CONFIRMATION_CONTRACTS: readonly ScenarioContract[] = [
  ...FUEL_TOGGLE_CONTRACTS,
  ...TIRE_TOGGLE_CONTRACTS,
  ...TIRE_COMPOUND_CONTRACTS,
  ...WINDSHIELD_TOGGLE_CONTRACTS,
  ...FAST_REPAIR_TOGGLE_CONTRACTS,
];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const TOGGLE_CONFIRMATION_SCENARIO_IDS: readonly string[] = TOGGLE_CONFIRMATION_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the toggle-confirmation scripts draw from — the shared
 * acknowledgment plus one line per toggle, every one a
 * `pool:pit-actions/<base>`. The completeness tests read it: the bundled
 * voice must ship at least one clip for each, and the bundled script must
 * reference exactly this set. A `(group, base)` a script addresses is
 * published — renaming a base is a rename in every pack's script and every
 * pack's clip folder.
 */
export const TOGGLE_CONFIRMATION_CLIP_SOURCES: readonly { group: "pit-actions"; base: string }[] = [
  "acknowledgment",
  "fuel-on",
  "fuel-off",
  ...TIRE_SET_NAMES.map((name) => `tires-on-${name}`),
  "tires-off",
  "tires-compound-dry",
  "tires-compound-wet",
  "windshield-on",
  "windshield-off",
  "fast-repair-on",
  "fast-repair-off",
].map((base) => ({ group: "pit-actions" as const, base }));
