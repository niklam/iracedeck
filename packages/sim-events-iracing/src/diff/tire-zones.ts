/**
 * Naming the three readings across a tire's tread (issues #1108, #254).
 *
 * iRacing's L / M / R are the car's left / middle / right, whichever tire they
 * belong to. The tire wear report and the last-stop tire temperatures name the
 * zones from the car's centreline instead, so "inside" means the same shoulder
 * on all four corners. Both families take the mapping from here, so wear and
 * temperature of one zone can be read side by side.
 */
import type { TireZone } from "@iracedeck/event-bus";

/** Which side of the car a tire sits on — decides which shoulder is the inside. */
export type TireSide = "left" | "right";

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
