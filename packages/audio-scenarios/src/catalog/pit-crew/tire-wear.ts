/**
 * Tire-wear report after a pit stop (issue #1108).
 *
 * One contract, `pit-crew.tire-wear-report`, fired by `tireWear.reported`.
 * iRacing refreshes its twelve tread readings (three zones per tire) only as
 * the car arrives in its pit box, and they describe the tires ON the car at
 * that moment — after a tire change, the set that came off — so the report
 * is a summary of the stint just driven. The translator publishes the event
 * as the car leaves pit road after a stop it drove into, right after the exit
 * readback's `pitService.readbackRequested`, from the same settle timer.
 *
 * The code below decides WHETHER the report fires and how it is scheduled;
 * WHAT is said lives in the active voice's `callouts.json` under the same id
 * (`scenarios["pit-crew.tire-wear-report"]`), paired at `setScripts` time.
 * The bundled script reads the four tires front to rear, each as a whole
 * percent (`pool:tire-wear/<corner>` + `{{tireWear.<corner>Tread}}`, with
 * `pool:tire-wear/percent` after the first number only), then — as an
 * optional whole clause, and only when `tireWear.hasWear` says a tire reads
 * below 100 — where the wear is heaviest, through the `tireWear.heaviestSpot`
 * case: one recorded sentence per tire and zone, so the closing clause is
 * never spliced mid-sentence. On an untouched set the heaviest spot is just
 * the tie-break's first pick, which is why the condition exists.
 *
 * **Everything is read off the fire's own event.** The payload is the report:
 * the readings do not change again until the next stop, so there is no live
 * state worth re-reading at speak time, and a fire that waited behind the
 * readback replays with the very event that fired it (the engine keeps it on
 * the pending fire). Every var and case returns `null`, and the condition
 * `false`, for any other fire — an imperative `fire(id)`, or a pack naming a
 * `tireWear.*` name from another callout's entry — which aborts a required
 * step and takes a case's `default` branch, as the grammar says.
 *
 * **The numbers are the session-start temperature clips.** A tread percent is
 * a whole number from 0 to 100, which that group already records (0–150)
 * for the temperature brief, so the report needs no number clips of its own.
 * No range is checked here (issue #836): the clips that exist for the active
 * voice define what is speakable.
 *
 * **Scheduling.** Default weight, `queueable: true`, the default radio frame,
 * `family: "tire-wear"`, and `queueBehind` naming the exit readback. The
 * readback sits at `WEIGHT.CHATTER` and is published first, so on an idle
 * bus it takes the bus and the report waits as the pending fire (higher
 * weight, no interrupt) and plays when it finishes. Its own family, not the
 * readback's, so neither preempts the other. `queueable` means a report that
 * cannot take the bus waits for it rather than being dropped on arrival —
 * and no more than that: the engine keeps ONE pending fire per bus, so
 * while the readback plays the report waits ALONE in that slot, and a
 * queueable fire of at least its weight that arrives then replaces it, and
 * the report is gone. That is the engine's one-slot limit, shared by every
 * queueable callout, and not something this contract can buy its way out
 * of. What `queueBehind` fixes is the other ordering, which rejoining
 * traffic makes common (the spotter shares the Voice bus): when the
 * readback itself has to wait, the report — published right after it in
 * the same tick, and the heavier of the two — would have taken its slot and
 * silently dropped the pit-exit confirmation. Instead it attaches behind
 * the waiting readback, both play in order once the bus idles, a readback
 * that fails to take the bus at replay leaves the report to play next, and
 * a readback cut mid-line by an interrupt while the report already waits is
 * put back ahead of it. Each keeps its own fate against a later fire: one
 * that outweighs the readback replaces the readback, and takes the report
 * with it only if it outweighs the report too.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { TireCorner, TireCornerWear, TireWearReport, TireZone } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The clip group the spoken percentages borrow — whole numbers 0–150, recorded for the temperature brief. */
const NUMBER_GROUP = "session-start-temp-numbers";

/** The four tires, in the order the report reads them and ties resolve in. */
const CORNERS: readonly TireCorner[] = ["lf", "rf", "lr", "rr"];

/** The three zones of one tire's tread, in the order ties resolve in. */
const ZONES: readonly TireZone[] = ["inside", "middle", "outside"];

/** The keys of the `tireWear.heaviestSpot` case — one per tire and zone. */
export type TireWearSpotKey = `${TireCorner}-${TireZone}`;

/** How each tire reads in prose, for the case-key descriptions. */
const CORNER_PROSE: Readonly<Record<TireCorner, string>> = {
  lf: "left-front",
  rf: "right-front",
  lr: "left-rear",
  rr: "right-rear",
};

/**
 * The declared key set of `tireWear.heaviestCorner`, each described for the
 * generated reference (#1066).
 *
 * @internal Exported for testing.
 */
export const TIRE_WEAR_CORNER_KEYS: Readonly<Record<TireCorner, string>> = {
  lf: "The left-front tire.",
  rf: "The right-front tire.",
  lr: "The left-rear tire.",
  rr: "The right-rear tire.",
};

/**
 * The declared key set of `tireWear.heaviestZone`, each described for the
 * generated reference (#1066). The zones are named from the car's
 * centerline rather than from the sim's left/middle/right, so the same word
 * means the same shoulder on both sides of the car.
 *
 * @internal Exported for testing.
 */
export const TIRE_WEAR_ZONE_KEYS: Readonly<Record<TireZone, string>> = {
  inside: "The inside shoulder — the edge of the tread nearer the car's centerline.",
  middle: "The middle of the tread.",
  outside: "The outside shoulder — the edge of the tread farther from the car's centerline.",
};

function spotDescription(corner: TireCorner, zone: TireZone): string {
  const tire = CORNER_PROSE[corner];

  if (zone === "middle") return `The middle of the ${tire} tire's tread.`;

  return `The ${zone} shoulder of the ${tire} tire, the edge ${zone === "inside" ? "nearer" : "farther from"} the car's centerline.`;
}

/**
 * The declared key set of `tireWear.heaviestSpot` — every tire crossed with
 * every zone, `<corner>-<zone>` — each described for the generated reference
 * (#1066). The bundled script maps all twelve, one recorded sentence each.
 *
 * @internal Exported for testing.
 */
export const TIRE_WEAR_SPOT_KEYS: Readonly<Record<TireWearSpotKey, string>> = Object.fromEntries(
  CORNERS.flatMap((corner) => ZONES.map((zone) => [`${corner}-${zone}`, spotDescription(corner, zone)])),
) as Record<TireWearSpotKey, string>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCorner(value: unknown): value is TireCorner {
  return typeof value === "string" && (CORNERS as readonly string[]).includes(value);
}

function isZone(value: unknown): value is TireZone {
  return typeof value === "string" && (ZONES as readonly string[]).includes(value);
}

/**
 * Whether a payload carries what the report cannot be spoken without: a
 * finite `tread` for each of the four tires. A shape check only — no range:
 * which numbers are speakable is the voice's clip set's business (#836).
 * `heaviest` is deliberately not required, since the script speaks it in an
 * optional clause.
 *
 * @internal Exported for testing.
 */
export function hasSpeakableTreads(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;

  const corners = (data as { corners?: unknown }).corners;

  if (typeof corners !== "object" || corners === null) return false;

  return CORNERS.every((corner) => {
    const wear = (corners as Partial<Record<TireCorner, unknown>>)[corner];

    return typeof wear === "object" && wear !== null && isFiniteNumber((wear as Partial<TireCornerWear>).tread);
  });
}

/**
 * The report a fire speaks — the payload of the `tireWear.reported` event
 * behind it, or `null` for any other fire (an imperative `fire(id)` carries
 * no event).
 */
function reportOf(ctx: ScenarioContext): Partial<TireWearReport> | null {
  const event = ctx.event;

  if (event?.event !== "tireWear.reported") return null;

  const data: unknown = event.data;

  return typeof data === "object" && data !== null ? (data as Partial<TireWearReport>) : null;
}

/**
 * One tire's tread as a whole percent, or `null` when the fire carries no
 * report or the reading is not a finite number.
 *
 * @internal Exported for testing.
 */
export function resolveCornerTread(ctx: ScenarioContext, corner: TireCorner): number | null {
  const tread = reportOf(ctx)?.corners?.[corner]?.tread;

  return isFiniteNumber(tread) ? Math.round(tread) : null;
}

/**
 * The most-worn tire and zone the report names, or `null` when the fire
 * carries no report or `heaviest` names no known tire and zone.
 */
function heaviestOf(ctx: ScenarioContext): { corner: TireCorner; zone: TireZone } | null {
  const heaviest = reportOf(ctx)?.heaviest;

  if (!heaviest || !isCorner(heaviest.corner) || !isZone(heaviest.zone)) return null;

  return { corner: heaviest.corner, zone: heaviest.zone };
}

/**
 * The key of `tireWear.heaviestSpot` for a fire: `<corner>-<zone>` of the
 * most-worn tread, or `null` with no usable report.
 *
 * @internal Exported for testing.
 */
export function resolveHeaviestSpot(ctx: ScenarioContext): TireWearSpotKey | null {
  const heaviest = heaviestOf(ctx);

  return heaviest ? `${heaviest.corner}-${heaviest.zone}` : null;
}

/**
 * The most-worn tire's tread as a whole percent — the lowest of all twelve
 * readings — or `null` with no usable report.
 *
 * @internal Exported for testing.
 */
export function resolveHeaviestTread(ctx: ScenarioContext): number | null {
  const heaviest = heaviestOf(ctx);

  return heaviest ? resolveCornerTread(ctx, heaviest.corner) : null;
}

/**
 * Whether the report shows any wear worth naming: the most-worn tire's tread,
 * as the whole percent the script speaks, is below 100. Read as the lowest of
 * the four tires' own treads, so it does not depend on `heaviest` being
 * present; false with no usable report. A set that reads 100 everywhere is
 * still reported, and its heaviest spot is then only the tie-break's first
 * pick (lf, inside) — naming it as where the wear is heaviest would be false.
 *
 * @internal Exported for testing.
 */
export function resolveHasWear(ctx: ScenarioContext): boolean {
  const treads = CORNERS.map((corner) => resolveCornerTread(ctx, corner)).filter((t): t is number => t !== null);

  return treads.length > 0 && Math.min(...treads) < 100;
}

/** A whole percent as its number clip, or nothing. */
function percentClip(value: number | null): string | null {
  return value === null ? null : poolRef(NUMBER_GROUP, String(value));
}

/**
 * Register the vocabulary the tire-wear script references (issue #1108): the
 * four per-tire tread vars and the most-worn tread, the `tireWear.hasWear`
 * condition that says whether there is any wear to name, and three cases
 * naming where the wear is heaviest — the spot, and the tire and the zone on
 * their own, so a pack can phrase the closing clause as one sentence per spot
 * (as the bundled voice does) or compose it from a tire line and a zone line.
 * Every name reads the fire's own `tireWear.reported` payload. Names and
 * descriptions are the public API of the format; the descriptions feed the
 * generated reference (#1066).
 */
export function registerTireWearVocabulary(
  engine: Pick<IScenarioEngine, "defineVar" | "defineCond" | "defineCase">,
): void {
  const treadVars: readonly [name: string, corner: TireCorner][] = [
    ["tireWear.leftFrontTread", "lf"],
    ["tireWear.rightFrontTread", "rf"],
    ["tireWear.leftRearTread", "lr"],
    ["tireWear.rightRearTread", "rr"],
  ];

  for (const [name, corner] of treadVars) {
    engine.defineVar(
      name,
      (ctx) => percentClip(resolveCornerTread(ctx, corner)),
      `The ${CORNER_PROSE[corner]} tire's remaining tread from the tire-wear report as a whole percent — the lowest of its three zones, rounded — drawn from the session-start-temp-numbers clip group, and nothing outside that report.`,
    );
  }

  engine.defineVar(
    "tireWear.heaviestTread",
    (ctx) => percentClip(resolveHeaviestTread(ctx)),
    "The remaining tread on the most-worn tire from the tire-wear report as a whole percent — the lowest of all twelve zone readings, rounded — drawn from the session-start-temp-numbers clip group, and nothing outside that report.",
  );

  engine.defineCond(
    "tireWear.hasWear",
    resolveHasWear,
    "At least one tire in the tire-wear report reads below one hundred percent as a whole number, so a heaviest-wear sentence names real wear rather than a tie-break between untouched tires.",
  );

  engine.defineCase(
    "tireWear.heaviestSpot",
    resolveHeaviestSpot,
    TIRE_WEAR_SPOT_KEYS,
    "Where the tire-wear report found the least tread left, as the tire and the zone of its tread together (lf-inside … rr-outside); ties go to the first tire front to rear, left before right, then inside before middle before outside.",
  );

  engine.defineCase(
    "tireWear.heaviestCorner",
    (ctx) => heaviestOf(ctx)?.corner ?? null,
    TIRE_WEAR_CORNER_KEYS,
    "Which tire the tire-wear report found the least tread left on, whatever the zone.",
  );

  engine.defineCase(
    "tireWear.heaviestZone",
    (ctx) => heaviestOf(ctx)?.zone ?? null,
    TIRE_WEAR_ZONE_KEYS,
    "Which zone of the most-worn tire's tread the tire-wear report found the least tread left in, named from the car's centerline so inside is the same shoulder on either side.",
  );
}

const TIRE_WEAR_REPORT: ScenarioContract = {
  id: "pit-crew.tire-wear-report",
  when: {
    event: "tireWear.reported",
    where: (e) => hasSpeakableTreads(e.data),
  },
  description:
    "You leave pit road after stopping in your pit box under your own power and stay out for about four and a half seconds, right behind the exit readback.",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  queueable: true,
  // Published right after the exit readback from the same settle timer: on a
  // busy bus, wait behind it rather than take its slot (see the header).
  queueBehind: ["pit-crew.pit-readback-exit"],
  family: "tire-wear",
};

export const TIRE_WEAR_CONTRACTS: readonly ScenarioContract[] = [TIRE_WEAR_REPORT];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const TIRE_WEAR_SCENARIO_IDS: readonly string[] = TIRE_WEAR_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the tire-wear script draws from directly — every
 * `pool:tire-wear/<base>` the bundled script writes: the four tire intros,
 * the word after the first number, and one whole sentence per tire and zone
 * for the heaviest-wear clause. The spoken numbers are the vars', whose
 * descriptions name their group. The completeness tests read this list: the
 * bundled voice must ship at least one clip for each, and the bundled script
 * must reference exactly this set. A `(group, base)` a script addresses is
 * published — renaming a base is a rename in every pack's script and every
 * pack's clip folder.
 */
export const TIRE_WEAR_CLIP_SOURCES: readonly { group: "tire-wear"; base: string }[] = [
  { group: "tire-wear", base: "left-front" },
  { group: "tire-wear", base: "right-front" },
  { group: "tire-wear", base: "left-rear" },
  { group: "tire-wear", base: "right-rear" },
  { group: "tire-wear", base: "percent" },
  { group: "tire-wear", base: "heaviest-lf-inside" },
  { group: "tire-wear", base: "heaviest-lf-middle" },
  { group: "tire-wear", base: "heaviest-lf-outside" },
  { group: "tire-wear", base: "heaviest-rf-inside" },
  { group: "tire-wear", base: "heaviest-rf-middle" },
  { group: "tire-wear", base: "heaviest-rf-outside" },
  { group: "tire-wear", base: "heaviest-lr-inside" },
  { group: "tire-wear", base: "heaviest-lr-middle" },
  { group: "tire-wear", base: "heaviest-lr-outside" },
  { group: "tire-wear", base: "heaviest-rr-inside" },
  { group: "tire-wear", base: "heaviest-rr-middle" },
  { group: "tire-wear", base: "heaviest-rr-outside" },
];
