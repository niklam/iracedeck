/**
 * Startup application and one-shot migration for the per-feature startup
 * policies (issue #1007). The policy values and the pure resolver live in
 * `feature-startup-policy.ts`; this module is the half that reads and writes
 * global settings, so it can import both without the schema forming a cycle.
 *
 * Both functions are called once per plugin start, from the first-arrival
 * block that is already gated on `isSettingsStoreReady()` — before the store
 * has loaded, the cache is pure schema defaults with no passthrough keys, so
 * the absence of a retired key would prove nothing and the "remembered" gate
 * value would be a default rather than the previous session's.
 */
import type { ILogger } from "@iracedeck/logger";

import {
  DEFAULT_FEATURE_STARTUP_POLICY,
  FEATURE_STARTUP_GATES,
  FEATURE_STARTUP_POLICIES,
  type FeatureStartupPolicy,
  resolveStartupGate,
} from "./feature-startup-policy.js";
import { deleteGlobalSettings, getGlobalSettings, updateGlobalSettings } from "./global-settings.js";

/** Read a policy from the live cache, falling back to the default. */
function readPolicy(settings: Record<string, unknown>, key: string): FeatureStartupPolicy {
  const raw = settings[key];

  return FEATURE_STARTUP_POLICIES.includes(raw as FeatureStartupPolicy)
    ? (raw as FeatureStartupPolicy)
    : DEFAULT_FEATURE_STARTUP_POLICY;
}

/**
 * Seed every feature's live master gate from its startup policy.
 *
 * Writes only what actually changes, so `remember-last` (the default) is a
 * pure no-op and cannot churn the settings store on every start.
 */
export function applyStartupFeatureGates(logger?: ILogger): void {
  const settings = getGlobalSettings() as unknown as Record<string, unknown>;
  const writes: Record<string, unknown> = {};

  for (const gate of FEATURE_STARTUP_GATES) {
    const policy = readPolicy(settings, gate.policyKey);
    const remembered = settings[gate.gateKey] === true;
    const next = resolveStartupGate(policy, remembered);

    if (next !== remembered) {
      writes[gate.gateKey] = next;
      logger?.debug(`${gate.label} startup policy ${policy} set the gate to ${String(next)}`);
    }
  }

  if (Object.keys(writes).length === 0) return;

  logger?.info("Startup feature gates applied");
  updateGlobalSettings(writes);
}

/**
 * One-shot: map each retired `…EnabledOnStartup` boolean onto its startup
 * policy, then delete it.
 *
 * `true` → `always-on`, `false` → `always-off`. Both map to the behaviour that
 * key already produced, so an upgrade never changes what a user gets; only a
 * fresh install (nothing stored) keeps the `remember-last` default.
 *
 * Idempotent by absence — once the retired key is gone there is nothing to
 * migrate, so a later user choice can never be clobbered and no marker key is
 * needed. The retired keys are deliberately NOT in `GlobalSettingsSchema`
 * anymore: while a key is schema-backed the parsed cache always holds at
 * least its default, so a stored `false` would be indistinguishable from a
 * defaulted one and `deleteGlobalSettings` could not remove it.
 */
export function migrateStartupPolicies(logger?: ILogger): void {
  const settings = getGlobalSettings() as unknown as Record<string, unknown>;
  const writes: Record<string, unknown> = {};
  const deletes: string[] = [];

  for (const gate of FEATURE_STARTUP_GATES) {
    const legacy = settings[gate.legacyKey];

    if (legacy === undefined) continue;

    // The Property Inspector persisted checkbox values as booleans OR as the
    // strings "true"/"false" — the retired schema field coerced both.
    const policy: FeatureStartupPolicy = legacy === true || legacy === "true" ? "always-on" : "always-off";

    writes[gate.policyKey] = policy;
    deletes.push(gate.legacyKey);
    logger?.debug(`${gate.label} on-startup ${String(legacy)} migrated to ${policy}`);
  }

  if (deletes.length === 0) return;

  logger?.info("Startup policies migrated");
  updateGlobalSettings(writes);
  deleteGlobalSettings(deletes);
}
