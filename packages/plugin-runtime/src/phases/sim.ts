/**
 * Phase 2 (#1349): the sim translator, the live race order it feeds the
 * template context, and the query-side runtime the Race Engineer reads.
 */
import {
  createIracingSimRuntime,
  createIracingTranslatorOptions,
  type SimRuntime,
} from "@iracedeck/race-engineer-wiring";
import { getLiveRacePositions, initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";

import type { Core } from "../types.js";

export function initSim(core: Core): SimRuntime {
  // Translate sdkController ticks → semantic events on the bus. The only
  // package allowed to read `@iracedeck/iracing-sdk` for telemetry. Its six
  // settings-backed options — the fuel margin, the corner lead, the gap
  // threshold and consistency gate, the opponent-flag opt-ins and range —
  // are built by the Race Engineer's wiring (#1378), so the scenario harness
  // runs the same ones.
  initializeSimEventsIracing(
    core.bus,
    core.controller,
    core.adapter.createLogger("SimEventsIracing"),
    createIracingTranslatorOptions(),
  );

  // Feed the translator's live per-car race order into the template-context builder
  // so Telemetry Display / Chat / Race Admin driver prefixes report the same
  // continuously-updating positions (overall + class) as the Session Info display,
  // for every car (issue #700).
  core.controller.setLivePositionsProvider(() => getLiveRacePositions());

  // The one place a sim translator is chosen and constructed (#1349); a second
  // one slots in here (#1351).
  return createIracingSimRuntime();
}
