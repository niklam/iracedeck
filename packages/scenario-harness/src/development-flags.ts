/**
 * The development flags the scenario harness runs with (#1113). The harness is
 * development tooling that auditions every callout a development build can
 * speak, so a feature a release build keeps behind a platform feature flag
 * (`platform-features.json`, `.claude/rules/platform-feature-flags.md`) is on
 * here: its buttons fire, and the translator and the Race Engineer run it.
 *
 * - `trafficRejoin` — the rejoin traffic warnings (the #1113 spec's fourth
 *   amendment): off in every plugin's committed flags, on here, so the Traffic
 *   panel's rejoin buttons and the rejoin telemetry are heard. `main.ts` hands
 *   it to the translator, `wireHarnessRaceEngineer` to the wiring.
 */
export const HARNESS_DEVELOPMENT_FLAGS = Object.freeze({ trafficRejoin: true });
