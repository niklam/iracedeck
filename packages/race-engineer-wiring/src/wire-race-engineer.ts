import { type PitCrewDeps, registerPitCrew } from "@iracedeck/audio-scenarios/pit-crew";
import type { IEventBus } from "@iracedeck/event-bus";
import type { ILogger } from "@iracedeck/logger";

import { subscribeRaceEngineerCaches } from "./caches.js";
import { buildPitCrewDeps } from "./pit-crew-deps.js";
import type { SimRuntime } from "./sim-runtime.js";

/**
 * The driver-name state the voice-pack phase owns (#1349). Read on every
 * call: a rescan replaces `driverNames`, and the plugins pass the phase's
 * own state object, so the wiring always sees the current list.
 */
export interface RaceEngineerVoiceState {
  readonly driverNames: readonly string[];
}

/**
 * What the wiring takes beyond what it imports. Settings, the setup-warning
 * rule and the driver-name resolution come from `@iracedeck/settings` directly.
 * The plugins pass no `overrides`; the harness (slice 2) passes its snapshot stubs.
 */
export interface RaceEngineerWiringDeps {
  /** The wiring's root logger (the bootstrap passes `adapter.createLogger("RaceEngineer")`); every logger it makes is a `createScope` of it. */
  readonly logger: ILogger;
  readonly sim: SimRuntime;
  readonly voice: RaceEngineerVoiceState;
  /**
   * Wins over what the wiring builds. A key whose value is `undefined` is
   * dropped rather than spread: spreading it would erase the built dependency,
   * and `registerPitCrew` would then fall back to its default without a word.
   */
  readonly overrides?: Partial<PitCrewDeps>;
}

/**
 * The Race Engineer's wiring (#1349): the bus caches, then `registerPitCrew`
 * with every one of its dependencies. Returns what it passed, for tests and
 * the harness's coverage check. Call after `initializeAudioScenarios` and
 * before handing the engine its scripts.
 */
export function wireRaceEngineer(bus: IEventBus, deps: RaceEngineerWiringDeps): Readonly<PitCrewDeps> {
  const caches = subscribeRaceEngineerCaches(bus, deps.logger);
  const pitCrewDeps: PitCrewDeps = { ...buildPitCrewDeps(deps, caches), ...definedOverrides(deps.overrides) };

  registerPitCrew(bus, pitCrewDeps);

  return pitCrewDeps;
}

/** The overrides without their `undefined`-valued keys, so none can erase a built dependency. */
function definedOverrides(overrides: Partial<PitCrewDeps> | undefined): Partial<PitCrewDeps> {
  return Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<PitCrewDeps>;
}
