/**
 * The pool a driver-name var returns (issue #1580): the spelling the user
 * picked, resolved to the clip set the ACTIVE voice speaks it with.
 *
 * A spelling is not always a slug the voice records: `geoff` is spoken as
 * `jeff` (`@iracedeck/callout-script`'s `DRIVER_NAME_ALIASES`), and a voice
 * that records only `jeff` would otherwise skip every greeting for a Geoff.
 * So every var that speaks the driver's name builds its ref here instead of
 * with a bare `poolRef`, and takes a `DriverNameGroup` so that a name group
 * cannot be addressed any other way by accident — the catalog test over the
 * vars whose descriptions name such a group catches a bare `poolRef`.
 *
 * The `names` group decides for every line, so one name is always spoken
 * from one clip set; it is read from the engine it is handed, never from
 * `getScenarioEngine()`, and at fire time, so a voice change or a rescan
 * takes effect on the next line.
 */
import { type DriverNameGroup, resolveDriverNameSlug } from "@iracedeck/callout-script";

import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";

/** The group whose clips decide whether a voice records a name. */
const NAMES_GROUP: DriverNameGroup = "names";

/**
 * `pool:<group>/<slug>` for `spelling`: the spelling itself when the active
 * voice records it under `names/`, else its alias's canonical when the voice
 * records that, else the spelling unchanged (a name the voice lacks — the
 * pool is then empty and the step skips, as it always did).
 */
export function driverNameRef(
  engine: Pick<IScenarioEngine, "recordedBases">,
  group: DriverNameGroup,
  spelling: string,
): string {
  return poolRef(group, resolveDriverNameSlug(spelling, engine.recordedBases(NAMES_GROUP)) ?? spelling);
}
