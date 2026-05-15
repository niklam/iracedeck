/**
 * Runtime list of every `SimEventName` plus a representative payload
 * template for each. Drives the harness UI's "raw event injector"
 * dropdown and pre-fills the JSON editor with a sensible starting point.
 *
 * Maintenance: when a new event lands in `@iracedeck/event-bus`'s
 * `SimEventMap`, add an entry here. The compile-time type check at the
 * bottom of this file fails if a name is missing or extra, so this list
 * cannot drift silently.
 */
import type { SimEventName } from "@iracedeck/event-bus";

export type EventTemplate = {
  name: SimEventName;
  description: string;
  /** Default payload — what `data` should look like in `bus.publish`. */
  data: Record<string, unknown>;
};

export const EVENT_TEMPLATES = [
  // ── Pit lane / stall ──
  { name: "pitLane.approaching", description: "Approaching pit entry", data: {} },
  { name: "pitLane.entered", description: "Crossed onto pit road", data: {} },
  { name: "pitLane.exited", description: "Left pit road", data: {} },
  { name: "pitStall.entered", description: "Stopped in your pit stall", data: {} },
  { name: "pitStall.departed", description: "Left pit stall", data: {} },
  {
    name: "pitService.readbackRequested",
    description: "Engineer pit-service readback (entry / refire / exit)",
    data: {
      reason: "entry",
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: true, rr: true },
      compoundChange: null,
      fastRepair: { queued: false, available: true },
      windshield: { queued: false, available: true },
      limiterEngaged: false,
    },
  },

  // ── Flags ──
  { name: "flag.yellow.raised", description: "Yellow flag raised", data: { scope: "local" } },
  { name: "flag.yellow.cleared", description: "Yellow flag cleared", data: {} },
  { name: "flag.blue.raised", description: "Blue flag (faster car approaching)", data: {} },
  { name: "flag.green.raised", description: "Green flag (go racing)", data: {} },
  { name: "flag.checkered.raised", description: "Checkered flag", data: {} },
  { name: "flag.black.raised", description: "Black flag", data: {} },
  { name: "flag.white.raised", description: "White flag (final lap)", data: {} },
  { name: "flag.red.raised", description: "Red flag (session stopped)", data: {} },
  { name: "flag.debris.raised", description: "Debris on track", data: {} },
  { name: "flag.meatball.raised", description: "Meatball flag (orange-and-black, come to pits)", data: {} },

  // ── Service / car control toggles ──
  {
    name: "tireService.changed",
    description: "Tire service selection changed",
    data: { added: ["LF"], removed: [], current: ["LF"] },
  },
  {
    name: "tireService.compoundChanged",
    description: "Pit-service tire compound changed (iRacing: 0=dry, 1=wet)",
    data: { from: 0, to: 1 },
  },
  {
    name: "pitService.toggled",
    description: "Pit service toggled (fuel/windshield/fastRepair)",
    data: { service: "fuel", on: true },
  },
  {
    name: "pitService.statusChanged",
    description:
      "Pit-service status transition (PlayerCarPitSvStatus). 0=None, 1=InProgress, 2=Complete, 100..105=positioning/cantFix",
    data: { from: 0, to: 1 },
  },
  { name: "carControl.drsToggled", description: "DRS toggled", data: { on: true } },
  { name: "carControl.p2pToggled", description: "Push-to-pass toggled", data: { on: true } },
  { name: "carControl.limiterToggled", description: "Pit limiter toggled", data: { on: true } },
  { name: "limiter.dropped", description: "Limiter dropped while still in pit lane", data: {} },
  { name: "limiter.missing", description: "Pit lane entered without limiter on", data: {} },
  { name: "limiter.speeding", description: "Speeding in pit lane", data: {} },

  // ── Damage ──
  {
    name: "damage.repairNeeded.raised",
    description:
      "Damage detected — fires after the rising-edge debounce on EngineWarnings & (MandRepNeeded | OptRepNeeded)",
    data: {},
  },

  // ── Incidents / off-track ──
  {
    name: "incident.occurred",
    description: "Player picked up an incident — `type` is the IncidentType discriminator (issue #530)",
    data: { delta: 1, type: "off-track" },
  },
  { name: "offTrack.started", description: "Player went off track", data: {} },
  { name: "offTrack.ended", description: "Player returned to track", data: {} },

  // ── Overtake ──
  {
    name: "overtake.completed",
    description: "Overtake sustained long enough to count",
    data: { carIdx: 7, sustained: 2500 },
  },

  // ── Lifecycle / lap ──
  { name: "driver.firstOnTrack", description: "Driver first leaves the garage", data: {} },
  { name: "session.changed", description: "Session number changed", data: { from: 0, to: 1 } },
  { name: "engine.startup", description: "Engine started", data: {} },
  { name: "lap.started", description: "New lap started", data: { lap: 2 } },
  {
    name: "lap.completed",
    description: "Lap just completed at S/F (issue #555) — best-lap callout triggers when isBest is true",
    data: {
      lap: 5,
      lapTime: 63.4,
      isBest: true,
      isFirstValid: false,
      bestLapTime: 63.4,
      previousBestLapTime: 64.1,
      sessionType: "race",
    },
  },

  // ── Value-change ──
  { name: "radar.changed", description: "Proximity radar state changed", data: { from: "clear", to: "left" } },
  {
    name: "fuel.lapsRemaining.crossed",
    description: "Crossed a fuel-laps-remaining threshold",
    data: { threshold: 5, laps: 4.6 },
  },
  {
    name: "track.wetness.changed",
    description: "Track-wetness state stepped (irsdk_TrackWetness 1..7)",
    data: { from: 1, to: 2 },
  },
] as const satisfies readonly EventTemplate[];

export const ALL_EVENT_NAMES: readonly SimEventName[] = EVENT_TEMPLATES.map((t) => t.name);

// ── Compile-time completeness check ─────────────────────────────────────────
// If a new event is added to SimEventMap and not added above, this fails to
// type-check. If a name above is misspelled or removed from the map, it fails
// the same way. Either way, the harness can't compile until the list is back
// in sync with the canonical catalog.

type CoveredNames = (typeof EVENT_TEMPLATES)[number]["name"];
type Diff = Exclude<SimEventName, CoveredNames> | Exclude<CoveredNames, SimEventName>;
// When `Diff` is non-never (an event name in the catalog is missing here, or
// vice versa), the inferred type for `_coverageCheck` becomes `never`, and
// `true` is not assignable to `never` — the file fails to compile, listing
// the missing/extra names in the error.
const _coverageCheck: [Diff] extends [never] ? true : never = true;
void _coverageCheck;
