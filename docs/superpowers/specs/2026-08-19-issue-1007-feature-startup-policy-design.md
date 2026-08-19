# Race Engineer / Radar: live master toggle + startup policy (issue #1007)

Date: 2026-08-19
Target branch: `release/3.0`
Milestone: 3.0

## Problem

The settings window's **On startup → Race Engineer enabled** / **Radar enabled** checkboxes apply
*immediately*, not at the next start. Each `plugin.ts` mirrors an `…OnStartup` edit into the runtime
gate on every settings change, so the checkbox silently overrides whatever a Pit Crew **Race Engineer
Toggle** key had set. The label promises a startup default and the control behaves as a live master
toggle.

The mirror is deliberate (a comment says so): it exists so ticking the box has audible effect
mid-session. Its side effects have outgrown it now that a deck key and the Audio Controls dial both
give live control, and #1003 moved the checkbox onto a Race Engineer settings tab further away from
the key it overrides.

## Decision

Issue #1007 offers three fixes. We take **C — separate the two ideas**: a real live master toggle
*and* a distinct startup policy. A (drop the mirror) leaves the settings window with no live control
at all, so a user with no Pit Crew key placed could only turn the engineer on by restarting the
plugin. B (relabel to a live toggle) keeps two controls fighting over one flag and loses "on now,
off next time" entirely.

## Settings model

### New keys

| Key | Type | Default |
|---|---|---|
| `pitCrewRaceEngineerStartupPolicy` | `"remember-last" \| "always-on" \| "always-off"` | `"remember-last"` |
| `pitCrewRadarStartupPolicy` | same | `"remember-last"` |

The live keys `pitCrewRaceEngineerEnabled` / `pitCrewRadarEnabled` are unchanged: still the single
runtime gate every scenario, the radar engine and the Pit Crew icon read, still defaulting to
`false`.

### Retired keys

`pitCrewRaceEngineerEnabledOnStartup` and `pitCrewRadarEnabledOnStartup` are **removed from
`GlobalSettingsSchema`**. This is load-bearing, not tidiness: while a key is schema-backed the parsed
cache always holds at least its default, so a migration reading the cache cannot tell a stored
`false` from a defaulted `false`, and `deleteGlobalSettings` cannot remove it (the next parse
re-materialises the default). Once the field leaves the schema, `.passthrough()` keeps any stored
value verbatim — readable, and deletable for good.

### Source of truth

A new `packages/deck-core/src/feature-startup-policy.ts`, following the `version-check.ts`
precedent (the values array and the default constant live next to the logic; the schema imports
them, so there is one source of truth):

```ts
export const FEATURE_STARTUP_POLICIES = ["remember-last", "always-on", "always-off"] as const;
export type FeatureStartupPolicy = (typeof FEATURE_STARTUP_POLICIES)[number];
export const DEFAULT_FEATURE_STARTUP_POLICY: FeatureStartupPolicy = "remember-last";

/** The gate value a policy produces from the value carried over from last session. */
export function resolveStartupGate(policy: FeatureStartupPolicy, remembered: boolean): boolean;

/** Write both live gates from their policies. Writes nothing under `remember-last`. */
export function applyStartupFeatureGates(logger?: ILogger): void;

/** One-shot: retired `…EnabledOnStartup` booleans → the new policy keys. */
export function migrateStartupPolicies(logger?: ILogger): void;
```

Both schema fields use `z.enum(FEATURE_STARTUP_POLICIES).default(DEFAULT_FEATURE_STARTUP_POLICY)
.catch(DEFAULT_FEATURE_STARTUP_POLICY)` — the `.catch` is mandatory, since one throwing field aborts
the whole settings parse and makes every binding look unset (#896).

### Migration

Runs inside each plugin's existing first-arrival block, which is already gated on
`isSettingsStoreReady()`, immediately before the startup application and alongside the other
one-shots:

| Stored `…EnabledOnStartup` | New policy | Effect for that user |
|---|---|---|
| `true` | `always-on` | identical to today |
| `false` | `always-off` | identical to today |
| absent | *(untouched — schema default `remember-last`)* | fresh install |

Then the old key is deleted. Idempotent by absence, so no marker key is needed. Every existing
install has the old key stored explicitly — each schema field's default is persisted the first time
any plugin-side write happens, and one always does — so upgrades keep their exact current behaviour
and only fresh installs get `remember-last`. Under `remember-last` a fresh install still starts
silent, because the live keys default to `false`.

`migrateStartupPolicies` cannot use `migrateGlobalSettingsKeys`: that helper renames a key, while
this transforms a boolean into an enum.

## Live-edge ownership

Today `toggleRaceEngineerFeature` owns the off-edge side effects — `stopRaceEngineerScenarios()` and
the spoken acknowledgment. Any *other* writer of the live key therefore produces a half-toggle: the
plugin-level `applyAudioState` listener mutes the buses, but the in-flight scenario and its looping
ambient bed keep running (the bug #587 fixed) and the stuck `playingId` drops every later callout as
"bus busy". A settings-window checkbox bound to the live key would hit exactly that.

So the edges move to a single owner: `packages/iracing-actions/src/audio/feature-gates.ts`.

```ts
/** Global-settings listener that applies the side effects of a live gate CHANGE. */
export function createFeatureGateSync(logger: ILogger): () => void;
```

- Seeds its trackers on the first invocation and applies nothing, so the startup application can
  never play an acknowledgment at plugin start.
- On a change of `pitCrewRaceEngineerEnabled`: `stopRaceEngineerScenarios()` when it goes off, then
  the toggle acknowledgment when `calloutEnabledToggleRaceEngineer` allows it.
- On a change of `pitCrewRadarEnabled`: push the gate into the radar engine (`setRadarEnabled`).
- Registered once per plugin: `onGlobalSettingsChange(createFeatureGateSync(logger))`.

`toggleRaceEngineerFeature` / `toggleRadarFeature` shrink to "compute next, write it, return it".
`updateGlobalSettings` fires listeners **synchronously**, so a key press still stops the scenario and
mutes the bus on the same tick — the latency guarantee those functions were written for is
structural now rather than duplicated. The Audio Controls dial's Mute/Unmute rides the same pathway
unchanged.

Accepted consequence: the spoken **"Going silent" / "Resuming"** acknowledgment now also plays when
the settings-window checkbox is ticked. That is intended — the checkbox *is* the master toggle, and
the existing per-callout opt-in still silences it.

`applyAudioState` in each `plugin.ts` keeps its unconditional bus/engine applies. The overlap on
`setRadarEnabled` is idempotent and left as defence in depth.

## Plugin wiring (all three, identical)

1. Delete the mirror block and both `lastSeenPitCrew…OnStartup` trackers.
2. Replace the 4-line startup write with `applyStartupFeatureGates(logger)`.
3. Add `migrateStartupPolicies(logger)` beside the existing first-arrival migrations.
4. Register `onGlobalSettingsChange(createFeatureGateSync(logger))` once, near `applyAudioState`.

Each `plugin.ts` ends up shorter than today, and the triplicated policy logic collapses into one
shared module.

## Property Inspector

Only the settings window renders `race-engineer-settings.ejs` since #1003, so no action PI changes.
Per feature, a live checkbox and a startup select:

```text
Race Engineer   [x] Enabled
                Turns the engineer on or off right now — the same as a
                Pit Crew Race Engineer Toggle key.
  On startup    ( Remember last used ▾ )

Radar           [ ] Enabled
  On startup    ( Always off ▾ )
```

Supporting text uses the shared `ird-supporting-text` class — never an inline `style`.

## Documentation

- `docs/features/settings-window.md` — a short subsection distinguishing the live toggle from the
  startup policy, naming the deck key as the other way to flip the same state.
- `docs/actions/audio-voice/pit-crew.md` — the Race Engineer Toggle and Radar Toggle modes gain a
  line stating the settings window shows and flips the same live state, and that the startup policy
  decides what it comes up as.
- `changelog.mdx` — one `**Features**` line under the in-development version.

## Testing

New: `feature-startup-policy.test.ts` (resolver for all three policies × both remembered values;
migration mapping, deletion, idempotence, absence) and `feature-gates.test.ts` (first-call seeding
applies nothing; off edge stops scenarios and acks; on edge acks; ack suppressed by the per-callout
opt-in; radar edge drives the engine; no side effects when the value is unchanged).

Updated: `simhub-service.test.ts` and `accordion-partial.test.ts` (retired key literals),
`audio-toggles.test.ts` and `pit-crew.test.ts` (side effects moved out of the toggle functions).

## Manual verification

1. With the Race Engineer on, change its startup policy: the engineer keeps talking for the rest of
   the session.
2. Tick the live **Enabled** checkbox: the engineer turns on/off immediately, plays the
   acknowledgment, and a Pit Crew Race Engineer Toggle key's icon follows.
3. Press the Pit Crew key with the settings window open: the checkbox follows, and acks once.
4. Radar: the tick loop starts/stops from the live checkbox, and mid-session policy edits do not
   disturb it.
5. `always-on` with the engineer off at exit → next start comes up on and **silent** (no ack).
6. `remember-last` → the state carries across a plugin restart.
7. An install upgraded from a build with **On startup** ticked comes up with `always-on` and behaves
   exactly as before.
