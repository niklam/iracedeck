/**
 * Sector-start callout (issue #1573) — the engineer says "Sector three." as
 * the car reaches a sector start in practice and test sessions, timed by the
 * same lead point (the corner call lead) as the corner names.
 *
 * The code below decides WHETHER and WHEN the sector is called and how it is
 * scheduled; WHAT is said lives in the active voice's `callouts.json` under
 * the same id (`scenarios["pit-crew.sector-start-approaching"]`). The bundled
 * script is the one step `{{sectorStart.number}}`, the var registered by
 * {@link registerSectorStartVocabulary}, which turns the event's sector into
 * `pool:sector-number/<n>` — so the family addresses no pool of its own and
 * its `SECTOR_START_CLIP_SOURCES` is empty, as lap-time's vars are.
 *
 * **Sector one is never spoken.** The translator reports every crossing,
 * the line included; the contract refuses `sector === 1`, because the line
 * is the lap's own marker and where the lap-time calls speak.
 *
 * **Both calls are heard, in track order (#1676).** A sector start and a
 * corner name often come due together; each still fires at its own marker,
 * and whichever is published first plays first, the second queued behind it
 * by the bus. Neither cuts the other: separate families (sharing
 * `corner-name` would let one cut the other mid-word) and no `interrupt`.
 * When the sector call plays first, the heavier corner name (`WEIGHT.NORMAL`
 * over this contract's `WEIGHT.CHATTER`) waits for it, queueable or not,
 * and plays the moment it ends; when the corner name plays first, this
 * contract is `queueable`, so the sector call waits for the name rather
 * than being dropped. On a tick that sweeps both, the translator publishes
 * the sector start first, so the call lands on the line.
 *
 * **A call more than 1.5 s late is dropped.** Both contracts carry
 * {@link MARKER_CALL_MAX_LAG_MS} as `maxQueueWaitMs`, measured from the
 * fire's arrival: a sector named well after the car has passed its start is
 * a wrong call, not a late one (#888's reasoning for the corner names). The
 * one path past the bound is a sector call cut mid-word by a heavier
 * `interrupt` line (the spotter): the engine stashes it and replays it whole
 * with its wait restarted at the cut, until #1681 keeps a stash's first due
 * time. Being queueable, it also waits behind any other line in flight, and
 * heavier waiting lines go before it.
 *
 * Session gating (practice and test only) lives in the translator diff, not
 * here (#655, #888), so the contract stays firable from the scenario harness.
 * The family keeps no module state: every read is the fire's own event.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutIdOf, SECTOR_START_CALLOUTS } from "@iracedeck/callout-settings";
import type { SimEventOf } from "@iracedeck/event-bus";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { NO_FRAME, poolRef, WEIGHT } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import { MARKER_CALL_MAX_LAG_MS } from "./corner-name.js";

/** The payload of a `sectorStart.approaching` event. */
export type SectorStartData = SimEventOf<"sectorStart.approaching">["data"];

const SECTOR_NUMBER_GROUP = "sector-number";

/** A sector a driver can be told: a whole number from 1 up. */
function isSectorNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** The fire's own `sectorStart.approaching` payload, or null for any other fire (an imperative one included). */
function sectorStartOf(ctx: ScenarioContext): SectorStartData | null {
  if (ctx.event?.event !== "sectorStart.approaching") return null;

  return (ctx.event as SimEventOf<"sectorStart.approaching">).data ?? null;
}

/**
 * Register the vocabulary the sector-start script references: the sector's
 * number clip, and whether it is the track's last sector. Must run before
 * the contract is defined so the first `setScripts` compile sees it.
 */
export function registerSectorStartVocabulary(engine: Pick<IScenarioEngine, "defineVar" | "defineCond">): void {
  engine.defineVar(
    "sectorStart.number",
    (ctx) => {
      const data = sectorStartOf(ctx);

      return data && isSectorNumber(data.sector) ? poolRef(SECTOR_NUMBER_GROUP, String(data.sector)) : null;
    },
    'The sector the car is entering, from the sector-number clip group, base the sector\'s number (sector-number/3 is "Sector three."); a sector the voice has no clip for skips the callout.',
  );

  engine.defineCond(
    "sectorStart.isFinal",
    (ctx) => {
      const data = sectorStartOf(ctx);

      return data !== null && isSectorNumber(data.sector) && data.sector === data.sectorCount;
    },
    "The sector the car is entering is the track's last one, so a pack may say something like final sector instead of its number.",
  );
}

/**
 * The sector-start contract. A constant since #1676: with the corner-name
 * suppression gone, its `where:` reads the fire's own event and nothing
 * else.
 */
export const SECTOR_START_CONTRACT: ScenarioContract = {
  id: "pit-crew.sector-start-approaching",
  channel: AudioChannel.Voice,
  bus: AudioBus.Voice,
  base: "voice/{voice}",
  family: "sector-start",
  weight: WEIGHT.CHATTER,
  interrupt: false,
  // Waits for a line in flight — a corner name due at the same moment above
  // all — instead of being dropped (#1676), but never longer than a call
  // stays right: a sector called well after the car has passed its start is
  // a wrong call, not a late one (#888's reasoning for the corner names).
  queueable: true,
  maxQueueWaitMs: MARKER_CALL_MAX_LAG_MS,
  // Terse delivery, as the corner names: a beep frame would eat the lead
  // that times the call to the sector line.
  frame: NO_FRAME,
  description:
    "Your car reaches the point about a second (the configured lead) before a sector start in a practice or test session, once per sector per lap except at start/finish; qualifying and races stay silent.",
  when: {
    event: "sectorStart.approaching",
    where: (e) => {
      const data = (e as SimEventOf<"sectorStart.approaching">).data;

      // Sector one starts at the line, the lap's own marker: never called.
      return isSectorNumber(data.sector) && data.sector !== 1;
    },
  },
};

/** Stable identifier for the sector-start callout family (issue #1573). */
export type SectorStartCalloutId = CalloutIdOf<typeof SECTOR_START_CALLOUTS>;

export const SCENARIO_ID_TO_SECTOR_START_ID: Record<string, SectorStartCalloutId> = {
  "pit-crew.sector-start-approaching": "sector-starts",
};

export const SECTOR_START_SCENARIO_IDS: readonly string[] = ["pit-crew.sector-start-approaching"];

/**
 * The family addresses no pool of its own: its one line is the
 * `sectorStart.number` var, which draws from the sector-number group by
 * value and names it in its description.
 */
export const SECTOR_START_CLIP_SOURCES: readonly { group: string; base: string }[] = [];
