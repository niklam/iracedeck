---
# Global Settings

## Overview

Global settings are plugin-level settings shared across all action instances. Use them for:
- Key bindings that should be consistent across actions (keyboard or SimHub)
- User preferences that apply to all actions
- SimHub connection configuration (host/port)

## When to Use Global vs Action Settings

| Setting Type | Storage | Use Case |
|-------------|---------|----------|
| **Global** | Plugin-level | Key bindings, SimHub config, user preferences |
| **Action** | Per-instance | Mode selection, action-specific options |

## Binding Types

Global settings support two binding types via a discriminated union:

```typescript
// Keyboard binding (type defaults to "keyboard" for backward compatibility)
type KeyBindingValue = {
  type: "keyboard";
  key: string;
  modifiers: string[];
  code?: string;
  displayKey?: string;
};

// SimHub Control Mapper role binding
type SimHubBindingValue = {
  type: "simhub";
  role: string;
};

// Union type
type BindingValue = KeyBindingValue | SimHubBindingValue;

// Type guard
isSimHubBinding(value: BindingValue | null | undefined): value is SimHubBindingValue
```

## Property Inspector Usage

### Global Key Binding Input

Use the `global` attribute on `ird-key-binding`. Users can switch between Keyboard
and SimHub modes via a dropdown on each binding:

```html
<sdpi-item label="Lap Timing Key">
  <ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
</sdpi-item>
```

### Using the Global Key Bindings Partial

For multiple key bindings, use the template partial:

```ejs
<%- include('global-key-bindings', {
  keyBindings: require('./data/key-bindings.json').blackBox
}) %>
```

This renders a collapsible "Global Settings" section with all key bindings.

### Other Global Settings

For non-key-binding global settings, use the `global` attribute on sdpi components:

```html
<sdpi-checkbox
  setting="disableWhenDisconnected"
  label="Disable when disconnected"
  global
  default="true"
></sdpi-checkbox>
```

## Action Code Usage

### Executing Bindings (Preferred)

Actions extending `ConnectionStateAwareAction` use binding dispatch delegates:

```typescript
// Declare active binding for readiness tracking
this.setActiveBinding("blackBoxLapTiming");

// Execute (routes to keyboard or SimHub automatically)
await this.tapBinding("blackBoxLapTiming");
await this.holdBinding(ev.action.id, settingKey);
await this.releaseBinding(ev.action.id);
```

### Reading Global Settings Directly

```typescript
import { getGlobalSettings, parseBinding, isSimHubBinding } from "@iracedeck/deck-core";

const globalSettings = getGlobalSettings() as Record<string, unknown>;
const binding = parseBinding(globalSettings["blackBoxLapTiming"]);
// Returns KeyBindingValue | SimHubBindingValue | undefined
```

### Subscribing to Changes

```typescript
import { onGlobalSettingsChange } from "@iracedeck/deck-core";

const unsubscribe = onGlobalSettingsChange((settings) => {
  // React to settings changes
});
// Call unsubscribe() to clean up
```

### GlobalSettingsSchema

Global settings are validated with Zod. The schema is in `deck-core/src/global-settings.ts`:

```typescript
const GlobalSettingsSchema = z.object({
  disableWhenDisconnected: z.boolean().default(true),
  debugLogging: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false), // opt-in verbose logging (issue #609)
  focusIRacingWindow: z.boolean().default(false),
  simHubHost: z.string().default("127.0.0.1"),
  simHubPort: z.coerce.number().min(1).max(65535).default(8888),
}).passthrough();
```

The `.passthrough()` allows dynamic key binding properties (e.g., `blackBoxLapTiming`, `lookDirectionLeft`) without declaring them explicitly in the schema.

**Every plain-value schema field must end in `.catch(<default>)`** (or be otherwise throw-proof, like the union+transform booleans and the `preprocess`-guarded strings). A single throwing field aborts the entire settings parse, which stalls the cache at defaults and makes every key binding look unset (#896). Follow the `spotterStillThereSeconds` / `changelogNotification` precedent when adding fields.

## Write semantics — stale-cache safety (#896)

Global settings are one JSON blob with two independent full-object writers — the PI (sdpi-components saves its whole page snapshot) and the plugin (`updateGlobalSettings` sends the whole cache). A write from a stale cache silently deletes keys the other side saved (the "key bindings not saved" bug). `global-settings.ts` defends every plugin-side write path; when touching that module, preserve these four mechanisms:

- **First-arrival gate.** Writes (`updateGlobalSettings` / `deleteGlobalSettings`) before the host's first `didReceiveGlobalSettings` response are applied to the cache (read-your-writes) but **queued, not persisted** — the cache is pure schema defaults until then, and persisting would wipe storage. The first arrival flushes queued writes merged over the real settings. Consequence: plugin code may write global settings at any time, including before startup settings arrive (the #610 elevation probe does), without wiping anything.
- **Pending-write overlay.** Every written key stays pending until a host payload confirms it. A stale echo (key missing, or still carrying the pre-write value) gets the local write re-applied; a genuinely different value is a newer foreign write and wins; on the first arrival local writes always win. This is what stops the delayed host echo (#419) from rolling back local writes.
- **Per-key salvage.** Host payloads are parsed with `parseWithSalvage`: when the strict parse fails, the offending top-level keys are dropped (falling back to their schema defaults) and the parse retried, so one corrupt value can't stall every setting. Passthrough keys (bindings) are never validated, so they can never be dropped.
- **Shrink guard.** Outgoing writes restore any key the last host payload held that is missing from the cache and was not explicitly deleted — logged at `warn` with the key names at `debug`. Defense-in-depth against any future path that loses keys from the cache.

Diagnostics: with `debugLogging` on, the module logs raw payloads, queued/flushed writes, re-applied pending keys, salvage-dropped keys, and shrink-guard restores — enough to tell which failure path a "bindings not saved" report actually hit.

## Title Settings Keys

Plugin-level title defaults are stored as flat keys with a `title` prefix and read via `getGlobalTitleSettings()`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `titleShowTitle` | boolean | `true` | Show title text on key |
| `titleShowGraphics` | boolean | `true` | Show graphics on key |
| `titleBold` | string | `"default"` | Bold: `"default"`, `"true"`, `"false"` |
| `titleFontSizeDefault` | boolean | `true` | Use icon default font size (hides range when true) |
| `titleFontSize` | number | `9` | Title font size in PI units (5–100, doubled for SVG) |
| `titlePosition` | string | `"default"` | Position: `"default"`, `"top"`, `"middle"`, `"bottom"`, `"custom"` |
| `titleCustomPosition` | number | `0` | Vertical offset for custom position (−100 to +100) |

`"default"` means defer to the icon's `<desc>` title metadata default. These are configured in the Global Settings PI section under "Title Defaults". Use `getGlobalTitleSettings()` in action code to read them:

```typescript
import { getGlobalTitleSettings, resolveTitleSettings } from "@iracedeck/deck-core";

const globalTitleSettings = getGlobalTitleSettings();
const title = resolveTitleSettings(graphicSvg, globalTitleSettings, settings.titleOverrides, "DEFAULT\nTITLE");
```

## Per-callout opt-in/out — `callout<Polarity><Family><Subject>`

For features that expose N parallel opt-ins for individual callouts the Race Engineer makes (e.g. issue #467: every flag color), use one boolean global-settings key per subject under a uniform naming convention:

**Naming.** `callout` prefix + `Enabled` polarity word + family noun + subject identifier. Examples: `calloutEnabledFlagYellowLocal`, `calloutEnabledFlagMeatball`, future `calloutEnabledPitActionFuel`. A `grep calloutEnabled` finds every callout-toggle setting in one shot. The polarity is **always** positive (`Enabled`); each schema field's *default* encodes the family's natural baseline (callouts default `true`; opt-in families would default `false`).

**Why per-item booleans (not an array, not a bitmask).** Forward-compat: when a new subject ships in a later release, its newly-added Zod field defaults `true` for every existing user via `passthrough()` — no migration, no "this new feature is mysteriously off". Array-based storage and enabled-bitmasks both fail this property; per-item booleans don't.

**Pattern.**

1. **Schema** — add one boolean field per subject to `GlobalSettingsSchema`. Use the standard string/boolean coercion: `z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true").default(true)`.
2. **Canonical id↔key map** — keep next to the feature catalog (not in `deck-core`). Export `type SubjectId = "x" | "y" | …` and `const FOO_SETTING_KEYS: Record<SubjectId, string>`. Plugins import both and read the live cache via `(getGlobalSettings() as Record<string, unknown>)[FOO_SETTING_KEYS[id]] !== false`.
3. **Live gating** — when the feature dispatches via the audio-scenarios `where:` predicate (or any equivalent per-event hook), read the live setting on every event arrival rather than re-registering on `onGlobalSettingsChange`. Gating at event arrival means a toggle taking effect mid-session never cuts work already in flight.
4. **PI** — group all subjects of a family inside a single `<sdpi-item label="<Family>">` containing `<sdpi-checkbox setting="..." label="..." global default="true">` rows. Layout: keep the list of `{ setting, label }` pairs in a small JS array at the top of the EJS template, then build the inner div with `grid-template-rows: repeat(<%= Math.ceil(items.length / 2) %>, auto); grid-auto-flow: column;` — items fill column 1 top-to-bottom, then column 2, and the layout stays at exactly two columns no matter how the list grows (see `pit-crew.ejs` "Flags" item, currently 11 split 6+5). Don't hardcode the row count; the array drives both the option list and the grid template. One accordion per feature category (e.g., "Race Engineer Callouts") holds every family's `sdpi-item`. Use `default="true"` (renders checked); `default="false"` is the trap (also renders checked because the HTML attribute is truthy).

**Vertical-space follow-up.** A future custom `<ird-checkbox-list>` component will accept the same per-item-setting model and render multi-column for vertical-space wins; that work is tracked separately and should land alongside the second family (Pit Actions) so it has two consumers at once. Per-item booleans + the `callout<…>` naming stay the persistence shape regardless of how the UI groups them.

Reference implementation: per-flag callouts in `packages/audio-scenarios/src/catalog/pit-crew/index.ts` (`FlagCalloutId`, `FLAG_CALLOUT_SETTING_KEYS`, `wrapFlagScenario`).

## Settings Key Convention

Global key bindings use flat key names:
- `blackBoxLapTiming`, `blackBoxFuel`, `lookDirectionLeft`, etc.

Global settings use flat key names (e.g., `blackBoxLapTiming`), not nested paths.

## PI Warning Banners — `_warnings` + `setWarning`/`clearWarning`

Plugin code can surface a banner at the top of every Property Inspector (issue #610). Warnings are persisted in the `_warnings` global setting as a JSON array of `{ id, level, message }` records (`level` is `"info" | "warning" | "error"`). `_warnings` is a passthrough key — no `GlobalSettingsSchema` field is needed (same as `_audioDeviceList`).

Manage warnings from `@iracedeck/deck-core`:

```typescript
import { setWarning, clearWarning } from "@iracedeck/deck-core";

setWarning("elevation-mismatch", "warning", "…message…"); // upsert, keyed by id
clearWarning("elevation-mismatch");                         // remove by id
```

Records are keyed by `id` so independent producers coexist. `setWarning` skips the write when an identical record already exists; `clearWarning` is a no-op when the id is absent. The `ird-warnings` PI web component (auto-injected by `head-common.ejs`) renders the array and prepends a per-level icon — so warning **messages must not start with their own emoji**. Banners are state-driven and not dismissible: a warning persists until its condition clears.

Reference producer: the elevation-mismatch detector wired in both plugins' `plugin.ts` using `evaluateElevationWarning()` + `getElevationStatus()`.

## Version-upgrade changelog — `_lastSeenVersion` + `runVersionCheck` (#680, #742, #870)

On the first global-settings arrival each startup, every plugin compares the running plugin version (`getPluginVersion()`) against the last version the user saw, stored in the passthrough `_lastSeenVersion` key. When a strictly newer **stable** version is detected (a first install with nothing stored also counts), the plugin persists the running version and opens the website changelog (`CHANGELOG_BASE_URL` = `https://iracedeck.com/changelog/`) in the user's default browser — exactly once per upgrade. Pre-release builds (`-dev`, `-rc`) and same/older versions are inert: no open, and the stored value is never lowered (it tracks the highest stable version seen). `_lastSeenVersion` is a passthrough key — no `GlobalSettingsSchema` field is needed (same as `_warnings` / `_audioDeviceList`).

**The changelog never opens while iRacing is running** (issue #870 — a deck-host auto-update restarts the plugin mid-session, and the page must not pop over a live race). `runVersionCheck` takes an optional `isSimRunning` delegate consulted only when an `open` is actually due: when it reports true the open **defers** — nothing persisted, the version stays pending — with `track-silently` outcomes unaffected (nothing opens anyway). Plugins pass `isIRacingActive` from `app-monitor.ts` (running-flag OR live SDK connection — the two signals cover each other's gaps) and re-run the check from the app monitor's `onIRacingTerminated` hook. Exit detection has two paths: the host's `applicationDidTerminate` event, whose handler notifies **after** the running flag and SDK connection are already down (`setReconnectEnabled(false)` actively disconnects — wrapped in try/catch so a throwing telemetry subscriber in its fan-out can't swallow the notification); and the **SDK-disconnect fallback** for hosts that never deliver app-monitoring events (UlanziStudio maps none; Mirabox delivery is unproven) — a lost SDK connection sustained for `IRACING_EXIT_SDK_CONFIRM_MS` (5 s) counts as the exit, deduped per episode against the event path, skipped when an event-set running flag says iRacing still runs (an SDK blip), and clearing a connection-derived running flag whose only evidence was that connection. An adapter that never delivers the events declares `supportsApplicationMonitoring = false` on `IDeckPlatformAdapter` (Ulanzi does); the app monitor then keeps SDK reconnect polling enabled at startup — otherwise the SDK could never attach when iRacing starts after the plugin, starving both telemetry and the fallback of their signal. The startup check itself is delayed by `VERSION_CHECK_STARTUP_GRACE_MS` (15 s, exported from `version-check.ts`) because on a mid-session restart the launch event / SDK connection race the first settings arrival — an immediate check could read "not running" and open over the session. Each plugin wraps all of this in one `runChangelogVersionCheck()` that re-reads the **live** settings cache per call, guarded on `startupDefaultsApplied` so a terminate before the first settings arrival is a no-op; the terminate listener is additionally gated on `shouldOpenChangelog` so once the version is persisted (or on a pre-release build) later sim exits don't re-run a dead check and re-log "Version up to date" forever. User-facing behavior is documented on the website: `docs/features/whats-new-page.md`.

**When a due changelog actually opens is user-configurable** (issue #742) via the `changelogNotification` schema field (`z.enum(CHANGELOG_NOTIFICATION_POLICIES).default("always").catch("always")` — the values array lives in `version-check.ts` so schema and logic share one source of truth, and the `.catch` keeps a malformed persisted value from aborting the whole settings parse): `always` (every stable update — the default, keeping the feature opt-out), `features` (major/minor bumps only; patch releases persist `_lastSeenVersion` silently), `monthly` (at most once per 30 days — a suppressed update stays fully pending, nothing persisted, and opens at the first startup after the window passes), `never` (still persists `_lastSeenVersion` silently so switching back later doesn't replay an old release). The monthly window is anchored on the passthrough `_lastChangelogOpenedAt` key (epoch ms), stamped on **every** open under any policy so a later switch to `monthly` has a meaningful anchor. The PI control is a `sdpi-select` in the shared "Common Settings" accordion (`global-common-settings.ejs`, "Updates" group) with plain-language labels — no major/minor jargon.

The decision + orchestration are pure helpers in `@iracedeck/deck-core` (`version-check.ts`): `shouldOpenChangelog(current, lastSeen)`, `resolveChangelogDecision({ currentVersion, lastSeenVersion, policy, lastOpenedAt?, now })` → `"open" | "track-silently" | "defer" | "skip"`, `buildChangelogUrl({ ecosystem, deviceType })`, and `runVersionCheck({ currentVersion, lastSeenVersion, policy?, lastOpenedAt?, now?, ecosystem, deviceType?, isSimRunning?, persist, persistOpenedAt?, openUrl, logger })`. `runVersionCheck` persists FIRST so a flaky open never re-triggers next startup, then opens (failures are swallowed + logged) — with the #870 sim gate checked before the persist, since a persisted version would mark the release seen without it ever opening. The opener is injected per platform so `deck-core` stays platform-agnostic — Elgato passes `streamDeck.system.openUrl` via the concrete `adapter.openUrl`; Mirabox sends a best-effort `openUrl` VSD event (harmless if the Stream Dock host ignores it). The URL carries anonymous `ecosystem` (`getPluginPlatform()`, always) and best-effort `type` (device-type id; Elgato reads the connected device from `streamDeck.devices`, omitted otherwise) query params so the changelog page can tailor content.

Wired in every plugin's `runChangelogVersionCheck()` — scheduled with the #870 startup grace from the first-settings-arrival block (the `startupDefaultsApplied` one-shot) and re-run from `onIRacingTerminated` — in `plugin.ts`. The `openUrl` capability is a concrete method on each adapter (`ElgatoPlatformAdapter`, `VSDPlatformAdapter`, `UlanziPlatformAdapter`) — deliberately **not** on `IDeckPlatformAdapter`, to avoid touching every typed mock adapter.

## Binding-configured detection — `isConfigured` / `isBindingMissing` (#612)

A binding key counts as "configured" when **either** a keyboard binding **or** a SimHub role is set — independent of iRacing connection or SimHub reachability. `BindingDispatcher.isConfigured(settingKey)` is the source of truth (it parses the global setting via `parseBinding` + `isSimHubBinding`). `ConnectionStateAwareAction.isBindingMissing(keys: string | string[] | null | undefined)` builds on it: returns true when any required key is unconfigured, false for `null`/empty (api/chat/fixed-key modes). Use `isBindingMissing(<per-context key(s)>)` to drive the per-button missing-binding icon warning — never the shared `isActiveBindingMissing()`/`activeBindingKeys`, which is one value per action-class instance and bleeds across the action's buttons.

The PI `ird-binding-status` line shows the same configured/unconfigured state per mode (reading bindings from the *Related Key Bindings* `ird-key-binding` inputs). A mode bound to a SimHub role is "configured" even when SimHub isn't running — SimHub-not-running is surfaced separately as a live "SimHub not connected" caveat, not as a missing binding.
