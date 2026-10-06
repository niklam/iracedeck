/**
 * Phase 2 (#1349): the sim translator, the live race order it feeds the
 * template context, and the query-side runtime the Race Engineer reads.
 */
import { OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID } from "@iracedeck/audio-scenarios/pit-crew";
import { calloutKey, OPPONENT_FLAG_CALLOUTS } from "@iracedeck/callout-settings";
import { getGlobalSettings, isCalloutEnabled } from "@iracedeck/deck-core";
import { createIracingSimRuntime, type SimRuntime } from "@iracedeck/race-engineer-wiring";
import {
  getLiveRacePositions,
  initializeSimEventsIracing,
  sanitizeCornerCalloutLeadSeconds,
  sanitizeFuelCalloutMarginLaps,
  sanitizeGapAlertThresholdSeconds,
  sanitizeGapMinChangeSeconds,
  sanitizeOpponentFlagRangeSeconds,
} from "@iracedeck/sim-events-iracing";

import type { Core } from "../types.js";

export function initSim(core: Core): SimRuntime {
  // Translate sdkController ticks → semantic events on the bus. The only
  // package allowed to read `@iracedeck/iracing-sdk` for telemetry.
  // The laps-of-fuel-left margin (issue #838) is injected as a live-read
  // closure over global settings — sanitized so a malformed persisted value
  // can't poison the estimate — keeping sim-events-iracing deck-core-free.
  initializeSimEventsIracing(core.bus, core.controller, core.adapter.createLogger("SimEventsIracing"), {
    getFuelLapsLeftMarginLaps: () =>
      sanitizeFuelCalloutMarginLaps((getGlobalSettings() as Record<string, unknown>).fuelCalloutMarginLaps),
    // Corner-name announcement lead (issue #888) — same live-read + sanitize
    // shape as the fuel margin above.
    getCornerCalloutLeadSeconds: () =>
      sanitizeCornerCalloutLeadSeconds((getGlobalSettings() as Record<string, unknown>).cornerCalloutLeadSeconds),
    // Gap alert threshold (issue #933) — read live so a PI slider change takes
    // effect on the next tick without a restart. Clamp mirrors the schema.
    getGapAlertThresholdSeconds: () =>
      sanitizeGapAlertThresholdSeconds((getGlobalSettings() as Record<string, unknown>).gapAlertThresholdSeconds),
    // Consistency gate (issue #933 follow-up) — minimum gap movement in the
    // announced direction from its extreme since the side's last call. 0
    // disables.
    getGapMinChangeSeconds: () =>
      sanitizeGapMinChangeSeconds((getGlobalSettings() as Record<string, unknown>).gapCalloutMinChangeSeconds),
    // Opponent-flag opt-ins enforced translator-side (issue #936 review) — a
    // disabled subject must never feed the burst aggregation or redirect an
    // enabled subject into a collapsed aggregate. The same live lookup the
    // audio layer's gate in registerPitCrew asks; the map translates the bus
    // enum (the meatball is `Repair`) to the callout id, and the registry
    // resolves that id to its settings key (#1350).
    getOpponentFlagCalloutEnabled: (flag) =>
      isCalloutEnabled(calloutKey(OPPONENT_FLAG_CALLOUTS, OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID[flag])),
    // Opponent-flag range (issue #1274) — only a same-class car within this
    // race gap, ahead or behind, is announced. Read live per announce so a
    // settings change applies to the next one; clamp mirrors the schema.
    getOpponentFlagRangeSeconds: () =>
      sanitizeOpponentFlagRangeSeconds((getGlobalSettings() as Record<string, unknown>).opponentFlagRangeSeconds),
  });

  // Feed the translator's live per-car race order into the template-context builder
  // so Telemetry Display / Chat / Race Admin driver prefixes report the same
  // continuously-updating positions (overall + class) as the Session Info display,
  // for every car (issue #700).
  core.controller.setLivePositionsProvider(() => getLiveRacePositions());

  // The one place a sim translator is chosen and constructed (#1349); a second
  // one slots in here (#1351).
  return createIracingSimRuntime();
}
