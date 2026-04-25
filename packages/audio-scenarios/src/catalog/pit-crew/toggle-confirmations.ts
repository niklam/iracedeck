/**
 * Toggle-confirmation scenarios — short engineer voice lines played when the
 * driver toggles a pit-service option or an on-board driver-aid (DRS / P2P).
 *
 * Flow: `@radio-open → pool:acknowledgment → <toggle clip(s)> → @radio-close`.
 * The acknowledgment pool (copy that / got it / …) preserves the walkie
 * talkie feel where the engineer confirms the request before echoing the
 * state change.
 *
 * **Registered today (#441 §4):**
 *   - `FUEL_TOGGLE_SCENARIOS` — fuel on/off via `pitService.toggled`
 *   - `TIRE_TOGGLE_SCENARIOS` — tire set add (5 patterns) + full clear via
 *     `tireService.changed`
 *
 * **Pending migration (NOT registered):** `PENDING_TOGGLE_SCENARIOS` —
 * windshield, fastRepair, drs, p2p. Their clips still point at the deleted
 * `pit-crew/` tree; each gets its own voice/ content batch in a follow-up
 * issue. Definitions kept as templates for those PRs.
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
 * Single-tire selections and unusual combos (diagonals, three-tire sets)
 * match no pattern and stay silent by design.
 */
type TireSet = {
  name: "all" | "fronts" | "rears" | "lefts" | "rights";
  tires: ReadonlyArray<string>;
};

const TIRE_SET_PATTERNS: ReadonlyArray<TireSet> = [
  { name: "all", tires: ["LF", "RF", "LR", "RR"] },
  { name: "fronts", tires: ["LF", "RF"] },
  { name: "rears", tires: ["LR", "RR"] },
  { name: "lefts", tires: ["LF", "LR"] },
  { name: "rights", tires: ["RF", "RR"] },
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
    sequence: toggleSequence([
      "pit-actions/tires-on.mp3",
      `pit-actions/tires-on-${set.name}.mp3`,
      "pit-actions/at-the-next-stop.mp3",
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
  sequence: toggleSequence(["pit-actions/tires-off.mp3"]),
};

export const TIRE_TOGGLE_SCENARIOS: readonly Scenario[] = [
  ...TIRE_SET_PATTERNS.map(tireSetOnScenario),
  TIRE_OFF_SCENARIO,
];

// ── Pending migration (NOT registered) ──────────────────────────────────
// TODO(#441 follow-up): clips below still reference the deleted pit-crew/
// tree. Each (windshield / fastRepair / drs / p2p) needs its own voice/
// content batch (mirroring acknowledgment in #441 §3) before migration.
// Definitions kept as templates for the migration PRs.

type PitServiceLegacy = "windshield" | "fastRepair";

const LEGACY_PIT_SERVICE_CLIP: Record<PitServiceLegacy, { on: string; off: string }> = {
  windshield: {
    on: "pit-crew/toggle/IRD-toggle-windshield-on.mp3",
    off: "pit-crew/toggle/IRD-toggle-windshield-off.mp3",
  },
  fastRepair: {
    on: "pit-crew/toggle/IRD-toggle-fast-repair-on.mp3",
    off: "pit-crew/toggle/IRD-toggle-fast-repair-off.mp3",
  },
};

function legacyPitServiceScenario(service: PitServiceLegacy, on: boolean): Scenario {
  const clip = (on ? LEGACY_PIT_SERVICE_CLIP[service].on : LEGACY_PIT_SERVICE_CLIP[service].off).replace(
    /^pit-crew\//,
    "",
  );

  return {
    id: `pit-crew.toggle-${service}-${on ? "on" : "off"}`,
    when: {
      event: "pitService.toggled",
      where: (e) => {
        const data = (e as SimEventOf<"pitService.toggled">).data;

        return data.service === service && data.on === on;
      },
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "pit-crew",
    priority: "normal",
    sequence: toggleSequence([clip]),
  };
}

function legacyCarControlScenario(kind: "drs" | "p2p", on: boolean): Scenario {
  const event = kind === "drs" ? "carControl.drsToggled" : "carControl.p2pToggled";

  return {
    id: `pit-crew.toggle-${kind}-${on ? "on" : "off"}`,
    when: {
      event,
      where: (e) => (e as SimEventOf<"carControl.drsToggled" | "carControl.p2pToggled">).data.on === on,
    },
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "pit-crew",
    priority: "normal",
    sequence: toggleSequence([`toggle/IRD-toggle-${kind}-${on ? "on" : "off"}.mp3`]),
  };
}

export const PENDING_TOGGLE_SCENARIOS: readonly Scenario[] = [
  legacyPitServiceScenario("windshield", true),
  legacyPitServiceScenario("windshield", false),
  legacyPitServiceScenario("fastRepair", true),
  legacyPitServiceScenario("fastRepair", false),
  legacyCarControlScenario("drs", true),
  legacyCarControlScenario("drs", false),
  legacyCarControlScenario("p2p", true),
  legacyCarControlScenario("p2p", false),
];
