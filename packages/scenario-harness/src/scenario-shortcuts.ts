/**
 * Curated one-click triggers for the active Pit Crew scenarios + a few
 * handy state changes that don't naturally fall out of telemetry mutation.
 *
 * Each shortcut maps to a `bus.publish` call with a fully-formed payload.
 * Authoring scenarios this way is faster than hand-editing JSON in the
 * raw event injector — the user can focus on hearing/seeing the response,
 * not on writing event payloads.
 *
 * Adding a shortcut: append an entry below. Adding a category: pick a
 * stable `category` string and add at least one entry under it. Order in
 * the array drives display order in the UI.
 */
import type { SimEventName } from "@iracedeck/event-bus";

export type ScenarioShortcut = {
  id: string;
  category: string;
  label: string;
  description?: string;
  event: SimEventName;
  data: Record<string, unknown>;
};

const ALL_FOUR_TIRES = ["LF", "RF", "LR", "RR"] as const;

function tireSet(name: string, label: string, tires: readonly string[]): ScenarioShortcut {
  return {
    id: `tire-${name}`,
    category: "Tire Service",
    label,
    event: "tireService.changed",
    data: {
      added: [...tires],
      removed: ALL_FOUR_TIRES.filter((t) => !tires.includes(t)),
      current: [...tires],
    },
  };
}

function flag(label: string, event: SimEventName, data: Record<string, unknown> = {}): ScenarioShortcut {
  return { id: `flag-${label.toLowerCase().replace(/\s+/g, "-")}`, category: "Flags", label, event, data };
}

function radar(label: string, from: string, to: string): ScenarioShortcut {
  return {
    id: `radar-${to.replace(/\s+/g, "-")}`,
    category: "Radar",
    label,
    event: "radar.changed",
    data: { from, to },
  };
}

export const SCENARIO_SHORTCUTS: readonly ScenarioShortcut[] = [
  // ── Pit Service ──
  {
    id: "fuel-on",
    category: "Pit Service",
    label: "Fuel ON",
    description: "Driver enables fuel for the next stop",
    event: "pitService.toggled",
    data: { service: "fuel", on: true },
  },
  {
    id: "fuel-off",
    category: "Pit Service",
    label: "Fuel OFF",
    description: "Driver disables fuel for the next stop",
    event: "pitService.toggled",
    data: { service: "fuel", on: false },
  },
  {
    id: "windshield-on",
    category: "Pit Service",
    label: "Windshield ON",
    description: "Driver enables windshield tearoff for the next stop",
    event: "pitService.toggled",
    data: { service: "windshield", on: true },
  },
  {
    id: "windshield-off",
    category: "Pit Service",
    label: "Windshield OFF",
    description: "Driver disables windshield tearoff for the next stop",
    event: "pitService.toggled",
    data: { service: "windshield", on: false },
  },
  {
    id: "fast-repair-on",
    category: "Pit Service",
    label: "Fast Repair ON",
    description: "Driver enables fast repair for the next stop",
    event: "pitService.toggled",
    data: { service: "fastRepair", on: true },
  },
  {
    id: "fast-repair-off",
    category: "Pit Service",
    label: "Fast Repair OFF",
    description: "Driver disables fast repair for the next stop",
    event: "pitService.toggled",
    data: { service: "fastRepair", on: false },
  },

  // ── Tire Service ──
  // The 5 standard patterns the registered scenarios match on (current set).
  tireSet("all", "All", ALL_FOUR_TIRES),
  {
    id: "tire-none",
    category: "Tire Service",
    label: "Skip",
    description: "Clear the tire selection (current = [])",
    event: "tireService.changed",
    data: { added: [], removed: [...ALL_FOUR_TIRES], current: [] },
  },
  tireSet("fronts", "Fronts", ["LF", "RF"]),
  tireSet("rears", "Rears", ["LR", "RR"]),
  tireSet("lefts", "Lefts", ["LF", "LR"]),
  tireSet("rights", "Rights", ["RF", "RR"]),
  // Single corners (intentional puncture-only changes).
  tireSet("lf", "LF only", ["LF"]),
  tireSet("rf", "RF only", ["RF"]),
  tireSet("lr", "LR only", ["LR"]),
  tireSet("rr", "RR only", ["RR"]),
  // Diagonals
  tireSet("lf-rr", "LF + RR", ["LF", "RR"]),
  tireSet("rf-lr", "RF + LR", ["RF", "LR"]),
  // Three-corner combos — labelled by the tire that's *skipped* so the
  // intent reads cleanly ("All except RR"); compare with the patterns
  // above which name what's *included*.
  tireSet("skip-rr", "All except RR", ["LF", "RF", "LR"]),
  tireSet("skip-lr", "All except LR", ["LF", "RF", "RR"]),
  tireSet("skip-rf", "All except RF", ["LF", "LR", "RR"]),
  tireSet("skip-lf", "All except LF", ["RF", "LR", "RR"]),
  // Compound switches (iRacing exposes 0=dry / 1=wet).
  {
    id: "compound-dry",
    category: "Tire Service",
    label: "Compound → DRY",
    description: "Switch the pit-service compound to dry",
    event: "tireService.compoundChanged",
    data: { from: 1, to: 0 },
  },
  {
    id: "compound-wet",
    category: "Tire Service",
    label: "Compound → WET",
    description: "Switch the pit-service compound to wet",
    event: "tireService.compoundChanged",
    data: { from: 0, to: 1 },
  },

  // ── Pit Lane ──
  { id: "pit-approaching", category: "Pit Lane", label: "Approaching", event: "pitLane.approaching", data: {} },
  { id: "pit-entered", category: "Pit Lane", label: "Entered Pit Lane", event: "pitLane.entered", data: {} },
  { id: "stall-entered", category: "Pit Lane", label: "Entered Stall", event: "pitStall.entered", data: {} },
  { id: "stall-departed", category: "Pit Lane", label: "Departed Stall", event: "pitStall.departed", data: {} },
  { id: "pit-exited", category: "Pit Lane", label: "Exited Pit Lane", event: "pitLane.exited", data: {} },

  // ── Flags ──
  flag("Yellow (local)", "flag.yellow.raised", { scope: "local" }),
  flag("Yellow (full)", "flag.yellow.raised", { scope: "full" }),
  flag("Yellow Cleared", "flag.yellow.cleared"),
  flag("Green", "flag.green.raised"),
  flag("White", "flag.white.raised"),
  flag("Checkered", "flag.checkered.raised"),
  flag("Blue", "flag.blue.raised"),
  flag("Black", "flag.black.raised"),
  flag("Red", "flag.red.raised"),
  flag("Debris", "flag.debris.raised"),
  flag("Meatball", "flag.meatball.raised"),

  // ── Damage ──
  // Bypasses the rising-edge + 3000 ms debounce in
  // `sim-events-iracing/diff/damage.ts` — fires the bus event directly
  // so you hear the audio without waiting for the diff to settle. Use
  // the Engine Warnings panel checkboxes (Mandatory / Optional Repair)
  // when you specifically want to exercise the diff.
  {
    id: "damage-repair-needed",
    category: "Damage",
    label: "Damage Detected",
    description: "Fire `damage.repairNeeded.raised` directly (skips the diff debounce)",
    event: "damage.repairNeeded.raised",
    data: {},
  },

  // ── Incidents ──
  // Standard iRacing point values: 1x = off-track, 2x = minor contact,
  // 4x = major contact / car-to-car. 0x exists as a "warning" tier in
  // SDK telemetry but the translator only fires `incident.occurred` on
  // non-zero deltas, so it isn't useful as a shortcut.
  {
    id: "incident-1x",
    category: "Incidents",
    label: "1x (off-track)",
    description: "Driver picked up 1 incident point — typical off-track penalty",
    event: "incident.occurred",
    data: { delta: 1 },
  },
  {
    id: "incident-2x",
    category: "Incidents",
    label: "2x (minor)",
    description: "Driver picked up 2 incident points — minor contact",
    event: "incident.occurred",
    data: { delta: 2 },
  },
  {
    id: "incident-4x",
    category: "Incidents",
    label: "4x (major)",
    description: "Driver picked up 4 incident points — major contact",
    event: "incident.occurred",
    data: { delta: 4 },
  },
  {
    id: "off-track-started",
    category: "Incidents",
    label: "Off-Track Started",
    event: "offTrack.started",
    data: {},
  },
  {
    id: "off-track-ended",
    category: "Incidents",
    label: "Off-Track Ended",
    event: "offTrack.ended",
    data: {},
  },

  // ── Radar ──
  // `from` is the previous radar state; `to` is the new one. The radar
  // engine drives its own tick loop off the current state, so any
  // transition the engine would otherwise see via diffing telemetry.
  radar("Clear", "left", "clear"),
  radar("Left", "clear", "left"),
  radar("Right", "clear", "right"),
  radar("Both Sides", "clear", "both"),
  radar("Two Left", "left", "two-left"),
  radar("Two Right", "right", "two-right"),
];
