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
  disableWhenDisconnected: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true)
    .catch(true),
  debugLogging: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false), // opt-in verbose logging (issue #609)
  focusIRacingWindow: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true) // on by default since #930
    .catch(true),
  simHubHost: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().default("127.0.0.1").catch("127.0.0.1"),
  ),
  simHubPort: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.coerce.number().min(1).max(65535).default(8888).catch(8888),
  ),
}).passthrough();
```

The `.passthrough()` allows dynamic key binding properties (e.g., `blackBoxLapTiming`, `lookDirectionLeft`) without declaring them explicitly in the schema.

**Every plain-value schema field must end in `.catch(<default>)`** (or be otherwise throw-proof, like the union+transform booleans and the `preprocess`-guarded strings). A single throwing field aborts the entire settings parse, which stalls the cache at defaults and makes every key binding look unset (#896). Follow the `spotterStillThereSeconds` / `changelogNotification` precedent when adding fields.

## Single writer — the plugin-owned settings store (#993)

**The plugin owns global settings; the deck host does not.** They live in one JSON file per ecosystem — `%LOCALAPPDATA%\iRaceDeck\Settings\<Stream Deck|Mirabox|Ulanzi>\global-settings.json`, resolved by `resolveSettingsStorePath()` and overridable for development with the `IRACEDECK_SETTINGS_PATH` env var (a full file path) — outside every host's plugin folder, so settings survive plugin updates and reinstalls and the three ecosystems never share state. The host's own store is read **at most once** — only when there is no file yet, to migrate an existing installation — and ignored from then on. That ends the two-independent-writers problem, so the machinery that existed to survive it was **deleted** in #993: the #896 first-arrival gate, the pending-write overlay and its reconciliation, `lastHostSettings`/the shrink guard, plus the Ulanzi adapter's write gate. Don't reintroduce them.

Plugin setup — the store is a required third argument to `initGlobalSettings`, created before it:

```typescript
import {
  createFileSettingsStore,
  getPluginPlatform,
  initGlobalSettings,
  resolveSettingsStorePath,
} from "@iracedeck/deck-core";

const settingsStore = createFileSettingsStore({
  path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }),
  logger: adapter.createLogger("SettingsStore"),
});

// Still BEFORE adapter.connect()
initGlobalSettings(adapter, adapter.createLogger("GlobalSettings"), settingsStore);
```

`createMemorySettingsStore()` is the store for tests and the scenario harness.

**Startup.** `initGlobalSettings` returns the (default) cache immediately and finishes loading in the background; listeners fire once when the cache first reflects the store:

- **File present** → parsed with per-key salvage → cache → listeners. The file is re-saved, which heals a file whose salvage dropped keys.
- **No file** → ONE `adapter.getGlobalSettings()`; the first `didReceiveGlobalSettings` payload is salvaged, becomes the cache, and is written as the file ("Migrated global settings from the deck host"). If the host doesn't answer within `MIGRATION_TIMEOUT_MS` (10 s) the plugin starts fresh and writes a defaults file. A payload that arrives without having been asked for — a PI's save echo, or one racing the file load — is **ignored** for the cache and logged at debug; a host answer can never migrate over an existing file.
- **File unreadable** (a read error other than ENOENT — locked, permission denied) → retried `LOAD_RETRY_DELAY_MS` (1 s) apart, 3 attempts, then the session runs on schema defaults and **never saves**, logged at error. Fail closed on purpose: `save` replaces the file atomically, so writing defaults over settings we merely failed to READ would destroy them. The store never becomes ready, so every gate below stays closed.
- **File unparseable** → moved aside as `global-settings.corrupt-<iso>.json` (copied aside if the rename fails) and reported as "no file", so a user's file is never silently discarded.

**Writes.** `updateGlobalSettings(partial)` / `deleteGlobalSettings(keys)` → merge → parse with salvage → cache → listeners → `store.save(cache)`. Read-your-writes is trivial (the cache is truth). The file write is **debounced** (250 ms, trailing) and **atomic** (temp file + rename), so a slider drag or a key-binding recording can't hammer the disk and no reader ever sees a partial file; `flush()` forces it out, and each plugin registers `process.on("exit", () => store.flushSync())` so the last debounced write still lands when the host stops the plugin (the Mirabox/Ulanzi clients call `process.exit(0)` on socket close, and an `exit` handler gets no event-loop turn — hence the synchronous variant). A write made before the store is ready updates the cache and notifies listeners as usual, and is additionally recorded and re-applied over the loaded/migrated settings — so a startup write (the audio-device list, the #610 elevation probe) is neither lost nor able to persist schema defaults over the file. No write path calls `adapter.setGlobalSettings`.

**One host write per start — the guarded mirror.** Each plugin's store-ready startup block publishes `_settingsChannel: { port, token }` — the loopback settings server's address, once `settingsWindow.ensureStarted()` resolves — into the store, and then makes the plugin's ONE deck-host write of the run: `hostMirrorPayload({ port, token })` → `adapter.setGlobalSettings(mirror)`. The payload is the **full** cache plus `_settingsChannel`, never a partial: every host's `setGlobalSettings` **REPLACES** the whole stored object (that is the #896 history, and `scenario-harness/src/mock-platform-adapter.test.ts` asserts it), so a bare `{ _settingsChannel }` would truncate the host copy to one key — PIs blank, downgrade net gone. `hostMirrorPayload` returns `undefined`, and the write is skipped, when the store isn't ready or became ready via the migration timeout (`getSettingsStoreSource() === "fresh"`): the host never answered the migration read, so the cache is schema defaults and mirroring it would clobber a copy the plugin never got to see. Info lines (parameter-free, once per start): `Mirrored settings + channel to the deck host` / `Host mirror skipped: the store started fresh`. Nothing else in the plugin calls `adapter.setGlobalSettings` — the host copy is read once for migration, then refreshed by this one mirror per start and otherwise left alone, so it stays the downgrade safety net.

**Property Inspectors read and write through the plugin too (#993 phase 2).** Every action PI carries a bridge script injected before `sdpi-components.js` — `pi-settings-bridge.js` on Elgato and Mirabox, the grown `ulanzi-pi-bridge.js` on Ulanzi — handing sdpi a wrapped socket. Both run the same shared state machine (`pi-components/src/settings-channel/router.ts`, `idle → bootstrapping → connecting → loopback`): when the host socket opens it sends ONE plain `getGlobalSettings` read (the bootstrap; plugin-scoped on Ulanzi), parses `_settingsChannel` out of the reply, opens `ws://127.0.0.1:<port>/ws?t=<token>` (token on the upgrade query, no cookie) and from then on routes `getGlobalSettings`/`setGlobalSettings` to the plugin and delivers the plugin's `didReceiveGlobalSettings` pushes to sdpi — **dropping the host's**, since the file is truth. Only those three frames are rerouted; `sendToPlugin`, `openUrl`, `logMessage`, per-action `getSettings`/`setSettings`/`didReceiveSettings`, `sendToPropertyInspector` and `registerPropertyInspector` pass through to the real host untouched. So window ↔ PI ↔ PI stay in sync live, and a PI edit lands in the plugin-owned file like any other write.

**Fallback, never a blank PI.** No `_settingsChannel` in the host's reply, a loopback connect that is refused, or a phase that doesn't settle within `BOOTSTRAP_TIMEOUT_MS` (3 s — armed on the bootstrap read AND on every connect attempt, so a stalled socket can't leave sdpi's `getGlobalSettings()` promise pending forever) drops the PI back to the host path with a `console.warn`; queued frames replay there, and the PI keeps working exactly as it did before phase 2. A PI opened in the seconds before the mirror write still switches **late**: a host push carrying a channel the router has not already tried starts a connect from `fallback`. A channel that was _refused_ (closed before it ever opened) or _stalled_ (the connect-phase settle timer fired with no `onOpen`/`onClose` at all) is not retried; one that opened and later closed is — a clean close is not a refusal. If the host socket itself closes before the bootstrap ever completed the router returns to `idle` so a retried connection can bootstrap again; from any later state it lands in `fallback`.

**The loopback guard is token-first.** `authorizeSettingsRequest` authorizes any request carrying the valid launch token **regardless of `Origin`** — PIs are `file://` pages (Origin `null`) or host-served origins, and the token is the secret (per-launch, 48 hex chars, reachable only through the window's URL and the plugin's own store). Without a token the original rules stand: `Origin`, when present, must equal the loopback origin exactly, and only then is the `SameSite=Strict` cookie compared — so the cookie path keeps its DNS-rebinding mitigation. No CORS header is ever emitted, and the bind stays `127.0.0.1`. Every upgrade decision reaches the controller through the server's `onUpgradeDecision` hook and is logged at debug: `Settings socket accepted (origin: …)` / `Settings socket rejected: <reason> (origin: …)`.

`_settingsStorePath` is published unconditionally (not inside the server's `then`, so a bind/firewall failure still leaves the path visible) for the Diagnostics "Settings file" row and its **Open folder** button — see `settings-window.md`.

**`isSettingsStoreReady()`** reports whether the cache reflects the store — loaded, migrated, or fresh. It replaced `hasReceivedHostSettings()`, which is **removed**. Before it flips, the cache is pure schema defaults with no passthrough keys, so anything that must not act on defaults gates on it: `focusIRacingIfEnabled()`, the one-shot key migrations in `global-settings-migrations.ts`, and each plugin's `startupDefaultsApplied` block. Any consumer deciding on the ABSENCE of a key must wait for it. `isGlobalSettingsInitialized()` is the weaker, different thing (`initGlobalSettings` has been called) — never use it as this gate.

**Per-key salvage stays.** Stored settings are parsed with `parseWithSalvage`: when the strict parse fails, the offending top-level keys are dropped (falling back to their schema defaults) and the parse retried, so one corrupt value can't stall every setting. Passthrough keys (bindings) are never validated, so they can never be dropped. It now guards a partially-bad **file** — hand-edited, or written by an older schema — instead of a partially-bad host payload.

**Changing a schema default still reaches new installs only.** Every write persists the whole _parsed_ cache, so each schema field's default is written into the file the first time any write happens — and one always does at startup (`_audioDeviceList`, `_settingsStorePath`). On an upgrade the migrated file carries whatever the host had, so existing installs keep their old values too. Flipping a `.default(...)` therefore changes behavior for fresh installs only; there is no way to tell a persisted default apart from a deliberate user choice, so reaching existing users needs an explicit one-shot migration guarded by a passthrough marker key (see `global-settings-migrations.ts` for the renames case). #930 flipped `focusIRacingWindow` to `true` accepting exactly this.

**Passthrough keys the store introduces:** `_settingsStorePath` (the resolved file path, shown on Diagnostics) and `_settingsChannel` (`{ port, token }`). Both plugin-written; not user settings. Both reach Property Inspectors again — `_settingsChannel` through the mirror the bootstrap read returns, everything else through the loopback pushes — so a PI's Diagnostics row shows `_settingsStorePath` and `_warnings` / `_audioDeviceList` / `_deckDevices` are live there as well (once the PI has bootstrapped onto the loopback channel; a fallen-back PI sees only the once-per-start host mirror, not live pushes).

Diagnostics: with `debugLogging` on, the module logs the store path and stored-key count on load, the raw host payload during migration, every ignored host payload, salvage-dropped keys, and each `Settings saved: <path>` — enough to tell which path a "settings not saved" report actually hit.

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

Reference producer: the elevation-mismatch detector — deck-core's `createElevationCheckSubscriber` (wrapping `evaluateElevationWarning()` + the injected `getElevationStatus()`), wired in every plugin's `plugin.ts`.

## Version-upgrade changelog — `_lastSeenVersion` + `runVersionCheck` (#680, #742, #870, #901)

On the first global-settings arrival each startup, every plugin compares the running plugin version (`getPluginVersion()`) against the last version the user saw, stored in the passthrough `_lastSeenVersion` key. When a strictly newer **stable** version is detected (a first install with nothing stored also counts), the plugin persists the running version and opens the website changelog (`CHANGELOG_BASE_URL` = `https://iracedeck.com/changelog/`) in the user's default browser — exactly once per upgrade. Pre-release builds (`-dev`, `-rc`) and same/older versions are inert: no open, and the stored value is never lowered (it tracks the highest stable version seen). `_lastSeenVersion` is a passthrough key — no `GlobalSettingsSchema` field is needed (same as `_warnings` / `_audioDeviceList`).

**The changelog never opens while iRacing is running** (issue #870 — a deck-host auto-update restarts the plugin mid-session, and the page must not pop over a live race). `runVersionCheck` takes an optional `isSimRunning` delegate consulted only when an `open` is actually due: when it reports true the open **defers** — nothing persisted, the version stays pending — with `track-silently` outcomes unaffected (nothing opens anyway). Plugins pass `isIRacingActive` from `app-monitor.ts` (running-flag OR live SDK connection — the two signals cover each other's gaps) and re-run the check from the app monitor's `onIRacingTerminated` hook. Exit detection has two paths: the host's `applicationDidTerminate` event, whose handler notifies **after** the running flag and SDK connection are already down (`setReconnectEnabled(false)` actively disconnects — wrapped in try/catch so a throwing telemetry subscriber in its fan-out can't swallow the notification); and the **SDK-disconnect fallback** for hosts that never deliver app-monitoring events (UlanziStudio maps none; Mirabox delivery is unproven) — a lost SDK connection sustained for `IRACING_EXIT_SDK_CONFIRM_MS` (5 s) counts as the exit, deduped per episode against the event path, skipped when an event-set running flag says iRacing still runs (an SDK blip), and clearing a connection-derived running flag whose only evidence was that connection. An adapter that never delivers the events declares `supportsApplicationMonitoring = false` on `IDeckPlatformAdapter` (Ulanzi does); the app monitor then keeps SDK reconnect polling enabled at startup — otherwise the SDK could never attach when iRacing starts after the plugin, starving both telemetry and the fallback of their signal. The startup check itself is delayed by `VERSION_CHECK_STARTUP_GRACE_MS` (15 s, exported from `version-check.ts`) because on a mid-session restart the launch event / SDK connection race the first settings arrival — an immediate check could read "not running" and open over the session. Each plugin wraps all of this in one `runChangelogVersionCheck()` that re-reads the **live** settings cache per call, guarded on `startupDefaultsApplied` so a terminate before the first settings arrival is a no-op; the terminate listener is additionally gated on `shouldOpenChangelog` so once the version is persisted (or on a pre-release build) later sim exits don't re-run a dead check and re-log "Version up to date" forever. User-facing behavior is documented on the website: `docs/features/whats-new-page.md`.

**When a due changelog actually opens is user-configurable** (issue #742) via the `changelogNotification` schema field (`z.enum(CHANGELOG_NOTIFICATION_POLICIES).default(DEFAULT_CHANGELOG_NOTIFICATION_POLICY).catch(...)` — the values array and the default constant live in `version-check.ts` so schema and logic share one source of truth, and the `.catch` keeps a malformed persisted value from aborting the whole settings parse): `always` (every stable update — the default until #901), `features` (major/minor bumps only; patch releases persist `_lastSeenVersion` silently — the default since #901, `DEFAULT_CHANGELOG_NOTIFICATION_POLICY`, per Ulanzi's RCA recommendation), `monthly` (at most once per 30 days — a suppressed update stays fully pending, nothing persisted, and opens at the first startup after the window passes), `never` (still persists `_lastSeenVersion` silently so switching back later doesn't replay an old release). The monthly window is anchored on the passthrough `_lastChangelogOpenedAt` key (epoch ms), stamped on **every** open under any policy so a later switch to `monthly` has a meaningful anchor. The PI control is a `sdpi-select` in the shared "Common Settings" accordion (`global-common-settings.ejs`, "Updates" group) with plain-language labels — no major/minor jargon.

The decision + orchestration are pure helpers in `@iracedeck/deck-core` (`version-check.ts`): `shouldOpenChangelog(current, lastSeen)`, `resolveChangelogDecision({ currentVersion, lastSeenVersion, policy, lastOpenedAt?, now })` → `"open" | "track-silently" | "defer" | "skip"`, `buildChangelogUrl({ ecosystem, deviceType })`, and `runVersionCheck({ currentVersion, lastSeenVersion, policy?, lastOpenedAt?, now?, ecosystem, deviceType?, isSimRunning?, persist, persistOpenedAt?, openUrl, logger })`. `runVersionCheck` persists FIRST so a flaky open never re-triggers next startup, then opens (failures are swallowed + logged) — with the #870 sim gate checked before the persist, since a persisted version would mark the release seen without it ever opening. The opener is injected per platform so `deck-core` stays platform-agnostic — Elgato passes `streamDeck.system.openUrl` via the concrete `adapter.openUrl`; Mirabox sends a best-effort `openUrl` VSD event (harmless if the Stream Dock host ignores it). The URL carries anonymous `ecosystem` (`getPluginPlatform()`, always) and best-effort `type` (device-type id; Elgato reads the connected device from `streamDeck.devices`, omitted otherwise) query params so the changelog page can tailor content.

Wired in every plugin's `runChangelogVersionCheck()` — scheduled with the #870 startup grace from the first-settings-arrival block (the `startupDefaultsApplied` one-shot) and re-run from `onIRacingTerminated` — in `plugin.ts`. The `openUrl` capability is a concrete method on each adapter (`ElgatoPlatformAdapter`, `VSDPlatformAdapter`, `UlanziPlatformAdapter`) — deliberately **not** on `IDeckPlatformAdapter`, to avoid touching every typed mock adapter.

## Binding-configured detection — `isConfigured` / `isBindingMissing` (#612)

A binding key counts as "configured" when **either** a keyboard binding **or** a SimHub role is set — independent of iRacing connection or SimHub reachability. `BindingDispatcher.isConfigured(settingKey)` is the source of truth (it parses the global setting via `parseBinding` + `isSimHubBinding`). `ConnectionStateAwareAction.isBindingMissing(keys: string | string[] | null | undefined)` builds on it: returns true when any required key is unconfigured, false for `null`/empty (api/chat/fixed-key modes). Use `isBindingMissing(<per-context key(s)>)` to drive the per-button missing-binding icon warning — never the shared `isActiveBindingMissing()`/`activeBindingKeys`, which is one value per action-class instance and bleeds across the action's buttons.

The PI `ird-binding-status` line shows the same configured/unconfigured state per mode (reading bindings from the *Related Key Bindings* `ird-key-binding` inputs). A mode bound to a SimHub role is "configured" even when SimHub isn't running — SimHub-not-running is surfaced separately as a live "SimHub not connected" caveat, not as a missing binding.
