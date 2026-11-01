/**
 * Phase 2 (#1349): the sim translator, the live race order it feeds the
 * template context, and the two read surfaces it hands on — the query-side
 * runtime the Race Engineer reads (#1378) and the host extension's sim
 * (#1500), so a plugin shell reads the session kind and the tick without
 * importing a sim package.
 */
import type { ProfileSwitchSessionKind } from "@iracedeck/app-constants";
import { onIRacingTerminated } from "@iracedeck/deck-iracing";
import { createIracingSimRuntime, createIracingTranslatorOptions } from "@iracedeck/race-engineer-wiring";
import {
  getLiveRacePositions,
  getSessionKind,
  getSessionType,
  initializeSimEventsIracing,
  onTranslatorTick,
  type SessionKind,
} from "@iracedeck/sim-events-iracing";

import type { Core, HostSim, Sim } from "../types.js";

/** Compiles only for `true`, so the conditional it is given fails the build when it is `false`. */
type IsTrue<T extends true> = T;

/**
 * The translator's `SessionKind` and the profile switch's
 * `ProfileSwitchSessionKind` name the same five kinds (#1500), checked in both
 * directions. They are kept apart on purpose — the translator imports no
 * deck-layer constant — and this is the one module that sees both, so a kind
 * added on either side fails `pnpm build` and `pnpm typecheck` here until the
 * other agrees. Exported only so the alias is not an unused one;
 * `sim.test.ts` checks that the classifier produces every kind.
 *
 * @internal
 */
export type SessionKindsAgree = IsTrue<
  [SessionKind] extends [ProfileSwitchSessionKind]
    ? [ProfileSwitchSessionKind] extends [SessionKind]
      ? true
      : false
    : false
>;

export function initSim(core: Core): Sim {
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

  // The host extension's view of the sim (#1500). Each member calls through
  // when it is used, so building it subscribes nothing; `onTick` listeners run
  // after the translator's own handling of each controller callback.
  const host: HostSim = {
    getSessionKind: () => getSessionKind(),
    getRawSessionType: () => getSessionType(),
    onTick: (listener) => onTranslatorTick(listener),
    onSimTerminated: (listener) => onIRacingTerminated(listener),
  };

  // The one place a sim translator is chosen and constructed (#1349); a second
  // one slots in here (#1351).
  return { runtime: createIracingSimRuntime(), host };
}
