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
<%- include('key-bindings-section', {
  keyBindings: require('./data/key-bindings.json').blackBox
}) %>
```

This renders the PI's whole bottom section: a "Key Bindings" header and the action's bindings in a collapsible `Related Key Bindings` accordion. Omit `keyBindings` for an action that has none — the section then says so rather than showing an empty accordion.

Since #1003 this is the **only** plugin-global surface left in an action PI. Every other global setting lives in the dedicated settings window; do not add one to a PI. The way through to that window is the "iRaceDeck Settings" button, which since #1024 renders from `action-settings-footer.ejs` higher up the page — not from this section.

### Other Global Settings

Author these in the settings window (`settings-window.ejs`, or the group partial it includes), not in an action PI. Use the `global` attribute on sdpi components:

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
- **No file** → ONE `adapter.getGlobalSettings()`; the first `didReceiveGlobalSettings` payload is salvaged, becomes the cache, and is written as the file ("Migrated global settings from the deck host"). If the host doesn't answer within `MIGRATION_TIMEOUT_MS` (10 s) the plugin starts fresh and writes a defaults file **carrying the passthrough marker `_migrationPending: true`** (`MIGRATION_PENDING_KEY`): on every later start such a file is treated as "ask the host again" — the read is re-issued, a real answer is merged UNDER the file (`mergeMigration`: the host supplies every key, the file wins only where it deviates from the schema default, so bindings the file never had come across while anything the user changed meanwhile survives), the marker clears and the file is rewritten; another silent 10 s keeps the marker and bumps its start count. After `MIGRATION_RETRY_STARTS` (3) unanswered starts the file is accepted as-is (warn-level log) so a host that genuinely never answers doesn't cost 10 s per launch. **The countdown marker then gives way to the durable `_migrationAbandoned` (`MIGRATION_ABANDONED_KEY`), which keeps the host mirror shut for good** — that is the #1041 fix, and the reasoning it replaced is worth keeping visible. The ceiling used to clear the marker and *resume* the mirror, so the next start wrote the plugin's defaults over a host copy nobody had ever read; on Ulanzi, where the read was blank-scoped and could not be answered at all, three ordinary starts with no deck attached took the marker to its ceiling and the FOURTH destroyed a user's pre-3.0 settings, silently and permanently. **Gate the mirror on having positively READ the host, never on a counter having run out.** The channel argument that justified resuming does not survive the case either: the marker is only ever set when the host answered nothing, and a host that answers nothing does not answer a Property Inspector's bootstrap read either — it is the same `getGlobalSettings` — so the channel the mirror would carry is unreachable by the only party that wants it. A real host answer deletes the marker, so an install recovers by itself once the host talks again; note that recovery needs the countdown to still be running, since the ceiling branch returns *before* issuing the read. Two boundaries to get right when reasoning about a rescue: the copy is intact through the first three starts and it is the fourth that used to destroy it, and a store that reached the ceiling is preserved but not restored. Fix an unanswered read at its source; do not reach for `MIGRATION_TIMEOUT_MS` or the retry count, which only widen a window that a broken read never enters. Without the marker a single slow host at first start would have persisted a defaults file that the NEXT start mirrored over the still-unread host copy, losing the pre-#993 settings from both places. A payload that arrives without having been asked for — a PI's save echo, or one racing the file load — is **ignored** for the cache and logged at debug; a host answer can never migrate over an existing file.
- **File unreadable** (a read error other than ENOENT — locked, permission denied) → retried with a doubling back-off (`LOAD_RETRY_DELAY_MS` = 1 s, then 2/4/8/16 s; `LOAD_ATTEMPTS` = 6, ~31 s in all — long enough for a scanner or backup agent holding the file at login to let go), then the session runs on schema defaults and **never saves**, logged at error. Note the settings window still opens in that state and echoes edits it cannot persist — a restart is the only cure. Fail closed on purpose: `save` replaces the file atomically, so writing defaults over settings we merely failed to READ would destroy them. The store never becomes ready, so every gate below stays closed.
- **File unparseable** → moved aside as `global-settings.corrupt-<iso>.json` and reported as "no file", so a user's file is never silently discarded. If the rename is refused (the file is held open, or the folder grants no rename), it is copied aside instead and the original is then deleted if that succeeds; a copy is skipped when a byte-identical aside already exists, so an undeletable corrupt file re-read on every start is preserved once, not once per start.

**Writes.** `updateGlobalSettings(partial)` / `deleteGlobalSettings(keys)` → merge → parse with salvage → cache → listeners → `store.save(cache)`. Read-your-writes is trivial (the cache is truth). The file write is **debounced** (250 ms, trailing) and **atomic** (temp file + rename), so a slider drag or a key-binding recording can't hammer the disk and no reader ever sees a partial file; `flush()` forces it out, and each plugin registers `process.on("exit", () => store.flushSync())` so the last debounced write still lands when the host stops the plugin (the Mirabox/Ulanzi clients call `process.exit(0)` on socket close, and an `exit` handler gets no event-loop turn — hence the synchronous variant). A write made before the store is ready updates the cache and notifies listeners as usual, and is additionally recorded and re-applied over the loaded/migrated settings — so a startup write (the audio-device list, the #610 elevation probe) is neither lost nor able to persist schema defaults over the file. No write path calls `adapter.setGlobalSettings`.

**One host write per start — the guarded mirror.** Each plugin's store-ready startup block (and the settings-window controller's `onStarted` hook) hands the loopback settings server's address — `{ port, token }`, once `settingsWindow.ensureStarted()` resolves — to the settings-channel publisher, which makes the plugin's ONE deck-host write of the run: `hostMirrorPayload({ port, token })` → `adapter.setGlobalSettings(mirror)`. The channel is added to that host mirror only — it is never written into the plugin-owned file (see *Passthrough keys the store introduces* below). The payload is the **full** cache plus `_settingsChannel`, never a partial: every host's `setGlobalSettings` **REPLACES** the whole stored object (that is the #896 history, and `scenario-harness/src/mock-platform-adapter.test.ts` asserts it), so a bare `{ _settingsChannel }` would truncate the host copy to one key — PIs blank, downgrade net gone. `hostMirrorPayload` returns `undefined`, and the write is skipped, when the store isn't ready, became ready via the migration timeout (`getSettingsStoreSource() === "fresh"`), still carries the `_migrationPending` countdown, or carries the durable `_migrationAbandoned` marker (#1041): in every one of those the host never answered the migration read, so the cache is schema defaults and mirroring it would clobber a copy the plugin never got to see. The last of them is the one that had been missing — the countdown clears itself at the ceiling, so without a durable marker "we gave up waiting" silently became "we may overwrite". The publish + mirror pair lives in `deck-core/src/settings-channel-publisher.ts` (`createSettingsChannelPublisher({ adapter, logger }).publish(channel)`), not in the plugins: each plugin hands `publish` both to the controller's `onStarted` hook (fired for whichever caller actually started the server — a failed startup bind followed by a successful "Open Settings" is still published) and to its store-ready `ensureStarted().then(...)` (a server that started before the store was ready is mirrored by this call). `publish` is idempotent per channel, retries the mirror on every call until it went out, and logs its own faults instead of letting a throwing settings listener masquerade as a server-start failure. Info lines (parameter-free, once per start): `Mirrored settings + channel to the deck host` / `Host mirror skipped: the store holds no host-derived settings yet`. Nothing else in the plugin calls `adapter.setGlobalSettings` — the host copy is read once for migration, then refreshed by this one mirror per start and otherwise left alone, so it stays the downgrade safety net.

**The mirror write can race the host connect (#993 phase 2 hardware finding).** `settingsWindow.ensureStarted()` can resolve before the plugin's own deck-host socket has finished opening — observed on Mirabox, where the log showed `Mirrored settings + channel to the deck host` land ~3s before `Connected to VSD Craft`. Both `VSDClient` (`deck-adapter-mirabox`) and `UlanziClient` (`deck-adapter-ulanzi`) silently drop any frame sent while their socket isn't open, so a mirror sent that early vanished — the host copy never got `_settingsChannel`, and every Mirabox PI bootstrapped against a channel-less host copy with an empty Diagnostics "Settings file" row. Both clients' `setGlobalSettings` now **defer until the socket is open, latest-wins**: a call made before `open` is stashed and flushed (after the register/handshake frame and the `getGlobalSettings` read) the moment `open` fires, and a later call before that always replaces the stashed one — only the newest snapshot matters since every caller sends the whole object. Elgato never needed this: its SDK's own `setGlobalSettings` awaits the connection internally.

**Property Inspectors read and write through the plugin too (#993 phase 2).** Every action PI carries a bridge script injected before `sdpi-components.js` — `pi-settings-bridge.js` on Elgato and Mirabox, the grown `ulanzi-pi-bridge.js` on Ulanzi — handing sdpi a wrapped socket. Both run the same shared state machine (`pi-components/src/settings-channel/router.ts`, `idle → bootstrapping → connecting → loopback`): when the host socket opens it sends ONE plain `getGlobalSettings` read (the bootstrap; on Ulanzi the write's own scope plus this PI's `actionid`, since that host answers a read only when `actionid` is non-empty — see the read/write asymmetry below), parses `_settingsChannel` out of the reply, opens `ws://127.0.0.1:<port>/ws?t=<token>` (token on the upgrade query, no cookie) and from then on routes `getGlobalSettings`/`setGlobalSettings` to the plugin and delivers the plugin's `didReceiveGlobalSettings` pushes to sdpi — **dropping the host's**, since the file is truth. Only those three frames are rerouted; `sendToPlugin`, `openUrl`, `logMessage`, per-action `getSettings`/`setSettings`/`didReceiveSettings`, `sendToPropertyInspector` and `registerPropertyInspector` pass through to the real host untouched. So window ↔ PI ↔ PI stay in sync live, and a PI edit lands in the plugin-owned file like any other write.

**On Ulanzi a read and a write need OPPOSITE scopes (#1039, #1041).** UlanziStudio buckets its persisted store by the frame's `uuid`, so a global-settings **write** must carry `PLUGIN_UUID` with a blank `key`/`actionid` or it scatters into a per-action bucket the plugin never reads back (#868). A **read** is the other way round: the host answers only when `actionid` is non-empty — it routes the reply by that field, echoing it rather than looking it up — while the bucket it hands back is the plugin-wide one whatever `uuid` was asked with. Measured across all six permutations against a live host: `actionid` alone decides whether any answer arrives, `key` alone does not, and `uuid` changes neither the answer nor the bucket. So **every** read is the write's scope plus an address: the same `PLUGIN_UUID`, the same blank `key`, and only `actionid` differs — the PI bridge sends this PI's own, with `PI_READ_ACTIONID` standing in when its URL carried none (#1039), and `UlanziClient` sends `PLUGIN_READ_ACTIONID` for the plugin's own reads, having no action context of its own (#1041). The two stand-in constants are deliberately different values and share nothing: two sockets asking for two different reasons, and a host trace should say which. `key` stays blank for the same reason `uuid` is kept: a host version that ever resolved the bucket from `uuid` and `key` would otherwise land on one no write populates. Note the limit of that argument — a host resolving the bucket from the FULL `uuid___key___actionid` context could not be satisfied by any addressed read at all, since the address is fabricated by construction. Matching two of the three fields buys what it can, not everything. Handing both directions one shared scope is exactly what broke every Ulanzi PI between #895 and #1039, and the damage did not stop at the bootstrap: the unanswered read timed out into a fallback that replayed the SAME unanswerable frame, so the guarantee below did not hold there either — the PI went blank rather than degrading. **The plugin's own read was the more expensive half** (#1041): it is the one-time migration read below, so a blank scope there did not blank a panel, it lost a user's pre-3.0 settings — see the `_migrationPending` paragraph for the three-start path by which that became permanent.

**Fallback, never a blank PI.** No `_settingsChannel` in the host's reply, a loopback connect that is refused, or a phase that doesn't settle within `BOOTSTRAP_TIMEOUT_MS` (3 s — armed on the bootstrap read AND on every connect attempt, so a stalled socket can't leave sdpi's `getGlobalSettings()` promise pending forever) drops the PI back to the host path with a `console.warn`; queued frames replay there — which keeps the PI populated only for as long as the host actually answers that replayed read, so a host with an addressing rule of its own (Ulanzi, above) has to satisfy it on the way out or this promise is void. **A fallen-back PI is only half alive:** it reads and writes the deck host's copy, and since the plugin ignores every host payload once its store is ready, an edit made there is shown as saved (the host echoes it) but never reaches the plugin or the file — and the next start's mirror overwrites the host copy with the store. So the fallback keeps the PI from going blank; it does not keep its global-settings edits. A PI opened in the seconds before the mirror write still switches **late**: a host push carrying a channel the router has not already tried starts a connect from `fallback`, and a push carrying a DIFFERENT channel while an attempt is still connecting (the previous run's stale channel was read first) supersedes that attempt on the spot. Every connect is a numbered attempt whose handlers go inert once the router closes or replaces its socket, so a stale socket's late close can never fall a newer attempt back. On switch-over, queued `setGlobalSettings` frames are **rebased**: sdpi built them from the host copy, so only keys that differ from that snapshot are sent (as a partial the fake host merges) and an unchanged snapshot is dropped — a host-era value never overwrites the store. A channel that was _refused_ (closed before it ever opened) or _stalled_ (the connect-phase settle timer fired with no `onOpen`/`onClose` at all) is not retried; one that opened and later closed is — a clean close is not a refusal. If the host socket itself closes before the bootstrap ever completed the router returns to `idle` so a retried connection can bootstrap again; from any later state it lands in `fallback`.

**The loopback guard is token-first.** `authorizeSettingsRequest` authorizes any request carrying the valid launch token **regardless of `Origin`** — PIs are `file://` pages (Origin `null`) or host-served origins, and the token is the secret (per-launch, 48 hex chars, reachable only through the window's URL and the plugin's own store). Without a token the original rules stand: `Origin`, when present, must equal the loopback origin exactly, and only then is the `SameSite=Strict` cookie compared — so the cookie path keeps its DNS-rebinding mitigation. No CORS header is ever emitted, and the bind stays `127.0.0.1`. Every upgrade decision reaches the controller through the server's `onUpgradeDecision` hook and is logged at debug: `Settings socket accepted (origin: …)` / `Settings socket rejected: <reason> (origin: …)`.

`_settingsStorePath` is published unconditionally (not inside the server's `then`, so a bind/firewall failure still leaves the path visible) for the Diagnostics "Settings file" row and its **Open folder** button — see `settings-window.md`.

**`isSettingsStoreReady()`** reports whether the cache reflects the store — loaded, migrated, or fresh. It replaced `hasReceivedHostSettings()`, which is **removed**. Before it flips, the cache is pure schema defaults with no passthrough keys, so anything that must not act on defaults gates on it: `focusIRacingIfEnabled()`, the one-shot key migrations in `global-settings-migrations.ts`, and each plugin's `startupDefaultsApplied` block. Any consumer deciding on the ABSENCE of a key must wait for it. `isGlobalSettingsInitialized()` is the weaker, different thing (`initGlobalSettings` has been called) — never use it as this gate.

**Per-key salvage stays.** Stored settings are parsed with `parseWithSalvage`: when the strict parse fails, the offending top-level keys are dropped (falling back to their schema defaults) and the parse retried, so one corrupt value can't stall every setting. Passthrough keys (bindings) are never validated, so they can never be dropped. It now guards a partially-bad **file** — hand-edited, or written by an older schema — instead of a partially-bad host payload.

**Changing a schema default still reaches new installs only.** Every write persists the whole _parsed_ cache, so each schema field's default is written into the file the first time any write happens — and one always does at startup (`_audioDeviceList`, `_settingsStorePath`). On an upgrade the migrated file carries whatever the host had, so existing installs keep their old values too. Flipping a `.default(...)` therefore changes behavior for fresh installs only; there is no way to tell a persisted default apart from a deliberate user choice, so reaching existing users needs an explicit one-shot migration guarded by a passthrough marker key (see `global-settings-migrations.ts` for the renames case). #930 flipped `focusIRacingWindow` to `true` accepting exactly this.

**Passthrough keys the store introduces:** `_settingsStorePath` (the resolved file path, shown on Diagnostics) — plugin-written, not a user setting. `_settingsChannel` (`{ port, token }`) is deliberately NOT stored in the file: it is per-process (a new port and token every start) and nothing reads it from the store, so the publisher removes a stale copy an older build left there and the channel travels only inside the deck-host mirror (which is what a PI's bootstrap read returns). `_warnings` is likewise never in the file, by a different mechanism and for a different reason — it is enrolled as a **run-scoped key** (#1014), see the section on it below. Both keys reach Property Inspectors again — `_settingsChannel` through the mirror, everything else through the loopback pushes — so a PI's Diagnostics row shows `_settingsStorePath` and `_warnings` / `_audioDeviceList` / `_deckDevices` are live there as well (once the PI has bootstrapped onto the loopback channel; a fallen-back PI sees only the once-per-start host mirror, not live pushes).

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

`"default"` means defer to the icon's `<desc>` title metadata default. These are configured in the settings window's Appearance tab under "Title Defaults" (#1003 moved them out of the per-action PIs). Use `getGlobalTitleSettings()` in action code to read them:

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

Plugin code can surface a banner at the top of every Property Inspector (issue #610). Warnings live in the `_warnings` global setting as a JSON array of `{ id, level, message }` records (`level` is `"info" | "warning" | "error"`). `_warnings` is a passthrough key — no `GlobalSettingsSchema` field is needed (same as `_audioDeviceList`) — and it is **run-scoped**: see below.

Manage warnings from `@iracedeck/deck-core`:

```typescript
import { setWarning, clearWarning, reconcileWarnings } from "@iracedeck/deck-core";

setWarning("elevation-mismatch", "warning", "…message…"); // upsert, keyed by id
clearWarning("elevation-mismatch");                         // remove by id

// One producer's whole family of ids, reconciled in a SINGLE write: every id
// in the scope is dropped, then the given records posted. Use it whenever one
// condition raises more than one banner (#1005) — a setWarning/clearWarning
// per id is one full global-settings write each, i.e. a store persist plus a
// synchronous fan-out to every onGlobalSettingsChange listener, per banner.
reconcileWarnings(["settings-window-server", "settings-window-open"], warnings);
```

Records are keyed by `id` so independent producers coexist. `setWarning` skips the write when an identical record already exists; `clearWarning` is a no-op when the id is absent; `reconcileWarnings` skips it when the scope's records already say what it would write (compared by content, not array order, so another producer posting after you is not a change). The `ird-warnings` PI web component (auto-injected by `head-common.ejs`) renders the array and prepends a per-level icon — so warning **messages must not start with their own emoji**. Banners are state-driven and not dismissible: a warning persists until its condition clears. A warning about one specific control belongs beside it rather than only in the top strip — see the `only`/`except` placement filters in `@.claude/rules/stream-deck-actions.md`; the settings-window **open** failure sits directly above the *iRaceDeck Settings* button wherever that button renders (#1024 moved it up under each action's own settings), while its page-wide **server** sibling stays in the strip (#1005). The settings window's own page withholds **both** of those ids (#1014): it is served BY the settings server, so the error denying that server exists is disproved by the page you are reading it on, and the open-failure note is advice about a button that page does not have. It does that by placing its own `<ird-warnings data-auto except="…">` as the body's first child, which suppresses the `head-common.ejs` injection rather than adding a second strip.

Reference producers, both in deck-core and both wired in every plugin's `plugin.ts`, and both following the same two-module split — a **pure** evaluator returning `PiWarning | null`, plus a thin adapter that is the only part touching the warning store:

- **Elevation mismatch** (#610) — `createElevationCheckSubscriber` wrapping `evaluateElevationWarning()` + the injected `getElevationStatus()`.
- **Unreachable settings window** (#1005) — `createSettingsWindowWarningReporter({ getStorePath })` wrapping `evaluateSettingsWindowWarning()`, wired as the settings-window controller's `onStatus` hook. Note the shape when a condition has several failure modes: the controller reports *what it tried and how it went* (`SettingsWindowStatus`) rather than deciding anything, because it is the only place that knows which stage failed — `open()` starts the server first, so it rejects both for a service that never bound and for a machine where no browser would open the page, and a caller's own `.catch` cannot tell those apart. The two modes get **separate ids** — not because they can coexist (they can't: `open()` starts the server first) but because **placement is keyed by id** and they belong in different parts of the page. The dead service is page-wide (`error`, top strip: with no channel every PI edit is inert), the failed open is about one button (`warning`, rendered directly above it). Where two exclusive conditions render in the SAME place, prefer one state-driven id that replaces itself; split only when they need different homes, and then make the reporter clear the sibling id so the user still never sees two banners for one broken thing.

### `_warnings` is run-scoped — never persisted (#1014)

`_warnings` is enrolled in `RUN_SCOPED_SETTING_KEYS` (`deck-core/src/run-scoped-settings.ts`), and every boundary an older value could cross back in through strips it:

- **into the cache** — `global-settings.ts` `becomeReady()` strips whatever filled it (file load, the one-time host migration, a fresh start), so a record from an earlier run or an earlier *version* can never be read back in;
- **out to the file** — everything handed to `SettingsStore.save()` goes through the single `persist()` funnel, so the key is never written and a file that already carries one is cleaned on the next save. A write touching *only* run-scoped keys skips the save altogether (`hasOnlyRunScopedKeys`): the stripped payload is byte-identical to what is on disk;
- **in from a UI** — the settings server strips them off every `setGlobalSettings` frame (`settings-window-server.ts`). No page is ever the producer of an observation about this run, and sdpi saves its WHOLE snapshot on any change — a snapshot that can predate the cache, because a Property Inspector bootstraps off the deck-host mirror before its first loopback push arrives.

Inside a run nothing changes: the key lives in the cache, fans out to `onGlobalSettingsChange`, and rides the once-per-start deck-host mirror. Be precise about what that last one buys on the **fallback path** (a UI with no loopback channel, reading the host copy and nothing else): it carries whatever was raised *before* the mirror went out — the settings-window failure banners, which is the case it exists for — but a run-scoped key written later in the run has no route there at all, and no longer arrives one run late the way a persisted copy used to. The elevation banner (raised on an iRacing connection, always after startup) is the one that loses by it; re-mirroring on change would be the fix if that ever matters.

It used to be an ordinary persisted key, and that let a record outlive both its condition and the producer that could retire it: a banner raised by one build reappeared under a build that had never heard of the id, with nothing in any UI able to dismiss it. Two consequences of the fix are worth knowing:

- **Retiring or renaming a warning id is no longer a breaking change.** No orphan can survive a restart, so a renamed id needs no `deleteGlobalSettings` cleanup.
- **Every producer must re-assert its state within the run** — that is the price of the guarantee. A producer that only speaks when something *changes* would go silent about a condition that is still true. The three today comply: the settings-window reporter reports at `ensureStarted()` on every start, `validateSetupWarningPatterns` runs on the first settings arrival and on every change after it, and the elevation probe runs on each iRacing connection (so after a restart its banner is correctly absent until there is a live sim to compare integrity levels with). Wire a new producer the same way, and add its re-assertion to `plugin.ts` in all three plugins.

Enrol another key only when it is genuinely an *observation about this run* rather than a user choice. Membership is an explicit list, not a naming convention — plenty of `_`-prefixed keys are durable (`_lastSeenVersion`, `_lastChangelogOpenedAt`), and getting that backwards silently loses user state.

## Version-upgrade changelog — `_lastSeenVersion` + `runVersionCheck` (#680, #742, #870, #901)

On the first global-settings arrival each startup, every plugin compares the running plugin version (`getPluginVersion()`) against the last version the user saw, stored in the passthrough `_lastSeenVersion` key. When a strictly newer **stable** version is detected (a first install with nothing stored also counts), the plugin persists the running version and opens the website changelog (`CHANGELOG_BASE_URL` = `https://iracedeck.com/changelog/`) in the user's default browser — exactly once per upgrade. Pre-release builds (`-dev`, `-rc`) and same/older versions are inert: no open, and the stored value is never lowered (it tracks the highest stable version seen). `_lastSeenVersion` is a passthrough key — no `GlobalSettingsSchema` field is needed (same as `_warnings` / `_audioDeviceList`).

**The changelog never opens while iRacing is running** (issue #870 — a deck-host auto-update restarts the plugin mid-session, and the page must not pop over a live race). `runVersionCheck` takes an optional `isSimRunning` delegate consulted only when an `open` is actually due: when it reports true the open **defers** — nothing persisted, the version stays pending — with `track-silently` outcomes unaffected (nothing opens anyway). Plugins pass `isIRacingActive` from `app-monitor.ts` (running-flag OR live SDK connection — the two signals cover each other's gaps) and re-run the check from the app monitor's `onIRacingTerminated` hook. Exit detection has two paths: the host's `applicationDidTerminate` event, whose handler notifies **after** the running flag and SDK connection are already down (`setReconnectEnabled(false)` actively disconnects — wrapped in try/catch so a throwing telemetry subscriber in its fan-out can't swallow the notification); and the **SDK-disconnect fallback** for hosts that never deliver app-monitoring events (UlanziStudio maps none; Mirabox delivery is unproven) — a lost SDK connection sustained for `IRACING_EXIT_SDK_CONFIRM_MS` (5 s) counts as the exit, deduped per episode against the event path, skipped when an event-set running flag says iRacing still runs (an SDK blip), and clearing a connection-derived running flag whose only evidence was that connection. An adapter that never delivers the events declares `supportsApplicationMonitoring = false` on `IDeckPlatformAdapter` (Ulanzi does); the app monitor then keeps SDK reconnect polling enabled at startup — otherwise the SDK could never attach when iRacing starts after the plugin, starving both telemetry and the fallback of their signal. The startup check itself is delayed by `VERSION_CHECK_STARTUP_GRACE_MS` (15 s, exported from `version-check.ts`) because on a mid-session restart the launch event / SDK connection race the first settings arrival — an immediate check could read "not running" and open over the session. Each plugin wraps all of this in one `runChangelogVersionCheck()` that re-reads the **live** settings cache per call, guarded on `startupDefaultsApplied` so a terminate before the first settings arrival is a no-op; the terminate listener is additionally gated on `shouldOpenChangelog` so once the version is persisted (or on a pre-release build) later sim exits don't re-run a dead check and re-log "Version up to date" forever. User-facing behavior is documented on the website: `docs/features/whats-new-page.md`.

**When a due changelog actually opens is user-configurable** (issue #742) via the `changelogNotification` schema field (`z.enum(CHANGELOG_NOTIFICATION_POLICIES).default(DEFAULT_CHANGELOG_NOTIFICATION_POLICY).catch(...)` — the values array and the default constant live in `version-check.ts` so schema and logic share one source of truth, and the `.catch` keeps a malformed persisted value from aborting the whole settings parse): `always` (every stable update — the default until #901), `features` (major/minor bumps only; patch releases persist `_lastSeenVersion` silently — the default since #901, `DEFAULT_CHANGELOG_NOTIFICATION_POLICY`, per Ulanzi's RCA recommendation), `monthly` (at most once per 30 days — a suppressed update stays fully pending, nothing persisted, and opens at the first startup after the window passes), `never` (still persists `_lastSeenVersion` silently so switching back later doesn't replay an old release). The monthly window is anchored on the passthrough `_lastChangelogOpenedAt` key (epoch ms), stamped on **every** open under any policy so a later switch to `monthly` has a meaningful anchor. The control is a `sdpi-select` on the settings window's What's New tab (`global-common-updates.ejs` — the pane id is `updates`, the visible label is What's New) with plain-language labels — no major/minor jargon.

The decision + orchestration are pure helpers in `@iracedeck/deck-core` (`version-check.ts`): `shouldOpenChangelog(current, lastSeen)`, `resolveChangelogDecision({ currentVersion, lastSeenVersion, policy, lastOpenedAt?, now })` → `"open" | "track-silently" | "defer" | "skip"`, `buildChangelogUrl({ ecosystem, deviceType })`, and `runVersionCheck({ currentVersion, lastSeenVersion, policy?, lastOpenedAt?, now?, ecosystem, deviceType?, isSimRunning?, persist, persistOpenedAt?, openUrl, logger })`. `runVersionCheck` persists FIRST so a flaky open never re-triggers next startup, then opens (failures are swallowed + logged) — with the #870 sim gate checked before the persist, since a persisted version would mark the release seen without it ever opening. The opener is injected per platform so `deck-core` stays platform-agnostic — Elgato passes `streamDeck.system.openUrl` via the concrete `adapter.openUrl`; Mirabox sends a best-effort `openUrl` VSD event (harmless if the Stream Dock host ignores it). The URL carries anonymous `ecosystem` (`getPluginPlatform()`, always) and best-effort `type` (device-type id; Elgato reads the connected device from `streamDeck.devices`, omitted otherwise) query params so the changelog page can tailor content.

Wired in every plugin's `runChangelogVersionCheck()` — scheduled with the #870 startup grace from the first-settings-arrival block (the `startupDefaultsApplied` one-shot) and re-run from `onIRacingTerminated` — in `plugin.ts`. The `openUrl` capability is a concrete method on each adapter (`ElgatoPlatformAdapter`, `VSDPlatformAdapter`, `UlanziPlatformAdapter`) — deliberately **not** on `IDeckPlatformAdapter`, to avoid touching every typed mock adapter.

## Binding-configured detection — `isConfigured` / `isBindingMissing` (#612)

A binding key counts as "configured" when **either** a keyboard binding **or** a SimHub role is set — independent of iRacing connection or SimHub reachability. `BindingDispatcher.isConfigured(settingKey)` is the source of truth (it parses the global setting via `parseBinding` + `isSimHubBinding`). `ConnectionStateAwareAction.isBindingMissing(keys: string | string[] | null | undefined)` builds on it: returns true when any required key is unconfigured, false for `null`/empty (api/chat/fixed-key modes). Use `isBindingMissing(<per-context key(s)>)` to drive the per-button missing-binding icon warning — never the shared `isActiveBindingMissing()`/`activeBindingKeys`, which is one value per action-class instance and bleeds across the action's buttons.

The PI `ird-binding-status` line shows the same configured/unconfigured state per mode (reading bindings from the *Related Key Bindings* `ird-key-binding` inputs). A mode bound to a SimHub role is "configured" even when SimHub isn't running — SimHub-not-running is surfaced separately as a live "SimHub not connected" caveat, not as a missing binding.
