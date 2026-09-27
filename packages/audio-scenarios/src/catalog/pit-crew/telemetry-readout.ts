/**
 * Telemetry readout on a key press (issue #466).
 *
 * Five contracts, all fired by `telemetryReadout.requested` — the first bus
 * event published by the DECK layer rather than the sim translator: a Pit
 * Crew key set to Telemetry Readout reads the figure at the moment of the
 * press, converts it to the driver's display unit and publishes it. One
 * contract per kind, plus `pit-crew.readout-no-data` for a fuel kind whose
 * value is `null` (no valid lap on record yet), so a pack can phrase each on
 * its own terms.
 *
 * WHAT is said lives in the active voice's `callouts.json` under the same
 * ids. The bundled script speaks a fuel figure as an intro, the whole part
 * (`numbers-fuel`, 0–120) and a tail that carries the tenths digit AND the
 * unit (`numbers-fuel-decimal`, "point four liters.") — the lap-time shape:
 * the one seam left is whole → "point", which the whole clips are recorded
 * to lead into. Temperatures reuse the session-start brief's `numbers-degrees`
 * figures; the unit is not named, but `readout.degreesUnit` lets a pack add
 * it exactly as it can for the brief.
 *
 * **Everything is read off the fire's own event.** The value was captured at
 * press time (the readback's #481 rule does not apply: a readout answers
 * "what was it when I asked", and a queued fire replays with the very event
 * that fired it). Every var returns `null` for any other fire, which aborts
 * a required step.
 *
 * **No range is checked (#836).** Rounding happens once, to a tenth, before
 * the split; a figure no clip exists for (above 120.9, a temperature outside
 * −20…176) resolves to an empty pool and the callout is silent. The one
 * refusal is a figure no clip NAME can express — negative or non-finite.
 *
 * **Scheduling.** `READOUT_WEIGHT`, strictly between CHATTER and NORMAL:
 * a driver's request yields to every engineer line of normal weight or
 * above — it never displaces one waiting its turn — and beats background
 * chatter such as the pit readback. `queueable: true`, the default radio
 * frame, and deliberately NO `family`: a same-family fire replaces the
 * in-flight one regardless of weight, which would let a second press cut the
 * readout the driver is listening to. So a press while anything plays waits
 * in the bus's one pending slot (#1185), and there:
 *
 * - a newer readout replaces a readout still waiting (equal weight, ties go
 *   to the newest) — a burst of presses never builds a backlog;
 * - a readout pressed while a NORMAL-or-heavier line is waiting is dropped,
 *   and that line keeps its place (a pit-limiter warning is never lost to a
 *   key press);
 * - a readout pressed while a CHATTER line is waiting replaces it;
 * - a NORMAL-or-heavier queueable line arriving while a readout waits
 *   replaces the readout.
 *
 * No `queueBehind`: it would pair a newer readout behind a waiting one,
 * which is exactly the backlog the spec rules out. No `interrupt`: a readout
 * never cuts what is playing.
 *
 * **Gating is the Race Engineer master only.** `registerPitCrew` wraps these
 * contracts with the master gate and nothing else — pressing the key is the
 * opt-in, so there is no `calloutEnabled*` key and no callout id map.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { TelemetryReadoutRequest, TelemetryReadoutUnit } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { TEMPERATURE_UNIT_DESCRIPTION, temperatureNumberRef, temperatureUnitRef } from "./temperature-number.js";

const EVENT = "telemetryReadout.requested";

/**
 * The scheduling weight of every readout — strictly between CHATTER and
 * NORMAL. A driver's request yields to every engineer line of normal weight
 * or above — never displaces one waiting — and beats background chatter
 * (the pit readback). See the header's scheduling paragraph.
 */
export const READOUT_WEIGHT: number = WEIGHT.NORMAL - 10;

/** The whole part of a fuel figure — "two", 0 to 120. */
export const FUEL_NUMBER_GROUP = "numbers-fuel";

/** The tenths digit with its unit — "point four liters.", liters-0…9 and gallons-0…9. */
export const FUEL_DECIMAL_GROUP = "numbers-fuel-decimal";

/** How many laps an average covers — "lap," for one, "five laps," above. */
export const READOUT_LAPS_GROUP = "readout-laps";

type FuelUnit = Extract<TelemetryReadoutUnit, "liters" | "gallons">;
type TempUnit = Extract<TelemetryReadoutUnit, "celsius" | "fahrenheit">;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFuelUnit(unit: unknown): unit is FuelUnit {
  return unit === "liters" || unit === "gallons";
}

function isTempUnit(unit: unknown): unit is TempUnit {
  return unit === "celsius" || unit === "fahrenheit";
}

function isFuelKind(kind: unknown): boolean {
  return kind === "fuel-last-lap" || kind === "fuel-average";
}

/** A payload as the `where:` and the resolvers see it, or `null` when it is not an object. */
function payloadOf(data: unknown): Partial<TelemetryReadoutRequest> | null {
  return typeof data === "object" && data !== null ? (data as Partial<TelemetryReadoutRequest>) : null;
}

/** The request a fire speaks — the payload of its `telemetryReadout.requested` event, or `null` for any other fire. */
function readoutOf(ctx: ScenarioContext): Partial<TelemetryReadoutRequest> | null {
  const event = ctx.event;

  return event?.event === EVENT ? payloadOf(event.data) : null;
}

/**
 * A fuel figure rounded ONCE to a tenth and split into the whole part and
 * the tenths digit — 2.45 is 2 and 5, 0.96 is 1 and 0, never 0 and 10.
 * `null` for a figure no clip name can express (negative or not finite).
 *
 * @internal Exported for testing
 */
export function splitFuelFigure(value: number): { whole: number; tenth: number } | null {
  if (!Number.isFinite(value) || value < 0) return null;

  const tenths = Math.round(value * 10);

  return { whole: Math.floor(tenths / 10), tenth: tenths % 10 };
}

/** The fuel figure of a fire, split, with its unit — or `null`. */
function fuelFigureOf(ctx: ScenarioContext): { whole: number; tenth: number; unit: FuelUnit } | null {
  const r = readoutOf(ctx);

  if (!r || !isFuelUnit(r.unit) || !isFiniteNumber(r.value)) return null;

  const split = splitFuelFigure(r.value);

  return split ? { ...split, unit: r.unit } : null;
}

/** @internal Exported for testing */
export function resolveFuelNumber(ctx: ScenarioContext): string | null {
  const figure = fuelFigureOf(ctx);

  return figure ? poolRef(FUEL_NUMBER_GROUP, String(figure.whole)) : null;
}

/** @internal Exported for testing */
export function resolveFuelDecimal(ctx: ScenarioContext): string | null {
  const figure = fuelFigureOf(ctx);

  return figure ? poolRef(FUEL_DECIMAL_GROUP, `${figure.unit}-${figure.tenth}`) : null;
}

/** @internal Exported for testing */
export function resolveLaps(ctx: ScenarioContext): string | null {
  const laps = readoutOf(ctx)?.laps;

  return isFiniteNumber(laps) && Number.isInteger(laps) && laps >= 1 ? poolRef(READOUT_LAPS_GROUP, String(laps)) : null;
}

/** @internal Exported for testing */
export function resolveTempNumber(ctx: ScenarioContext): string | null {
  const r = readoutOf(ctx);

  return r && isTempUnit(r.unit) && isFiniteNumber(r.value) ? temperatureNumberRef(r.value) : null;
}

/** @internal Exported for testing */
export function resolveDegreesUnit(ctx: ScenarioContext): string | null {
  const r = readoutOf(ctx);

  return r && isTempUnit(r.unit) ? temperatureUnitRef(r.unit) : null;
}

/**
 * Register the vocabulary the readout scripts name (issue #466). Every var
 * reads the fire's own `telemetryReadout.requested` payload. Names and
 * descriptions are the public API of the script format (#1066); each
 * description names the clip group it draws from so the recording script
 * and `lint:pack` attribute the group to it.
 */
export function registerTelemetryReadoutVocabulary(engine: Pick<IScenarioEngine, "defineVar">): void {
  engine.defineVar(
    "readout.fuelNumber",
    resolveFuelNumber,
    "The whole-number part of the fuel figure a Telemetry Readout key asked for, after rounding to a tenth, in the driver's display unit — drawn from the numbers-fuel clip group (0 to 120); a figure the voice has no clip for silences the callout.",
  );
  engine.defineVar(
    "readout.fuelDecimal",
    resolveFuelDecimal,
    'The tenths digit of that fuel figure together with its unit, recorded as one line ("point four liters.") — drawn from the numbers-fuel-decimal clip group, liters-0 to liters-9 and gallons-0 to gallons-9.',
  );
  engine.defineVar(
    "readout.laps",
    resolveLaps,
    'How many clean laps an average fuel readout covers — the laps actually averaged, fewer than the key\'s setting early in a stint — drawn from the readout-laps clip group (1 to 20), recorded as "lap," for one and "five laps," above.',
  );
  engine.defineVar(
    "readout.tempNumber",
    resolveTempNumber,
    "The temperature a Telemetry Readout key asked for, track or air, as a whole number in the driver's display unit — drawn from the numbers-degrees clip group the session-start brief speaks, whose lines carry the word degrees and cover -20 to 176.",
  );
  engine.defineVar("readout.degreesUnit", resolveDegreesUnit, TEMPERATURE_UNIT_DESCRIPTION);
}

function readoutContract(
  id: string,
  description: string,
  where: (data: Partial<TelemetryReadoutRequest>) => boolean,
): ScenarioContract {
  return {
    id,
    when: {
      event: EVENT,
      where: (e) => {
        const data = payloadOf(e.data);

        return data !== null && where(data);
      },
    },
    description,
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    // Queue behind whatever plays, yield to every NORMAL-or-heavier line; a
    // newer readout replaces a waiting one. No `family` — see the header.
    weight: READOUT_WEIGHT,
    queueable: true,
  };
}

export const TELEMETRY_READOUT_CONTRACTS: readonly ScenarioContract[] = [
  readoutContract(
    "pit-crew.readout-fuel-last-lap",
    "You press a Pit Crew Telemetry Readout key set to fuel used last lap, with at least one clean lap on record.",
    (d) => d.kind === "fuel-last-lap" && isFiniteNumber(d.value),
  ),
  readoutContract(
    "pit-crew.readout-fuel-average",
    "You press a Pit Crew Telemetry Readout key set to average fuel per lap, with at least one clean lap on record.",
    (d) => d.kind === "fuel-average" && isFiniteNumber(d.value),
  ),
  readoutContract(
    "pit-crew.readout-track-temp",
    "You press a Pit Crew Telemetry Readout key set to track temperature.",
    (d) => d.kind === "track-temp" && isFiniteNumber(d.value),
  ),
  readoutContract(
    "pit-crew.readout-air-temp",
    "You press a Pit Crew Telemetry Readout key set to air temperature.",
    (d) => d.kind === "air-temp" && isFiniteNumber(d.value),
  ),
  readoutContract(
    "pit-crew.readout-no-data",
    "You press a Pit Crew Telemetry Readout key for a fuel figure before any clean lap is on record.",
    (d) => isFuelKind(d.kind) && d.value === null,
  ),
];

/** Contract ids exported for tests so a typo here surfaces as a test failure. */
export const TELEMETRY_READOUT_SCENARIO_IDS: readonly string[] = TELEMETRY_READOUT_CONTRACTS.map((c) => c.id);

/**
 * The clip sources the readout script draws from directly — the four intros
 * and the no-data line. The figures are the vars', whose descriptions name
 * their groups. The completeness tests read this list: the bundled voice
 * must ship a clip for each, and the bundled script must reference exactly
 * this set.
 */
export const TELEMETRY_READOUT_CLIP_SOURCES: readonly { group: "telemetry-readout"; base: string }[] = [
  { group: "telemetry-readout", base: "fuel-last-lap-intro" },
  { group: "telemetry-readout", base: "fuel-average-intro" },
  { group: "telemetry-readout", base: "track-temp-intro" },
  { group: "telemetry-readout", base: "air-temp-intro" },
  { group: "telemetry-readout", base: "no-data" },
];
