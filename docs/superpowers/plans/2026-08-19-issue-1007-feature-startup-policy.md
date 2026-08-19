# Race Engineer / Radar live toggle + startup policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two `…EnabledOnStartup` checkboxes with a live master toggle plus a startup policy per feature, so the settings window stops silently overriding the Pit Crew toggle keys (issue #1007).

**Architecture:** Two new pure/stateful deck-core modules own the startup policy and its one-shot migration; a new `feature-gates.ts` in `@iracedeck/iracing-actions` owns the live gates and applies each gate change exactly once, whether it came from a deck key or from a settings-window checkbox. Each `plugin.ts` loses its mirror block and gains three ordered calls.

**Tech Stack:** TypeScript, Zod v4, Vitest, EJS Property Inspector templates, pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-08-19-issue-1007-feature-startup-policy-design.md`

## Global Constraints

- Worktree: `C:\Users\Niklas\Projects\iRaceDeck\ir-1007`, branch `ir-1007`, based on `origin/release/3.0`. **All paths below are relative to that worktree.** The shell's working directory resets to `master` between calls — always `cd` or use absolute paths.
- Target branch for the PR is `release/3.0`, never `master`.
- Exact dependency versions only; no new dependencies are needed.
- Every new `GlobalSettingsSchema` plain-value field MUST end in `.catch(<default>)` — one throwing field aborts the whole parse and makes every key binding look unset (#896).
- New policy values, verbatim: `"remember-last"`, `"always-on"`, `"always-off"`. Default: `"remember-last"`.
- Retired keys, verbatim: `pitCrewRaceEngineerEnabledOnStartup`, `pitCrewRadarEnabledOnStartup`.
- Live gate keys, unchanged: `pitCrewRaceEngineerEnabled`, `pitCrewRadarEnabled`.
- PI copy rule: the mode/label wording is fixed by the spec; supporting text uses the shared `ird-supporting-text` class, never an inline `style` attribute.
- Run a single test file from the repo root: `pnpm exec vitest run <path>` (`pnpm --filter @iracedeck/iracing-actions test` silently no-ops — that package has no test script).
- After any `GlobalSettingsSchema` change, verify with `pnpm build:force` (turbo caches `deck-core`).
- When verifying a build through a pipe, use `set -o pipefail` — `pnpm build | tail` returns tail's exit code.
- Commit messages end with the session trailer:
  `Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X`

---

## File Structure

**Create**
- `packages/deck-core/src/feature-startup-policy.ts` — pure: the policy values, default, per-feature key table, and `resolveStartupGate`. Imports nothing from `global-settings.ts` (the schema imports *it*, so a back-import would be a module-init cycle).
- `packages/deck-core/src/feature-startup-policy.test.ts`
- `packages/deck-core/src/feature-startup-gates.ts` — stateful: `applyStartupFeatureGates`, `migrateStartupPolicies`.
- `packages/deck-core/src/feature-startup-gates.test.ts`
- `packages/iracing-actions/src/audio/feature-gates.ts` — the two live master gates: `toggleRaceEngineerFeature`, `toggleRadarFeature`, `syncFeatureGates`, `armFeatureGateSync`, `_resetFeatureGateSync`.
- `packages/iracing-actions/src/audio/feature-gates.test.ts`

**Modify**
- `packages/deck-core/src/global-settings.ts` — swap the two retired boolean fields for the two policy fields.
- `packages/deck-core/src/index.ts` — export the new modules.
- `packages/deck-core/src/simhub-service.test.ts:56-57,255-256` — retired key literals.
- `packages/iracing-actions/src/audio/audio-toggles.ts` — remove the two toggle functions (the voice plumbing and corner-names toggle stay).
- `packages/iracing-actions/src/audio/audio-toggles.test.ts` — drop the two moved suites.
- `packages/iracing-actions/src/actions/pit-crew/pit-crew.ts:36-37` — import the toggles from their new home.
- `packages/iracing-actions/src/actions/audio-controls/audio-buses.ts:13` — same.
- `packages/iracing-actions/src/index.ts` — export the new gate API.
- `packages/iracing-plugin-stream-deck/src/plugin.ts`, `packages/iracing-plugin-mirabox/src/plugin.ts`, `packages/iracing-plugin-ulanzi/src/plugin.ts` — identical edits in all three.
- `packages/pi-components/partials/race-engineer-settings.ejs` — the new controls.
- `packages/pi-components/src/build/accordion-partial.test.ts:118-126` — pinned setting keys.
- `packages/website/src/content/docs/docs/features/settings-window.md`, `.../docs/actions/audio-voice/pit-crew.md`, `packages/website/src/content/docs/changelog.mdx`.

---

### Task 1: Pure startup-policy module + schema swap

**Files:**
- Create: `packages/deck-core/src/feature-startup-policy.ts`
- Test: `packages/deck-core/src/feature-startup-policy.test.ts`
- Modify: `packages/deck-core/src/global-settings.ts` (the block currently at lines 224–243)
- Modify: `packages/deck-core/src/index.ts`
- Modify: `packages/deck-core/src/simhub-service.test.ts` (lines 56–57 and 255–256)

**Interfaces:**
- Consumes: nothing.
- Produces: `FEATURE_STARTUP_POLICIES`, `type FeatureStartupPolicy`, `DEFAULT_FEATURE_STARTUP_POLICY`, `FEATURE_STARTUP_GATES: readonly FeatureStartupGate[]` where `FeatureStartupGate = { readonly gateKey: string; readonly policyKey: string; readonly legacyKey: string; readonly label: string }`, and `resolveStartupGate(policy: FeatureStartupPolicy, remembered: boolean): boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/deck-core/src/feature-startup-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEATURE_STARTUP_POLICY,
  FEATURE_STARTUP_GATES,
  FEATURE_STARTUP_POLICIES,
  resolveStartupGate,
} from "./feature-startup-policy.js";

describe("FEATURE_STARTUP_POLICIES", () => {
  it("lists the three policies and defaults to remember-last", () => {
    expect(FEATURE_STARTUP_POLICIES).toEqual(["remember-last", "always-on", "always-off"]);
    expect(DEFAULT_FEATURE_STARTUP_POLICY).toBe("remember-last");
  });
});

describe("resolveStartupGate", () => {
  it("carries the remembered value over under remember-last", () => {
    expect(resolveStartupGate("remember-last", true)).toBe(true);
    expect(resolveStartupGate("remember-last", false)).toBe(false);
  });

  it("forces the gate on under always-on regardless of the remembered value", () => {
    expect(resolveStartupGate("always-on", false)).toBe(true);
    expect(resolveStartupGate("always-on", true)).toBe(true);
  });

  it("forces the gate off under always-off regardless of the remembered value", () => {
    expect(resolveStartupGate("always-off", true)).toBe(false);
    expect(resolveStartupGate("always-off", false)).toBe(false);
  });
});

describe("FEATURE_STARTUP_GATES", () => {
  it("maps each feature's live gate, policy and retired key", () => {
    expect(FEATURE_STARTUP_GATES).toEqual([
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
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/deck-core/src/feature-startup-policy.test.ts
```

Expected: FAIL — `Failed to resolve import "./feature-startup-policy.js"`.

- [ ] **Step 3: Write the module**

Create `packages/deck-core/src/feature-startup-policy.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/deck-core/src/feature-startup-policy.test.ts
```

Expected: PASS (3 suites, 5 tests).

- [ ] **Step 5: Swap the schema fields**

In `packages/deck-core/src/global-settings.ts`, add to the import block near line 37 (keep imports alphabetically grouped as the file already does):

```ts
import { DEFAULT_FEATURE_STARTUP_POLICY, FEATURE_STARTUP_POLICIES } from "./feature-startup-policy.js";
```

Replace the whole retired block (the doc comment plus both fields, currently lines 224–243) with:

```ts
    /**
     * Startup policy for `pitCrewRaceEngineerEnabled` / `pitCrewRadarEnabled`
     * (issue #1007, replacing the `…EnabledOnStartup` booleans of #482).
     * `remember-last` carries the previous session's gate over, `always-on` /
     * `always-off` force it. Only the plugin's first-arrival block reads
     * these — editing one mid-session deliberately does NOT touch the live
     * gate, which is what the old booleans got wrong: they were labelled "On
     * startup" but silently overrode the Pit Crew toggle key.
     *
     * `.catch(...)` so a malformed persisted value falls back to the default
     * instead of throwing and aborting the entire GlobalSettingsSchema.parse
     * — which would stall every setting, not just this one (the
     * `spotterStillThereSeconds` / `changelogNotification` precedent).
     */
    pitCrewRaceEngineerStartupPolicy: z
      .enum(FEATURE_STARTUP_POLICIES)
      .default(DEFAULT_FEATURE_STARTUP_POLICY)
      .catch(DEFAULT_FEATURE_STARTUP_POLICY),
    pitCrewRadarStartupPolicy: z
      .enum(FEATURE_STARTUP_POLICIES)
      .default(DEFAULT_FEATURE_STARTUP_POLICY)
      .catch(DEFAULT_FEATURE_STARTUP_POLICY),
```

- [ ] **Step 6: Export from the package index**

In `packages/deck-core/src/index.ts`, directly after the `export { migrateGlobalSettingsKeys } from "./global-settings-migrations.js";` line (currently line 173), add:

```ts
// Per-feature startup policy for the Race Engineer / Radar gates (issue #1007)
export {
  DEFAULT_FEATURE_STARTUP_POLICY,
  FEATURE_STARTUP_GATES,
  FEATURE_STARTUP_POLICIES,
  resolveStartupGate,
  type FeatureStartupGate,
  type FeatureStartupPolicy,
} from "./feature-startup-policy.js";
```

- [ ] **Step 7: Update the settings-shape test literals**

In `packages/deck-core/src/simhub-service.test.ts`, at both places (lines 56–57 and 255–256) replace:

```ts
      pitCrewRaceEngineerEnabledOnStartup: false,
      pitCrewRadarEnabledOnStartup: false,
```

with:

```ts
      pitCrewRaceEngineerStartupPolicy: "remember-last",
      pitCrewRadarStartupPolicy: "remember-last",
```

Keep each site's existing indentation (the second site is nested one level deeper).

- [ ] **Step 8: Run the deck-core suite**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/deck-core/src
```

Expected: PASS. If `global-settings.test.ts` or `simhub-service.test.ts` reports an unexpected key, it is asserting on the full settings shape — update that literal the same way.

- [ ] **Step 9: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add packages/deck-core/src && git -c core.longpaths=true commit -m "feat(settings): add the Race Engineer/Radar startup policy setting (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

---

### Task 2: Startup application + one-shot migration

**Files:**
- Create: `packages/deck-core/src/feature-startup-gates.ts`
- Test: `packages/deck-core/src/feature-startup-gates.test.ts`
- Modify: `packages/deck-core/src/index.ts`

**Interfaces:**
- Consumes: `FEATURE_STARTUP_GATES`, `resolveStartupGate`, `DEFAULT_FEATURE_STARTUP_POLICY`, `FEATURE_STARTUP_POLICIES`, `type FeatureStartupPolicy` (Task 1); `getGlobalSettings`, `updateGlobalSettings`, `deleteGlobalSettings` from `./global-settings.js`.
- Produces: `applyStartupFeatureGates(logger?: ILogger): void` and `migrateStartupPolicies(logger?: ILogger): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/deck-core/src/feature-startup-gates.test.ts`. The harness mirrors `global-settings-migrations.test.ts` (same worktree, read it if the store helpers drift):

```ts
import type { ILogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyStartupFeatureGates, migrateStartupPolicies } from "./feature-startup-gates.js";
import { _resetGlobalSettings, getGlobalSettings, initGlobalSettings } from "./global-settings.js";
import { createMemorySettingsStore } from "./settings-store.js";
import type { IDeckPlatformAdapter } from "./types.js";

function createMockLogger(): ILogger {
  return { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ILogger;
}

function createMockAdapter(): IDeckPlatformAdapter {
  return {
    onDidReceiveGlobalSettings: (_cb: (settings: unknown) => void) => {},
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(),
  } as unknown as IDeckPlatformAdapter;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function initWithStore(initial: Record<string, unknown> = {}) {
  const store = createMemorySettingsStore(initial);

  initGlobalSettings(createMockAdapter(), createMockLogger(), store);

  return store;
}

const cache = (): Record<string, unknown> => getGlobalSettings() as Record<string, unknown>;

describe("applyStartupFeatureGates", () => {
  beforeEach(() => _resetGlobalSettings());
  afterEach(() => _resetGlobalSettings());

  it("leaves the remembered gates untouched under remember-last", async () => {
    const store = initWithStore({
      pitCrewRaceEngineerEnabled: true,
      pitCrewRadarEnabled: false,
      pitCrewRaceEngineerStartupPolicy: "remember-last",
      pitCrewRadarStartupPolicy: "remember-last",
    });
    await tick();
    const savesBefore = store.saved.length;

    applyStartupFeatureGates(createMockLogger());

    expect(cache().pitCrewRaceEngineerEnabled).toBe(true);
    expect(cache().pitCrewRadarEnabled).toBe(false);
    expect(store.saved).toHaveLength(savesBefore);
  });

  it("forces the gate on under always-on", async () => {
    initWithStore({
      pitCrewRaceEngineerEnabled: false,
      pitCrewRaceEngineerStartupPolicy: "always-on",
    });
    await tick();

    applyStartupFeatureGates(createMockLogger());

    expect(cache().pitCrewRaceEngineerEnabled).toBe(true);
  });

  it("forces the gate off under always-off", async () => {
    initWithStore({
      pitCrewRadarEnabled: true,
      pitCrewRadarStartupPolicy: "always-off",
    });
    await tick();

    applyStartupFeatureGates(createMockLogger());

    expect(cache().pitCrewRadarEnabled).toBe(false);
  });
});

describe("migrateStartupPolicies", () => {
  beforeEach(() => _resetGlobalSettings());
  afterEach(() => _resetGlobalSettings());

  it("maps a stored true to always-on and deletes the retired key", async () => {
    initWithStore({ pitCrewRaceEngineerEnabledOnStartup: true });
    await tick();

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("always-on");
    expect(cache().pitCrewRaceEngineerEnabledOnStartup).toBeUndefined();
  });

  it("maps a stored false to always-off and deletes the retired key", async () => {
    initWithStore({ pitCrewRadarEnabledOnStartup: false });
    await tick();

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRadarStartupPolicy).toBe("always-off");
    expect(cache().pitCrewRadarEnabledOnStartup).toBeUndefined();
  });

  it("accepts the string form the Property Inspector used to persist", async () => {
    initWithStore({ pitCrewRaceEngineerEnabledOnStartup: "true" });
    await tick();

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("always-on");
  });

  it("writes nothing when no retired key is stored", async () => {
    const store = initWithStore({ someOtherKey: "value" });
    await tick();
    const savesBefore = store.saved.length;

    migrateStartupPolicies(createMockLogger());

    expect(store.saved).toHaveLength(savesBefore);
    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("remember-last");
  });

  it("is idempotent — a second run cannot clobber a later user choice", async () => {
    initWithStore({ pitCrewRaceEngineerEnabledOnStartup: true });
    await tick();

    migrateStartupPolicies(createMockLogger());
    // The user then picks something else.
    const { updateGlobalSettings } = await import("./global-settings.js");
    updateGlobalSettings({ pitCrewRaceEngineerStartupPolicy: "remember-last" });

    migrateStartupPolicies(createMockLogger());

    expect(cache().pitCrewRaceEngineerStartupPolicy).toBe("remember-last");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/deck-core/src/feature-startup-gates.test.ts
```

Expected: FAIL — `Failed to resolve import "./feature-startup-gates.js"`.

- [ ] **Step 3: Write the module**

Create `packages/deck-core/src/feature-startup-gates.ts`:

```ts
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
  resolveStartupGate,
  type FeatureStartupPolicy,
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
      logger?.debug(`${gate.label} startup policy ${policy} set the gate to ${next}`);
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/deck-core/src/feature-startup-gates.test.ts
```

Expected: PASS (2 suites, 8 tests).

- [ ] **Step 5: Export from the package index**

In `packages/deck-core/src/index.ts`, directly below the `feature-startup-policy.js` export added in Task 1:

```ts
export { applyStartupFeatureGates, migrateStartupPolicies } from "./feature-startup-gates.js";
```

- [ ] **Step 6: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add packages/deck-core/src && git -c core.longpaths=true commit -m "feat(settings): apply and migrate the Race Engineer/Radar startup policies (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

---

### Task 3: Live feature-gate module

**Files:**
- Create: `packages/iracing-actions/src/audio/feature-gates.ts`
- Test: `packages/iracing-actions/src/audio/feature-gates.test.ts`
- Modify: `packages/iracing-actions/src/audio/audio-toggles.ts` (remove lines 156–210, the two toggle functions)
- Modify: `packages/iracing-actions/src/audio/audio-toggles.test.ts` (remove the two moved suites and their now-unused imports)
- Modify: `packages/iracing-actions/src/actions/pit-crew/pit-crew.ts` (import block at lines 30–40)
- Modify: `packages/iracing-actions/src/actions/audio-controls/audio-buses.ts:13`
- Modify: `packages/iracing-actions/src/index.ts`

**Interfaces:**
- Consumes: from `./audio-toggles.js` — `isToggleAckEnabled`, `playToggleAck`; from `./audio-volume.js` — `applyRaceEngineerAudio`, `isRaceEngineerEnabled`, `isRadarEnabled`; from `@iracedeck/audio-scenarios/pit-crew` — `setRadarEnabled`, `stopRaceEngineerScenarios`; from `@iracedeck/deck-core` — `updateGlobalSettings`.
- Produces: `toggleRaceEngineerFeature(logger: ILogger): boolean`, `toggleRadarFeature(logger: ILogger): boolean`, `syncFeatureGates(logger: ILogger): void`, `armFeatureGateSync(): void`, `_resetFeatureGateSync(): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/iracing-actions/src/audio/feature-gates.test.ts`. The mock block is lifted from `audio-toggles.test.ts` in the same directory — read that file first so the two stay consistent:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetFeatureGateSync,
  armFeatureGateSync,
  syncFeatureGates,
  toggleRaceEngineerFeature,
  toggleRadarFeature,
} from "./feature-gates.js";

const hoisted = vi.hoisted(() => {
  const setBusVolume = vi.fn();
  const playOnChannel = vi.fn<(...args: unknown[]) => boolean>().mockReturnValue(true);
  const onChannelComplete = vi.fn();
  const getAudio = vi.fn(() => ({ setBusVolume, playOnChannel, onChannelComplete }));

  const setRadarEnabled = vi.fn();
  const stopRaceEngineerScenarios = vi.fn();
  const isBackgroundTestInFlight = vi.fn(() => false);

  let globalSettings: Record<string, unknown> = {};
  const updateGlobalSettings = vi.fn((partial: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...partial };
  });
  const getGlobalSettings = vi.fn(() => globalSettings);
  const resolveActiveRaceEngineerVoice = vi.fn(() => "default");

  return {
    setBusVolume,
    playOnChannel,
    onChannelComplete,
    getAudio,
    setRadarEnabled,
    stopRaceEngineerScenarios,
    isBackgroundTestInFlight,
    updateGlobalSettings,
    getGlobalSettings,
    resolveActiveRaceEngineerVoice,
    setGlobalSettings: (next: Record<string, unknown>) => {
      globalSettings = next;
    },
  };
});

vi.mock("@iracedeck/audio-scenarios/pit-crew", () => ({
  isBackgroundTestInFlight: hoisted.isBackgroundTestInFlight,
  setRadarEnabled: hoisted.setRadarEnabled,
  stopRaceEngineerScenarios: hoisted.stopRaceEngineerScenarios,
}));

vi.mock("@iracedeck/audio-service", () => ({
  AudioBus: { Voice: 0, Background: 1, Alerts: 2 },
  AudioChannel: { Voice: 0 },
  getAudio: hoisted.getAudio,
}));

vi.mock("@iracedeck/deck-core", () => ({
  getGlobalSettings: hoisted.getGlobalSettings,
  updateGlobalSettings: hoisted.updateGlobalSettings,
  resolveActiveRaceEngineerVoice: hoisted.resolveActiveRaceEngineerVoice,
}));

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** The Voice channel id from the AudioChannel mock above. */
const VOICE = 0;

describe("feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]' });
    _resetFeatureGateSync();
  });

  describe("toggleRaceEngineerFeature", () => {
    it("turns the gate on, persists it and plays the resuming acknowledgment", () => {
      expect(toggleRaceEngineerFeature(logger)).toBe(true);

      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/resuming-01.mp3");
    });

    it("stops in-flight scenarios and plays going-silent when turning off", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]', pitCrewRaceEngineerEnabled: true });

      expect(toggleRaceEngineerFeature(logger)).toBe(false);

      expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(1);
      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/going-silent-01.mp3");
    });

    it("skips the acknowledgment when the per-callout opt-in is off", () => {
      hoisted.setGlobalSettings({
        _raceEngineerVoices: '["default"]',
        calloutEnabledToggleRaceEngineer: false,
      });

      toggleRaceEngineerFeature(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("does not double-apply when an armed listener already handled the write", () => {
      armFeatureGateSync();
      // Reproduce the plugin wiring: updateGlobalSettings fires
      // onGlobalSettingsChange synchronously, which calls syncFeatureGates.
      // `Once`, not `mockImplementation` — vi.clearAllMocks() does not restore
      // an overridden implementation, so it would leak into the next test.
      hoisted.updateGlobalSettings.mockImplementationOnce((partial: Record<string, unknown>) => {
        hoisted.setGlobalSettings({ ...hoisted.getGlobalSettings(), ...partial });
        syncFeatureGates(logger);
      });

      toggleRaceEngineerFeature(logger);

      expect(hoisted.playOnChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe("toggleRadarFeature", () => {
    it("turns the radar engine on and persists the gate", () => {
      expect(toggleRadarFeature(logger)).toBe(true);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
      expect(hoisted.updateGlobalSettings).toHaveBeenCalledWith({ pitCrewRadarEnabled: true });
    });

    it("turns the radar engine off again", () => {
      hoisted.setGlobalSettings({ pitCrewRadarEnabled: true });

      expect(toggleRadarFeature(logger)).toBe(false);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe("syncFeatureGates", () => {
    it("applies nothing while dormant, so the startup write is silent", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]', pitCrewRaceEngineerEnabled: true });

      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });

    it("seeds silently when armed", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]', pitCrewRaceEngineerEnabled: true });

      armFeatureGateSync();
      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
    });

    it("applies an externally written gate change (the settings window checkbox)", () => {
      armFeatureGateSync();
      hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]', pitCrewRaceEngineerEnabled: true });

      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).toHaveBeenCalledWith(VOICE, "voice/default/toggle/resuming-01.mp3");
    });

    it("stops scenarios when an external write turns the engineer off", () => {
      hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]', pitCrewRaceEngineerEnabled: true });
      armFeatureGateSync();
      hoisted.setGlobalSettings({ _raceEngineerVoices: '["default"]', pitCrewRaceEngineerEnabled: false });

      syncFeatureGates(logger);

      expect(hoisted.stopRaceEngineerScenarios).toHaveBeenCalledTimes(1);
    });

    it("applies an externally written radar change", () => {
      armFeatureGateSync();
      hoisted.setGlobalSettings({ pitCrewRadarEnabled: true });

      syncFeatureGates(logger);

      expect(hoisted.setRadarEnabled).toHaveBeenCalledWith(true);
    });

    it("applies nothing when the gates are unchanged", () => {
      armFeatureGateSync();

      syncFeatureGates(logger);
      syncFeatureGates(logger);

      expect(hoisted.playOnChannel).not.toHaveBeenCalled();
      expect(hoisted.setRadarEnabled).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/iracing-actions/src/audio/feature-gates.test.ts
```

Expected: FAIL — `Failed to resolve import "./feature-gates.js"`.

- [ ] **Step 3: Write the module**

Create `packages/iracing-actions/src/audio/feature-gates.ts`:

```ts
/**
 * The Race Engineer / Radar live master gates (issue #1007).
 *
 * `pitCrewRaceEngineerEnabled` and `pitCrewRadarEnabled` are the runtime flags
 * every scenario, the radar engine and the Pit Crew icon read. Three things
 * write them: the Pit Crew toggle keys, the Audio Controls dial's Mute/Unmute,
 * and the settings window's live checkboxes. This module makes all three
 * behave identically by owning the side effects of a gate *change* — stopping
 * in-flight scenarios, driving the radar engine, and the spoken
 * acknowledgment — instead of leaving them in the key's own code path, where a
 * settings-window write produced a half-toggle: buses muted (the plugin's
 * `applyAudioState` listener) but the in-flight scenario and its looping
 * ambient bed left running, exactly the bug #587 fixed.
 *
 * Exactly-once is a per-gate applied-value tracker, not a listener contract:
 * `updateGlobalSettings` fires listeners synchronously, so when a plugin is
 * armed the listener has already applied the edge by the time the toggle
 * helper calls its applier, and the second call short-circuits. When nothing
 * is armed — a press before the first settings arrival, or a unit test whose
 * mocked `updateGlobalSettings` fires no listeners — the direct call does the
 * work. A key press therefore never depends on a listener registered in
 * another file.
 *
 * The voice plumbing the acknowledgment rides on (`playToggleAck`,
 * `playVoiceSequence`) stays in `audio-toggles.ts`; the dependency runs one
 * way, so there is no cycle.
 */
import { setRadarEnabled, stopRaceEngineerScenarios } from "@iracedeck/audio-scenarios/pit-crew";
import { updateGlobalSettings } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

import { isToggleAckEnabled, playToggleAck } from "./audio-toggles.js";
import { applyRaceEngineerAudio, isRaceEngineerEnabled, isRadarEnabled } from "./audio-volume.js";

/**
 * The gate values whose side effects have already been applied. `null` means
 * "not applied yet", so the first application always runs — which is what lets
 * a toggle work before {@link armFeatureGateSync} has ever been called.
 */
let appliedRaceEngineerGate: boolean | null = null;
let appliedRadarGate: boolean | null = null;

/**
 * Whether {@link syncFeatureGates} reacts to changes. Dormant until
 * {@link armFeatureGateSync}, so the startup application of the per-feature
 * startup policies can never be mistaken for a user toggle and play an
 * acknowledgment at plugin start.
 */
let armed = false;

/**
 * Apply the side effects of the Race Engineer gate landing on `next`.
 * A no-op when those effects have already been applied for that value.
 */
function applyRaceEngineerGate(next: boolean, logger: ILogger): void {
  if (appliedRaceEngineerGate === next) return;

  appliedRaceEngineerGate = next;

  // Apply the gate to Voice + Background synchronously so an in-flight
  // engineer clip is silenced on the same tick the user pressed the key.
  // The acknowledgment (issue #554) layers on top via
  // `raceEngineerToggleInFlight` — when set, `applyRaceEngineerAudio` leaves
  // Voice audible so the "going silent" / "resuming" line plays through,
  // while Background and every other Voice consumer mute immediately.
  applyRaceEngineerAudio();

  // Turning off mid-callout must stop the in-flight scenario (and its looping
  // ambient bed) and free the scenario bus. `applyRaceEngineerAudio` only
  // mutes the buses — without this the ambient is orphaned (audible again on
  // re-enable) and the stuck `playingId` drops every later callout as "bus
  // busy". The going-silent acknowledgment below plays directly on Voice, not
  // through the engine, so it is unaffected by the cancel (issue #587).
  if (!next) {
    stopRaceEngineerScenarios();
  }

  if (isToggleAckEnabled()) {
    playToggleAck(next ? "resuming-01" : "going-silent-01", logger);
  }
}

/**
 * Apply the side effects of the Radar gate landing on `next`. Pushes the gate
 * into the radar engine so the tick loop stops/starts immediately; the radar
 * has no spoken acknowledgment.
 */
function applyRadarGate(next: boolean): void {
  if (appliedRadarGate === next) return;

  appliedRadarGate = next;
  setRadarEnabled(next);
}

/**
 * Flip the Race Engineer master gate — the shared pathway behind the Pit Crew
 * toggle key and the Audio Controls dial's Mute/Unmute. Returns the NEW state.
 */
export function toggleRaceEngineerFeature(logger: ILogger): boolean {
  const next = !isRaceEngineerEnabled();
  logger.info(`Race Engineer ${next ? "enabled" : "disabled"}`);

  updateGlobalSettings({ pitCrewRaceEngineerEnabled: next });
  applyRaceEngineerGate(next, logger);

  return next;
}

/** Flip the Radar master gate. Returns the NEW state. */
export function toggleRadarFeature(logger: ILogger): boolean {
  const next = !isRadarEnabled();
  logger.info(`Radar ${next ? "enabled" : "disabled"}`);

  updateGlobalSettings({ pitCrewRadarEnabled: next });
  applyRadarGate(next);

  return next;
}

/**
 * Apply whatever the live gates now hold. Registered once per plugin on
 * `onGlobalSettingsChange`, so a gate written by anything other than the
 * toggle helpers — the settings window's live checkboxes — gets the same side
 * effects a key press produces.
 */
export function syncFeatureGates(logger: ILogger): void {
  if (!armed) return;

  applyRaceEngineerGate(isRaceEngineerEnabled(), logger);
  applyRadarGate(isRadarEnabled());
}

/**
 * Start reacting to gate changes, seeding the trackers from the current
 * values so the seeding itself is silent.
 *
 * Called once per plugin, immediately after the startup policies have been
 * applied: that write fires the listener while still dormant, and arming then
 * records the post-write values as already applied.
 */
export function armFeatureGateSync(): void {
  appliedRaceEngineerGate = isRaceEngineerEnabled();
  appliedRadarGate = isRadarEnabled();
  armed = true;
}

/** @internal Reset the module state between tests. */
export function _resetFeatureGateSync(): void {
  appliedRaceEngineerGate = null;
  appliedRadarGate = null;
  armed = false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/iracing-actions/src/audio/feature-gates.test.ts
```

Expected: PASS (3 suites, 12 tests).

- [ ] **Step 5: Remove the moved functions from `audio-toggles.ts`**

Delete `toggleRaceEngineerFeature` (with its doc comment, currently lines 156–194) and `toggleRadarFeature` (lines 196–210) from `packages/iracing-actions/src/audio/audio-toggles.ts`.

Exactly two import edits follow from that. Delete line 10 entirely — it becomes fully unused:

```ts
import { setRadarEnabled, stopRaceEngineerScenarios } from "@iracedeck/audio-scenarios/pit-crew";
```

and drop `isRadarEnabled` (only) from the `./audio-volume.js` import block at lines 15–21. Keep `isRaceEngineerEnabled` — `toggleCornerNamesFeature` still calls it — along with `applyRaceEngineerAudio`, `readRaceEngineerVolume` and `setRaceEngineerToggleInFlight`, which `playToggleAck` uses.

Update the module doc comment's first paragraph: it currently describes the file as the shared Race Engineer / Radar feature-gate toggles. Say instead that the gates themselves moved to `feature-gates.ts` (#1007) and this module keeps the voice plumbing they depend on — the sequence player, the toggle acknowledgment, and the corner-names opt-in.

Also delete the two moved suites (`describe("toggleRaceEngineerFeature", …)` at line 105 and `describe("toggleRadarFeature", …)` at line 144) and their imports from `packages/iracing-actions/src/audio/audio-toggles.test.ts`, plus any mock entries left unreferenced.

- [ ] **Step 6: Repoint the two importers**

`packages/iracing-actions/src/actions/pit-crew/pit-crew.ts` — remove `toggleRaceEngineerFeature` and `toggleRadarFeature` from the `../../audio/audio-toggles.js` import and add:

```ts
import { toggleRaceEngineerFeature, toggleRadarFeature } from "../../audio/feature-gates.js";
```

`packages/iracing-actions/src/actions/audio-controls/audio-buses.ts:13` — replace the import with:

```ts
import { toggleRaceEngineerFeature, toggleRadarFeature } from "../../audio/feature-gates.js";
```

- [ ] **Step 7: Export the gate API from the package index**

In `packages/iracing-actions/src/index.ts`, next to the existing `audio/audio-previews.js` export block:

```ts
// Live Race Engineer / Radar master gates (#1007): plugins arm the sync once
// the startup policies have been applied, then feed it global-settings changes.
export {
  armFeatureGateSync,
  syncFeatureGates,
  toggleRaceEngineerFeature,
  toggleRadarFeature,
} from "./audio/feature-gates.js";
```

- [ ] **Step 8: Run the affected suites**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/iracing-actions/src
```

Expected: PASS. `pit-crew.test.ts` must pass **unchanged** — that is the proof the direct-apply path preserved the key's behaviour. If it fails, do not edit the test: the applier is wrong.

- [ ] **Step 9: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add packages/iracing-actions/src && git -c core.longpaths=true commit -m "refactor(audio): give the Race Engineer/Radar gates one owner for their side effects (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

---

### Task 4: Plugin wiring (all three plugins)

**Files:**
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts` (lines 350–356, 729–730, 951–954, 990–1019)
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts` (lines 348–354, 692–693, 910–913, 949–978)
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts` (lines 350–356, 694–695, 913–916, 952–981)

**Interfaces:**
- Consumes: `applyStartupFeatureGates`, `migrateStartupPolicies` from `@iracedeck/deck-core` (Task 2); `armFeatureGateSync`, `syncFeatureGates` from `@iracedeck/iracing-actions` (Task 3).
- Produces: nothing.

The three files carry byte-identical versions of every block below. Apply the same four edits to each; the line numbers differ per file, so anchor on the quoted text.

- [ ] **Step 1: Add the imports**

Add `applyStartupFeatureGates` and `migrateStartupPolicies` to the existing `@iracedeck/deck-core` import block (alphabetical order — `applyStartupFeatureGates` goes near `applyRaceEngineerAudio`'s neighbours, `migrateStartupPolicies` after `initWindowFocus`). Add `armFeatureGateSync` and `syncFeatureGates` to the existing `@iracedeck/iracing-actions` import block.

- [ ] **Step 2: Register the gate sync**

Find the audio-state syncer (search for `onGlobalSettingsChange(applyAudioState);`) and add directly beneath it:

```ts
// Live Race Engineer / Radar gate changes (#1007). `applyAudioState` above
// re-applies the bus volumes on every settings arrival; this listener adds the
// side effects only a gate CHANGE should have — stopping in-flight scenarios
// and the spoken acknowledgment — so the settings window's live checkboxes
// behave exactly like a Pit Crew toggle key. Dormant until
// `armFeatureGateSync()` runs in the first-arrival block below, so applying
// the startup policies is silent.
onGlobalSettingsChange(() => syncFeatureGates(featureGateLogger));
```

Immediately above the `const applyAudioState = (): void => {` declaration, add:

```ts
const featureGateLogger = adapter.createLogger("FeatureGates");
```

- [ ] **Step 3: Delete the trackers**

Delete these two lines and the comment above them (search for `lastSeenPitCrewRaceEngineerEnabledOnStartup`):

```ts
// Previous-value trackers for the "On startup" PI checkboxes. Null until
// the first global-settings arrival; on subsequent arrivals a value
// change drives an immediate runtime-key sync (issue #482). Renamed
// from `lastSeenRaceEngineerEnabledOnStartup` /
// `lastSeenRadarEnabledOnStartup` for issue #515.
let lastSeenPitCrewRaceEngineerEnabledOnStartup: boolean | null = null;
let lastSeenPitCrewRadarEnabledOnStartup: boolean | null = null;
```

- [ ] **Step 4: Replace the startup write**

Replace:

```ts
    updateGlobalSettings({
      pitCrewRaceEngineerEnabled: settings.pitCrewRaceEngineerEnabledOnStartup,
      pitCrewRadarEnabled: settings.pitCrewRadarEnabledOnStartup,
    });
```

with:

```ts
    // Issue #1007: the retired `…EnabledOnStartup` booleans become startup
    // policies. Migrate first so the policies below are the user's real
    // choice, apply them to the live gates, then arm the gate sync — in that
    // order, because arming records the post-write values as already applied
    // and a startup write must never sound like a user toggle.
    migrateStartupPolicies(logger);
    applyStartupFeatureGates(logger);
    armFeatureGateSync();
```

`plugin.ts` has no plugin-wide `logger` variable in scope here, so pass the `featureGateLogger` created in Step 2 — it is declared at module scope, well above this block.

- [ ] **Step 5: Delete the mirror block**

Delete the whole block from the comment `// Mirror "On startup" PI edits into the runtime toggles immediately so` through the closing brace of the second `if` statement (the one writing `pitCrewRadarEnabled`) — everything up to but excluding `pushRaceEngineerVoicesIfChanged();`.

- [ ] **Step 6: Verify the three plugins compile**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && set -o pipefail && pnpm build:force 2>&1 | tail -30
```

Expected: exit 0, all packages built. A `pitCrewRaceEngineerEnabledOnStartup does not exist` error means a plugin still references a retired key — fix it rather than re-adding the field.

- [ ] **Step 7: Confirm no retired references remain**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && grep -rn "EnabledOnStartup" --include=*.ts --include=*.ejs packages | grep -v node_modules | grep -v dist
```

Expected: only `packages/deck-core/src/feature-startup-policy.ts` (the `legacyKey` entries), `feature-startup-gates.ts`/`.test.ts` (the migration), and the Task 1 policy test.

- [ ] **Step 8: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add packages/iracing-plugin-stream-deck/src packages/iracing-plugin-mirabox/src packages/iracing-plugin-ulanzi/src && git -c core.longpaths=true commit -m "fix(settings): stop the On startup checkboxes overriding the Pit Crew toggle key (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

---

### Task 5: Settings-window controls

**Files:**
- Modify: `packages/pi-components/partials/race-engineer-settings.ejs` (the `On startup` item, lines 10–15)
- Modify: `packages/pi-components/src/build/accordion-partial.test.ts` (lines 118–126)

**Interfaces:**
- Consumes: the setting keys from Tasks 1–3.
- Produces: nothing.

- [ ] **Step 1: Update the failing partial test first**

In `packages/pi-components/src/build/accordion-partial.test.ts`, rename the test and swap the pinned keys:

```ts
  it("race-engineer-settings emits the live toggles, startup policies, voice, name, device and volumes", () => {
    const html = render("<%- include('race-engineer-settings') %>", withRequire);

    for (const key of [
      "pitCrewRaceEngineerEnabled",
      "pitCrewRaceEngineerStartupPolicy",
      "pitCrewRadarEnabled",
      "pitCrewRadarStartupPolicy",
      "raceEngineerVoice",
      "driverName",
      "audioOutputDevice",
    ]) {
      expect(html, key).toContain(`setting="${key}"`);
    }
    expect(html).not.toContain("<details");
  });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/pi-components/src/build/accordion-partial.test.ts
```

Expected: FAIL — the rendered HTML has no `setting="pitCrewRaceEngineerStartupPolicy"`.

- [ ] **Step 3: Rewrite the controls**

In `packages/pi-components/partials/race-engineer-settings.ejs`, replace the single `On startup` item (the first five concatenated lines of the emitted string) with:

```ejs
'<sdpi-item label="Race Engineer">' +
  	'<sdpi-checkbox setting="pitCrewRaceEngineerEnabled" label="Enabled" global></sdpi-checkbox>' +
  '</sdpi-item>' +
  '<div class="ird-supporting-text">' +
  	'Turns the engineer on or off right now — the same as a Pit Crew Race Engineer Toggle key.' +
  '</div>' +
  '<sdpi-item label="On startup">' +
  	'<sdpi-select setting="pitCrewRaceEngineerStartupPolicy" default="remember-last" global>' +
  		'<option value="remember-last">Remember last used</option>' +
  		'<option value="always-on">Always on</option>' +
  		'<option value="always-off">Always off</option>' +
  	'</sdpi-select>' +
  '</sdpi-item>' +
  '<sdpi-item label="Radar">' +
  	'<sdpi-checkbox setting="pitCrewRadarEnabled" label="Enabled" global></sdpi-checkbox>' +
  '</sdpi-item>' +
  '<div class="ird-supporting-text">' +
  	'Turns the proximity ticks on or off right now — the same as a Pit Crew Radar Toggle key.' +
  '</div>' +
  '<sdpi-item label="On startup">' +
  	'<sdpi-select setting="pitCrewRadarStartupPolicy" default="remember-last" global>' +
  		'<option value="remember-last">Remember last used</option>' +
  		'<option value="always-on">Always on</option>' +
  		'<option value="always-off">Always off</option>' +
  	'</sdpi-select>' +
  '</sdpi-item>' +
```

Also update the partial's leading `<%# … %>` comment: it currently says "on-startup toggles" — make it "live master toggles + startup policies".

Note: `sdpi-checkbox` must NOT carry `default="false"` — the HTML attribute is a truthy string and renders checked. Omit `default` entirely for an unchecked box.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm exec vitest run packages/pi-components/src/build/accordion-partial.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add packages/pi-components && git -c core.longpaths=true commit -m "improve(settings): split the Race Engineer/Radar controls into live toggle and startup policy (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

---

### Task 6: Documentation and changelog

**Files:**
- Modify: `packages/website/src/content/docs/docs/features/settings-window.md`
- Modify: `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–5.
- Produces: nothing.

- [ ] **Step 1: Extend the settings-window feature page**

In `settings-window.md`, the `## What's Inside` list's **Race Engineer** bullet currently reads:

> - **Race Engineer** — voice, driver name, output device, volumes and their Test buttons, the radar, every per-callout opt-in, and the setup-warning patterns.

Leave the bullet, and add a new section after `## What's Inside` (before `## What Stays in the Property Inspector`):

```markdown
### Race Engineer and Radar: now versus on startup

The Race Engineer and the radar each have two separate controls, because they answer two different
questions.

**Enabled** is live. Ticking it turns the feature on or off there and then — the same thing a Pit
Crew **Race Engineer Toggle** or **Radar Toggle** key does, including the spoken "resuming" /
"going silent" acknowledgment. Press the key and the checkbox follows; tick the checkbox and the
key's icon follows.

**On startup** decides what the feature comes up as the next time the plugin starts, and never
touches the current session:

- **Remember last used** — it comes back however you left it.
- **Always on** — every session starts with it on, whatever you did last time.
- **Always off** — every session starts with it off.

If you upgraded from an earlier version, your old **On startup** checkbox is carried over as
**Always on** or **Always off**, so nothing changes until you pick something else.
```

- [ ] **Step 2: Extend the Pit Crew action page**

In `pit-crew.md`, in the **Race Engineer Toggle** mode section, after the sentence describing the mode's behaviour, add:

```markdown
The Settings window's **Race Engineer → Enabled** checkbox flips this same state, and its **On startup** setting decides what the engineer comes up as after a restart. See [Settings window](/docs/features/settings-window/#race-engineer-and-radar-now-versus-on-startup).
```

In the **Radar Toggle** mode section, add the same sentence with "Radar → Enabled".

- [ ] **Step 3: Add the changelog entry**

In `packages/website/src/content/docs/changelog.mdx`, under the top (in-development) version's `**Features**` block — create the block if the section has none, keeping the fixed header order Features → Improvements → Bug Fixes → Breaking changes → Maintenance:

```markdown
- The Race Engineer and radar now have a live **Enabled** toggle in the Settings window plus a separate **On startup** setting (remember last used / always on / always off), so the startup preference no longer overrides a Pit Crew toggle key mid-session.
```

Keep the whole bullet on one line — rendered markdown reflows, and the file uses no hard wraps inside a paragraph. It is MDX, so a bare `<` or `{` breaks the build; there are none here.

- [ ] **Step 4: Verify the website builds**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && set -o pipefail && pnpm --filter @iracedeck/website build 2>&1 | tail -20
```

Expected: exit 0. A broken anchor in the Pit Crew link surfaces here.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add packages/website && git -c core.longpaths=true commit -m "docs(website): document the Race Engineer/Radar live toggle and startup policy (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

---

### Task 7: Full verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: a branch ready for manual testing.

- [ ] **Step 1: Lint and format**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm lint:fix && pnpm format:fix
```

Expected: exit 0 for both. Fix every warning, including any that predate this branch.

- [ ] **Step 2: Full build**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && set -o pipefail && pnpm build:force 2>&1 | tail -30
```

Expected: exit 0. `build:force` matters: turbo caches `deck-core` (and the root `build` script drops CLI args, so `pnpm build --force` silently still uses the cache), and a `GlobalSettingsSchema` change can otherwise pass on a stale cache. If a deck host (UlanziStudio / Stream Deck) is running it locks `iracing_native.node` and the build fails with EPERM — quit the host and retry.

- [ ] **Step 3: Full test suite**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && pnpm test 2>&1 | tail -30
```

Expected: exit 0, no failures.

- [ ] **Step 4: Re-read the diff**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git diff origin/release/3.0...HEAD --stat
```

Confirm the three `plugin.ts` diffs are identical in shape and that nothing outside the file list above changed.

- [ ] **Step 5: Commit any lint/format fallout**

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git status --short
```

If anything is dirty:

```bash
cd /c/Users/Niklas/Projects/iRaceDeck/ir-1007 && git add -A && git -c core.longpaths=true commit -m "chore: lint and format (#1007)

Claude-Session: https://claude.ai/code/session_013DfEgcdKE8JrdCP1ReYc7X"
```

- [ ] **Step 6: Hand off for manual testing**

Do NOT push or open a PR. Report to the user that the branch is ready, and give them the manual checklist from the spec's "Manual verification" section. The Stream Deck link points at one worktree at a time — verify it targets `ir-1007` before testing.

---

## Manual test checklist (for the user, after Task 7)

1. With the Race Engineer on, change its **On startup** setting — the engineer must keep talking for the rest of the session.
2. Tick/untick **Race Engineer → Enabled** — it turns on/off immediately, plays the acknowledgment once, and a Pit Crew Race Engineer Toggle key's icon follows.
3. Press the Pit Crew key with the settings window open — the checkbox follows, and the acknowledgment plays exactly once.
4. Radar: the tick loop starts/stops from the live checkbox; a mid-session **On startup** change does not disturb it.
5. Set **Always on**, turn the engineer off, restart the plugin — it comes up on, and **silent** (no acknowledgment at startup).
6. Set **Remember last used**, toggle, restart — the state carries over.
7. On an install upgraded from a build with **On startup → Race Engineer enabled** ticked, the policy reads **Always on** and behaves as before.
