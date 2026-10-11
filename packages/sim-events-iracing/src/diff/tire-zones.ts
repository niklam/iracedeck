/**
 * Naming the three readings across a tire's tread (issues #1108, #254).
 *
 * iRacing's L / M / R are the car's left / middle / right, whichever tire they
 * belong to. The tire wear report and the last-stop tire temperatures name the
 * zones from the car's centreline instead, so "inside" means the same shoulder
 * on all four corners. Both families take the mapping from here, so wear and
 * temperature of one zone can be read side by side — and with it the corner
 * table and the rule for when the twelve readings can be trusted.
 */
import type { TireCorner, TireZone } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";

/** Which side of the car a tire sits on — decides which shoulder is the inside. */
export type TireSide = "left" | "right";

/** The telemetry families that carry one reading per tread zone: `LFwearL`, `LFtempCL`, … */
export type TireZoneFamily = "wear" | "tempC";

type CornerPrefix = "LF" | "RF" | "LR" | "RR";

/**
 * The four corners in the order every consumer walks them — the tie-break
 * order of the wear contract: lf, rf, lr, rr.
 */
export const TIRE_CORNERS: ReadonlyArray<{ corner: TireCorner; prefix: CornerPrefix; side: TireSide }> = [
  { corner: "lf", prefix: "LF", side: "left" },
  { corner: "rf", prefix: "RF", side: "right" },
  { corner: "lr", prefix: "LR", side: "left" },
  { corner: "rr", prefix: "RR", side: "right" },
];

type ZoneField = keyof TelemetryData & `${CornerPrefix}${TireZoneFamily}${"L" | "M" | "R"}`;

function fieldsOf(family: TireZoneFamily): readonly ZoneField[] {
  return TIRE_CORNERS.flatMap(({ prefix }) =>
    (["L", "M", "R"] as const).map((zone): ZoneField => `${prefix}${family}${zone}`),
  );
}

/** The twelve field names per family, in `TIRE_CORNERS` order, each corner as the car's left / middle / right. */
const ZONE_FIELDS: Record<TireZoneFamily, readonly ZoneField[]> = {
  wear: fieldsOf("wear"),
  tempC: fieldsOf("tempC"),
};

/**
 * The twelve readings of a family in `TIRE_CORNERS` order — corner `i` is at
 * `[i * 3]` (car-left), `[i * 3 + 1]` (middle) and `[i * 3 + 2]` (car-right) —
 * or `null` when there is nothing trustworthy to read: any value missing or
 * non-finite, or all twelve zero (a car without that model).
 */
export function readTireZoneValues(telemetry: TelemetryData, family: TireZoneFamily): number[] | null {
  const fields = ZONE_FIELDS[family];
  const values: number[] = [];

  for (const field of fields) {
    const value = telemetry[field];

    if (typeof value !== "number" || !Number.isFinite(value)) return null;

    values.push(value);
  }

  return values.every((value) => value === 0) ? null : values;
}

/**
 * Whether the twelve readings of a family are exactly `held` (as
 * `readTireZoneValues` returned them). Allocates nothing, so a tracker can ask
 * on every tick of a stint through which the sim holds the values still.
 */
export function tireZoneValuesAre(telemetry: TelemetryData, family: TireZoneFamily, held: readonly number[]): boolean {
  const fields = ZONE_FIELDS[family];

  for (let i = 0; i < fields.length; i++) {
    if (telemetry[fields[i]!] !== held[i]) return false;
  }

  return true;
}

/**
 * A tire's three readings by zone, from the sim's car-left / middle / car-right
 * order. On the left-side tires the sim's L is the outside shoulder and R the
 * inside; on the right-side tires it is the other way round. The #1108 capture
 * confirms it — both fronts wear lowest on the inside, the negative-camber
 * signature.
 */
export function zonesFromCarSides(
  side: TireSide,
  left: number,
  middle: number,
  right: number,
): Record<TireZone, number> {
  return side === "left" ? { inside: right, middle, outside: left } : { inside: left, middle, outside: right };
}
