/**
 * The iRacing translator's options, built from the Race Engineer settings
 * (#1378). Beside {@link createIracingSimRuntime} because the two are the
 * same decision from opposite sides: the runtime is what the Race Engineer
 * reads of the translator, the options are what the translator reads of the
 * Race Engineer's settings. The plugins' sim phase and the scenario harness
 * both call it, so the six settings apply in the harness as they do in the
 * plugin.
 */
import { OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID, type OpponentFlagCalloutId } from "@iracedeck/audio-scenarios/pit-crew";
import { calloutKey, OPPONENT_FLAG_CALLOUTS } from "@iracedeck/callout-settings";
import type { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { getGlobalSettings, isCalloutEnabled } from "@iracedeck/settings";
import {
  sanitizeCornerCalloutLeadSeconds,
  sanitizeFuelCalloutMarginLaps,
  sanitizeGapAlertThresholdSeconds,
  sanitizeGapMinChangeSeconds,
  sanitizeOpponentFlagRangeSeconds,
  type SimEventsIracingOptions,
} from "@iracedeck/sim-events-iracing";

/**
 * Whether the user has the opponent-flag callout for `flag` switched on,
 * read live (issue #936 review). Typed against the bus enum rather than a
 * translator's option type, so a second translator's options take the same
 * function. The map translates the bus enum (the meatball is `Repair`) to
 * the callout id, and the registry resolves that id to its settings key
 * (#1350). A flag the map does not know yet — a new bus value ahead of its
 * callout id — falls open, as it did before the registry: an unknown flag
 * is never silenced.
 */
export function isOpponentFlagCalloutEnabled(flag: OpponentPenaltyFlag): boolean {
  const id: OpponentFlagCalloutId | undefined = OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID[flag];

  return id === undefined || isCalloutEnabled(calloutKey(OPPONENT_FLAG_CALLOUTS, id));
}

/**
 * Every option `initializeSimEventsIracing` takes, each a live read over the
 * global settings, sanitized so a malformed persisted value cannot poison the
 * diff that reads it. `Required`, so a new translator option fails
 * `pnpm typecheck` here until this builds it — the `buildPitCrewDeps` rule
 * from the other side of the seam.
 */
export function createIracingTranslatorOptions(): Required<SimEventsIracingOptions> {
  return {
    // The laps-of-fuel-left margin (issue #838) — the first of these, and the
    // shape the rest follow: a live-read closure over the global settings,
    // sanitized, keeping sim-events-iracing deck-core-free.
    getFuelLapsLeftMarginLaps: () => sanitizeFuelCalloutMarginLaps(getGlobalSettings().fuelCalloutMarginLaps),
    // Corner-name announcement lead (issue #888).
    getCornerCalloutLeadSeconds: () => sanitizeCornerCalloutLeadSeconds(getGlobalSettings().cornerCalloutLeadSeconds),
    // Gap alert threshold (issue #933) — read live so a PI slider change takes
    // effect on the next tick without a restart. Clamp mirrors the schema.
    getGapAlertThresholdSeconds: () => sanitizeGapAlertThresholdSeconds(getGlobalSettings().gapAlertThresholdSeconds),
    // Consistency gate (issue #933 follow-up) — minimum gap movement in the
    // announced direction from its extreme since the side's last call. 0
    // disables.
    getGapMinChangeSeconds: () => sanitizeGapMinChangeSeconds(getGlobalSettings().gapCalloutMinChangeSeconds),
    // Opponent-flag opt-ins enforced translator-side (issue #936 review) — a
    // disabled subject must never feed the burst aggregation or redirect an
    // enabled subject into a collapsed aggregate. The same live lookup the
    // audio layer's gate in registerPitCrew asks.
    getOpponentFlagCalloutEnabled: isOpponentFlagCalloutEnabled,
    // Opponent-flag range (issue #1274) — only a same-class car within this
    // race gap, ahead or behind, is announced. Read live per announce so a
    // settings change applies to the next one; clamp mirrors the schema.
    getOpponentFlagRangeSeconds: () => sanitizeOpponentFlagRangeSeconds(getGlobalSettings().opponentFlagRangeSeconds),
  };
}
