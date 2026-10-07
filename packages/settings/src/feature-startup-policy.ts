/**
 * Per-feature startup policy for the Race Engineer / Radar master gates
 * (issue #1007).
 *
 * The live gates (`pitCrewRaceEngineerEnabled` / `pitCrewRadarEnabled`) are
 * what every scenario, the radar engine and the Pit Crew icon read, and the
 * Pit Crew toggle keys plus the settings window's live checkboxes flip them.
 * This module answers the separate question of what those gates should hold
 * when the plugin *starts*, which used to be conflated with the live value by
 * the `…EnabledOnStartup` booleans this replaces.
 *
 * PURE — this module must never import `global-settings.ts`. The schema
 * imports the policy values from here at module-init time to build its Zod
 * object, so a back-import would be a temporal-dead-zone cycle. The stateful
 * half (reading and writing settings) lives in `feature-startup-gates.ts`,
 * which is free to import both. Same shape as the `version-check.ts`
 * precedent for `changelogNotification`.
 */

/**
 * The `pitCrew*StartupPolicy` global-setting values. Defined here (not in
 * `global-settings.ts`) so the Zod schema and the resolution logic share one
 * source of truth.
 */
export const FEATURE_STARTUP_POLICIES = ["remember-last", "always-on", "always-off"] as const;

/** What a feature's master gate should hold when the plugin starts. */
export type FeatureStartupPolicy = (typeof FEATURE_STARTUP_POLICIES)[number];

/**
 * Default startup policy: carry the previous session's state over. A fresh
 * install still comes up silent, because both live gates default to `false`;
 * upgrades never see this default, since the migration in
 * `feature-startup-gates.ts` maps their stored `…EnabledOnStartup` boolean to
 * an explicit `always-on` / `always-off`.
 */
export const DEFAULT_FEATURE_STARTUP_POLICY: FeatureStartupPolicy = "remember-last";

/** One feature's live gate, its startup policy, and the key both replaced. */
export interface FeatureStartupGate {
  /** Live master gate every consumer reads. */
  readonly gateKey: string;
  /** Startup policy for that gate. */
  readonly policyKey: string;
  /** Retired pre-#1007 boolean, migrated then deleted. */
  readonly legacyKey: string;
  /** Human-readable feature name, for log lines. */
  readonly label: string;
}

/** Every feature with a startup policy. */
export const FEATURE_STARTUP_GATES: readonly FeatureStartupGate[] = [
  {
    gateKey: "pitCrewRaceEngineerEnabled",
    policyKey: "pitCrewRaceEngineerStartupPolicy",
    legacyKey: "pitCrewRaceEngineerEnabledOnStartup",
    label: "Race Engineer",
  },
  {
    gateKey: "pitCrewRadarEnabled",
    policyKey: "pitCrewRadarStartupPolicy",
    legacyKey: "pitCrewRadarEnabledOnStartup",
    label: "Radar",
  },
];

/**
 * The value a feature's master gate should take at startup.
 *
 * @param policy - The feature's startup policy.
 * @param remembered - The gate value carried over from the previous session.
 */
export function resolveStartupGate(policy: FeatureStartupPolicy, remembered: boolean): boolean {
  if (policy === "always-on") return true;

  if (policy === "always-off") return false;

  return remembered;
}
