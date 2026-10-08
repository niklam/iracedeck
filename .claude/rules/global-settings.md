---
paths:
  - "packages/app-constants/src/**"
  - "packages/callout-settings/src/**"
  - "packages/settings/src/**"
  - "packages/deck-core/src/**"
  - "packages/settings-window/src/**"
  - "packages/app-updates/src/**"
  - "packages/diagnostics/src/**"
  - "packages/replay-store/src/**"
  - "packages/voice-packs/src/**"
  - "packages/pi-components/src/**"
  - "packages/pi-components/partials/**"
  - "packages/iracing-actions/src/actions/settings-window/**"
  - "packages/iracing-plugin-*/**"
  - "packages/plugin-runtime/**"
  - "packages/scenario-harness/src/**"
---

# Global Settings

## Overview

Global settings are plugin-level, shared across all action instances: key bindings (keyboard or SimHub), plugin-wide preferences, SimHub host/port. Per-instance things (mode, action-specific options) are action settings.

## Binding Types

```typescript
// Keyboard binding (type defaults to "keyboard" for backward compatibility)
type KeyBindingValue = { type: "keyboard"; key: string; modifiers: string[]; code?: string; displayKey?: string };
// SimHub Control Mapper role binding
type SimHubBindingValue = { type: "simhub"; role: string };
type BindingValue = KeyBindingValue | SimHubBindingValue;
isSimHubBinding(value: BindingValue | null | undefined): value is SimHubBindingValue
```

## Property Inspector Usage

`ird-key-binding` with the `global` attribute stores into global settings; each binding has a Keyboard/SimHub dropdown:

```html
<sdpi-item label="Lap Timing Key">
  <ird-key-binding setting="blackBoxLapTiming" default="F1" global></ird-key-binding>
</sdpi-item>
```

An action PI shows its own bindings through the partial below, which renders the "Key Bindings" header and a `Related Key Bindings` accordion (or, with `keyBindings` omitted, a line saying there are none). Since #1003 this is the **only** plugin-global surface in an action PI — every other global setting is authored in the settings window (`settings-window.ejs` or a group partial it includes) with the `global` attribute on sdpi components; never add one to a PI. The "iRaceDeck Settings" button renders from `action-settings-footer.ejs` (#1024), not from this section.

```ejs
<%- include('key-bindings-section', {
  keyBindings: require('./data/key-bindings.json').blackBox
}) %>
```

## Action Code Usage

```typescript
import { parseBinding } from "@iracedeck/deck-core";
import { getGlobalSettings, onGlobalSettingsChange } from "@iracedeck/settings";

// Preferred, in a ConnectionStateAwareAction — routes to keyboard or SimHub
this.setActiveBinding("blackBoxLapTiming"); // readiness tracking
await this.tapBinding("blackBoxLapTiming");
await this.holdBinding(ev.action.id, settingKey);
await this.releaseBinding(ev.action.id);

// Low-level read
const binding = parseBinding((getGlobalSettings() as Record<string, unknown>)["blackBoxLapTiming"]);
// KeyBindingValue | SimHubBindingValue | undefined

const unsubscribe = onGlobalSettingsChange((settings) => { /* … */ });
unsubscribe(); // required on cleanup (e.g. onWillDisappear) — a listener stays registered until removed
```

### GlobalSettingsSchema

Validated with Zod in `settings/src/global-settings.ts`, with `.passthrough()` so dynamic binding keys (`blackBoxLapTiming`, `lookDirectionLeft`) need no schema field:

```typescript
const GlobalSettingsSchema = z.object({
  disableWhenDisconnected: z.union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(true)
    .catch(true),
  simHubPort: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.coerce.number().min(1).max(65535).default(8888).catch(8888),
  ),
  // … focusIRacingWindow: "always" | "required" | "never" (#977), debugLogging (#609), simHubHost, …
}).passthrough();
```

**Every plain-value schema field must end in `.catch(<default>)`** (or be otherwise throw-proof, like the union+transform booleans and the `preprocess`-guarded strings). A single throwing field aborts the entire settings parse, which stalls the cache at defaults and makes every key binding look unset (#896). Follow the `spotterStillThereSeconds` / `changelogNotification` precedent.

## Single writer — the plugin-owned settings store (#993)

**The plugin owns global settings; the deck host does not.** One JSON file per ecosystem — `%LOCALAPPDATA%\iRaceDeck\Settings\<Stream Deck|Mirabox|Ulanzi>\global-settings.json`, from `resolveSettingsStorePath()`, overridable with `IRACEDECK_SETTINGS_PATH` (a full file path) — outside every host's plugin folder, so settings survive reinstalls and ecosystems never share state. The host's store is read **at most once per plugin version** (to migrate an install with no file, and once more if a newer version finds a file an older one gave up migrating, #1047) and otherwise ignored. The two-writer machinery — the #896 first-arrival gate, the pending-write overlay and its reconciliation, `lastHostSettings`/the shrink guard, the Ulanzi adapter's write gate — was deleted in #993; don't reintroduce it. Design: `docs/superpowers/specs/2026-08-16-issue-993-plugin-owned-settings-store-design.md`.

The store is `initGlobalSettings`'s required third argument, created before it with `createFileSettingsStore({ path: resolveSettingsStorePath({ platform: getPluginPlatform(), env: process.env }), logger, onRejected: createSettingsFileRejectionReporter() })`; pass `{ pluginVersion: getPluginVersion() }` as the fourth (`@.claude/rules/plugin-structure.md` has the full init order). `createMemorySettingsStore()` is for tests and the scenario harness.

**Startup.** `initGlobalSettings` returns the default cache immediately and loads in the background; listeners fire once when the cache first reflects the store.

- **File present** → parsed with per-key salvage → cache → listeners, then re-saved (heals salvage-dropped keys).
- **No file** → ONE `adapter.getGlobalSettings()`; the first `didReceiveGlobalSettings` payload is salvaged, becomes the cache and is written as the file. No answer within `MIGRATION_TIMEOUT_MS` (10 s; see the deadline paragraph below) → start fresh with a defaults file carrying the passthrough marker `_migrationPending` (`MIGRATION_PENDING_KEY`). Each later start re-issues the read for such a file; a real answer is merged UNDER the file by `mergeMigration` (host supplies every key, the file wins only where it deviates from the schema default), the marker clears; another silent timeout bumps its start count. Without the marker, one slow first start would persist defaults that the next start mirrored over the unread host copy. **On Elgato the answer arrives through the adapter, not the SDK event (#1208):** since `@elgato/streamdeck` 3.0 the SDK's `onDidReceiveGlobalSettings` carries only a PI's save, and a read's reply reaches only the promise `getGlobalSettings()` returns — so `ElgatoPlatformAdapter.getGlobalSettings()` hands that result to its `onDidReceiveGlobalSettings` subscribers itself, once per read, dropping the promise's value when it is the very frame the event just delivered (a PI save landing while the read is pending resolves both). Never set `streamDeck.settings.useLegacySettingsBehavior`: it would deliver the reply twice, once down each path, and `eslint.config.js` refuses the property.
- **Give-up (#1041).** After `MIGRATION_RETRY_STARTS` (3) unanswered starts the file is accepted as-is (warn log) and the countdown is replaced by the durable `_migrationAbandoned` (`MIGRATION_ABANDONED_KEY`), which **keeps the host mirror shut for good**. **Gate the mirror on having positively READ the host, never on a counter having run out** — resuming it at the ceiling wrote defaults over a host copy nobody had read and destroyed users' settings.
- **Re-ask once per version (#1047).** `_migrationAbandoned` stores the VERSION that gave up (not `true`) — that is what un-sticks it. A given-up store — the marker, OR a countdown already at the ceiling — issues one read when the running version is semver-`gt` the recorded one; whatever comes back, that start records its own give-up. Never a bare `!==` (a downgraded pair would re-ask forever). A `true` or missing record is retried. The version comes through `InitGlobalSettingsOptions.pluginVersion`, not `getPluginVersion()` (which throws without `initPluginConfig()`); with none supplied an abandoned store is left alone. Spec: `docs/superpowers/specs/2026-08-28-issue-1047-abandoned-migration-retry.md`.
- **Retrying belongs in the load path — never make the mirror gate conditional instead.** Wrong in the load path costs a timeout; wrong in the gate costs a user's settings. Fix an unanswered read at its source; never widen `MIGRATION_TIMEOUT_MS` or `MIGRATION_RETRY_STARTS`. Deleting the settings file re-runs the migration from scratch.
- **Unrequested payloads** (a PI's save echo, one racing the file load) are **ignored** for the cache and logged at debug; a host answer never migrates over an existing file. "Requested" is only the boolean `migrationRequested`: while it is set the FIRST payload is taken as the answer whatever sent it — accepted, not fixed (#1053, `docs/superpowers/specs/2026-08-30-issue-1053-migration-read-payload-correlation.md`). On Mirabox/Ulanzi the client's unconditional connect-time read often answers in place of the settings layer's dropped one; both reads are load-bearing. Only the give-up retry's merge (`{ ...host, ...file }`) bounds a stray payload; `mergeMigration` bounds nothing, acceptable only because those paths have no user settings to lose.
- **File unreadable** (error other than ENOENT) → retried with doubling back-off (`LOAD_RETRY_DELAY_MS` 1 s → 16 s, `LOAD_ATTEMPTS` 6, ~31 s), then the session runs on defaults and **never saves** (error log). Fail closed: `save` replaces atomically, so writing defaults over settings we failed to READ destroys them. The store never becomes ready; the settings window still opens and echoes edits it cannot persist — only a restart cures it.
- **File unparseable** → moved aside as `global-settings.corrupt-<iso>.json` and treated as no file. A refused rename falls back to copy-then-delete; the copy is skipped when a byte-identical aside exists, and an older aside that cannot be read is skipped rather than aborting the copy. **A file that cannot be preserved at all fails the read** (#1036) and takes the unreadable path above — reporting it as "no file" would run the migration into a save that replaces the only copy. **Keep the re-migration** (#1036): since #993's once-per-start mirror the host copy is normally the settings as of the last good start, so treating the file as absent is a restore, and refusing it lands on schema defaults. What the user lacked was the explanation, so the store's `onRejected` hook raises the `settings-file-rejected` banner (below) naming the parser's reason, the aside, and a line and column from `locateJsonError` — **never parse the position out of the V8 message**: Node 20 (Mirabox, Ulanzi) prints only an offset, and `Unexpected token` messages print none on any version. **Never tolerate trailing commas or other JSON5** — a BOM carries no meaning, a comma is structure, and the load-time re-save would write the guess back into the user's file. A UTF-8 or UTF-16LE BOM is decoded (`decodeSettingsText`; Windows PowerShell 5.1's `Out-File` and `>` write UTF-16LE). The **unreadable** path has no banner yet: the store never becomes ready, so the mirror never runs and a fallen-back PI can see nothing; only a settings window opened by a press would, which is a separate design. Spec: `docs/superpowers/specs/2026-08-27-issue-1036-settings-file-rejection-banner.md`.

**What the migration deadline is measured FROM (#1056).** `MIGRATION_TIMEOUT_MS` is armed when the read is issued and **extended exactly once**, by whichever comes first: the host becoming usable (`adapter.onHostReady?.(...)`, an optional `SettingsHost` member that `IDeckPlatformAdapter` inherits) or the budget expiring while a subscribed `onHostReady` has not fired. One shared flag, so at most twice the budget. Only the Mirabox/Ulanzi adapters implement `onHostReady` (they drop frames sent before their socket opens); Elgato's SDK awaits the connection inside `send`, so its deadline is already honest. **Extend, never relocate:** arming only on connect means a host that never connects never times out, counts down or abandons. Don't try to grant the grace only to a host still connecting — a mid-handshake host and one that never upgrades both read `CONNECTING`. Accepted cost: the store can be un-ready ~2× the budget, with bindings reading unset, both focus sites skipping, the store-ready block not run, and a PI opened then falling back to the host copy and losing its edits. Spec: `docs/superpowers/specs/2026-08-31-issue-1056-migration-deadline-armed-before-connect.md`.

**Writes.** `updateGlobalSettings(partial)` / `deleteGlobalSettings(keys)` → merge → parse with salvage → cache → listeners → `store.save(cache)`. The cache is truth. The file write is **debounced** (250 ms, trailing) and **atomic** (temp + rename); `flush()` forces it, and each plugin registers `process.on("exit", () => store.flushSync())` (`exit` handlers get no event-loop turn, hence sync). A write before the store is ready updates cache and listeners and is re-applied over the loaded/migrated settings, so it is neither lost nor able to persist defaults. **No write path calls `adapter.setGlobalSettings`.**

**One host write per start — the guarded mirror.** The settings-channel publisher (`settings-window/src/settings-channel-publisher.ts`, `createSettingsChannelPublisher({ adapter, logger }).publish(channel)`) makes the plugin's ONE host write per run: `hostMirrorPayload({ port, token })` → `adapter.setGlobalSettings(mirror)`. Each plugin hands `publish` to the settings-window controller's `onStarted` hook AND calls it from the store-ready `ensureStarted().then(...)`; never hand-roll it. The payload is the **full** cache plus `_settingsChannel`, never a partial — every host's `setGlobalSettings` REPLACES the whole object (`scenario-harness/src/mock-platform-adapter.test.ts` asserts it). `hostMirrorPayload` returns `undefined` (write skipped) when the store isn't ready, became ready by migration timeout (`getSettingsStoreSource() === "fresh"`), or carries `_migrationPending` or `_migrationAbandoned` — the host was never read, so mirroring would clobber it. That condition is one exported predicate, `isSettingsStoreHostDerived()` (also false when the file failed to parse at all), shared with the binding-default seed below; don't restate it. The mirror is its binding consumer: relaxing it for any other caller re-opens the #1041 data loss, so a caller that wants a looser rule writes its own predicate. `getSettingsStoreHostDerivation()` names the reason it is false (`not-ready` / `not-read-yet` / `abandoned` / `unparseable`) for a caller that must report it; the boolean is defined as its `host-derived` case, so the two cannot disagree. `publish` is idempotent per channel, retries until the mirror went out, and logs its own faults (`Mirrored settings + channel to the deck host` / `Host mirror skipped: the store holds no host-derived settings yet`). The host copy is otherwise left alone as the downgrade safety net.

**The mirror can race the host connect.** `VSDClient` and `UlanziClient` silently drop frames sent before their socket is open, so both clients' `setGlobalSettings` **defer until open, latest-wins** (flushed after the register/handshake frame and the `getGlobalSettings` read). Elgato's SDK awaits internally.

**Property Inspectors read and write through the plugin (#993 phase 2).** The build injects a bridge before `sdpi-components.js` in every action PI (`pi-settings-bridge.js` on Elgato/Mirabox, `ulanzi-pi-bridge.js` on Ulanzi), both running `pi-components/src/settings-channel/router.ts` (`idle → bootstrapping → connecting → loopback`, `fallback`). It sends ONE bootstrap `getGlobalSettings` on host-socket open, reads `_settingsChannel`, opens `ws://127.0.0.1:<port>/ws?t=<token>` (token on the query, no cookie), then routes `getGlobalSettings`/`setGlobalSettings` to the plugin and delivers the plugin's `didReceiveGlobalSettings` — **dropping the host's**. Only those three frames are rerouted; everything else (`sendToPlugin`, `openUrl`, `logMessage`, per-action settings frames, `sendToPropertyInspector`, `registerPropertyInspector`) goes to the host untouched.

**On Ulanzi a read and a write need OPPOSITE scopes (#1039, #1041).** A **write** carries `PLUGIN_UUID` with blank `key`/`actionid`, or it lands in a per-action bucket the plugin never reads (#868). A **read** is answered only when `actionid` is non-empty, and returns the plugin-wide bucket for any iRaceDeck `uuid` (a foreign uuid gets no reply; an empty registered bucket is unmeasured). A populated reply has no `code` field, so the ack drop-filter keeps it. So every read is the write's scope plus an address — same `PLUGIN_UUID`, blank `key`, only `actionid` set: the PI bridge sends its own (`PI_READ_ACTIONID` if its URL had none), `UlanziClient` sends `PLUGIN_READ_ACTIONID`; the two stand-ins are deliberately different values. **Never give both directions one shared scope** — that blanked every Ulanzi PI and, on the migration read, lost pre-3.0 settings. Specs: `docs/superpowers/specs/2026-08-28-issue-1039-ulanzi-pi-global-settings-read-scope.md`, `docs/superpowers/specs/2026-08-28-issue-1041-ulanzi-plugin-migration-read-scope.md`.

**Fallback, never a blank PI.** No `_settingsChannel`, a refused loopback connect, or a phase not settled within `BOOTSTRAP_TIMEOUT_MS` (3 s, armed on the bootstrap read AND every connect attempt) drops the PI to the host path with a `console.warn`; queued frames replay there, so the replayed read must still satisfy the host's addressing (Ulanzi, above). **A fallen-back PI is half alive:** its edits show as saved but the plugin ignores host payloads once ready, and the next mirror overwrites them. A host push with an untried channel starts a connect from `fallback`; a DIFFERENT channel while connecting supersedes the attempt; attempts are numbered so a stale socket's late close is inert. On switch-over queued `setGlobalSettings` frames are **rebased** — only keys differing from the host snapshot are sent, as a partial; an unchanged snapshot is dropped. A _refused_ (closed before open) or _stalled_ (settle timer fired with no `onOpen`/`onClose`) channel is not retried; opened-then-closed is. A host socket closing before bootstrap completes returns to `idle`; later, to `fallback`.

**The loopback guard is token-first.** `authorizeSettingsRequest` accepts any request carrying the valid launch token **regardless of `Origin`** (PIs are `file://` or host-served). Without a token, `Origin` (when present) must equal the loopback origin exactly, and only then is the `SameSite=Strict` cookie compared — the DNS-rebinding mitigation. Never emit a CORS header; bind `127.0.0.1` only. `onUpgradeDecision` reports every upgrade verdict, logged at debug (`Settings socket accepted/rejected …`).

`_settingsStorePath` is published unconditionally (not inside the server's `then`), for the Diagnostics "Settings file" row — see `settings-window.md`.

**`isSettingsStoreReady()`** — true once the cache reflects the store (loaded, migrated or fresh); replaced the removed `hasReceivedHostSettings()`. Before it, the cache is schema defaults with no passthrough keys, so anything that must not act on defaults gates on it: `focusIRacingIfEnabled()`, `focusIRacingBeforeInput()`, the migrations and the binding-default seed in `global-settings-migrations.ts` (both through `runOnceSettingsStoreReady(action)`, which runs the action once at the first ready moment and marks itself done BEFORE calling it, since a write fans out to the change listeners synchronously), the `startupDefaultsApplied` block in `plugin-runtime`'s settings phase. **Any consumer deciding on the ABSENCE of a key must wait for it.** Never use `isGlobalSettingsInitialized()` (init was called) as this gate.

**`whenSettingsStoreSettled()`** (#1034) is a WAIT, not a gate: a never-rejecting promise resolving once the load SETTLED — ready by any path, the fail-closed give-up, or a throw while applying loaded settings. Ready stays false on the failure paths, so gate on ready to avoid acting on defaults; await this when defaults are an acceptable outcome (the voice-pack launch step, which must see `_devBaseUrl` and must still get a voice when settings are unreadable). It is **re-armed per run** by `initGlobalSettings` / `_resetGlobalSettings`, and resolves immediately once already settled; take it AFTER init — hence the launch step's `settled` dep is a THUNK.

**Per-key salvage.** `parseWithSalvage` drops offending top-level keys (back to their defaults) and retries, so one corrupt value can't stall every setting. Passthrough keys are never validated, so never dropped.

**Changing a schema default reaches new installs only.** Every write persists the whole parsed cache (and one always happens at startup), so defaults are written into the file and are indistinguishable from user choices. Reaching existing users needs an explicit one-shot migration guarded by a passthrough marker key (`global-settings-migrations.ts`).

**Binding defaults an existing feature starts to need are seeded if absent (#1277).** A binding is otherwise written only by its PI field, which saves its default when it mounts over nothing — so when a feature that needed no binding starts to (Cycle by Track Order now taps iRacing's Next / Previous Car), a user who never opened that panel has nothing stored and gets the #612 warning. `seedBindingDefaultsIfAbsent(defaults, logger)` (`global-settings-migrations.ts`) takes a key → default-string map from the caller (Track Order's is `CAR_CYCLE_BINDING_DEFAULTS` in iracing-actions: `V` / `Shift+V` as literals, cross-checked against both `key-bindings.json` sections) and, once the store is ready, writes each key that has **never been stored** (`undefined` in the cache) as the exact string the field would have saved (`defaultBindingStoredValue`). That is the field's own parser, not a twin: the key map and `parseDefaultKeyBinding` live once, in `@iracedeck/app-constants`' `key-binding-defaults.ts`, which pi-components bundles into the Property Inspector too. A default naming no key is skipped with a warning — the field would save `""`, but a stored `""` reads as a cleared binding and would never be seeded again. "Seeded default key bindings" is logged only for keys the cache holds after the write; a rejected write is a warning. Any stored value is kept, a cleared `""` included — though the PI field itself re-saves its default when it mounts over `""`, so a cleared binding lasts only until that panel next opens. Idempotent with no marker; every plugin calls it at every start beside `migrateGlobalSettingsKeys`. It writes only when `isSettingsStoreHostDerived()`: on a fresh, pending, abandoned or unparseable store absence proves nothing, and a later host answer merges with the file winning for passthrough keys, so a seeded default would permanently override the user's own binding — a store not read YET is seeded by the start whose host answer lands. **An abandoned store (`_migrationAbandoned`, #1041) is excluded, deliberately:** its marker clears only when a later upgrade's retry gets a real host answer, so it may never be seeded, and those users see the #612 warning until they open a panel with the binding field. Seeding them would mean letting the host win over the file for seeded keys in the migration merge — a change to this write path for a small group, declined in the spec. The seed's log line says so rather than promising a later seed. Passthrough keys only, like the renames: a schema field always holds its default. Spec: `docs/superpowers/specs/2026-09-28-issue-1277-track-order-uses-iracing-next-car.md`.

**The Race Engineer voice migrates with no marker, because it can tell done from not-done (#1144).** `raceEngineerVoice` stores a composite `<pack id>::<voice id>` (`DEFAULT_RACE_ENGINEER_VOICE` = `default::default`). `migrateRaceEngineerVoiceId(availableVoices, logger)` qualifies a stored bare id with `@iracedeck/callout-script`'s `qualifyVoiceId`: empty or composite → unchanged; bare but itself available → unchanged; else `default::<id>` if the managed pack has it; else the alphabetically first pack that has it; else unchanged. It gates on `isSettingsStoreReady()` AND on the managed pack being in the scan (some `default::…` available), and writes only when the value changes — idempotent, so plugins call it after every scan and every settings arrival, right before the missing-script re-assert. `resolveActiveRaceEngineerVoice` applies the same rule read-only. **Never widen it into a fallback:** rewriting a value no pack provides destroys the user's choice on a scan that merely failed to read a pack (same rule as `ird-voice-select`, `@.claude/rules/stream-deck-actions.md`). Spec: `docs/superpowers/specs/2026-09-08-issue-1144-voice-id-namespacing.md`.

**Passthrough keys the store introduces:**

- `_settingsStorePath` — the resolved file path; plugin-written.
- `_firstRunVersion` (#1061) — the version that resolved the Getting Started decision; a version not `true`, written on every resolution, and **never** run-scoped (the page would reappear every start).
- `_migrationPending` / `_migrationAbandoned` — both **must persist**; never route `_migrationAbandoned` into a store anyone is told is safe to delete.
- `_settingsChannel` (`{ port, token }`) — **never in the file** (per-process; the publisher removes a stale copy); it exists only in the host mirror, which is what a PI's bootstrap read returns.
- `_voiceLabels` (#1034) — persisted, keyed by composite voice id, published in the same `updateGlobalSettings` call as `_raceEngineerVoices` and sharing its lifetime.
- `_warnings` — run-scoped, never in the file (below).

A bootstrapped PI receives these live through loopback pushes; a fallen-back PI sees only the once-per-start mirror.

Diagnostics: with `debugLogging` on, the module logs the store path and key count on load, the raw host payload during migration, every ignored host payload, salvage-dropped keys, and each `Settings saved: <path>`.

## Title Settings Keys

Plugin-level title defaults, flat keys read via `getGlobalTitleSettings()` and set on the settings window's Appearance tab (#1003):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `titleShowTitle` | boolean | `true` | Show title text on key |
| `titleShowGraphics` | boolean | `true` | Show graphics on key |
| `titleBold` | string | `"default"` | `"default"`, `"true"`, `"false"` |
| `titleFontSizeDefault` | boolean | `true` | Use icon default font size (hides range when true) |
| `titleFontSize` | number | `9` | PI units (5–100, doubled for SVG) |
| `titlePosition` | string | `"default"` | `"default"`, `"top"`, `"middle"`, `"bottom"`, `"custom"` |
| `titleCustomPosition` | number | `0` | Custom offset (−100 to +100) |

`"default"` defers to the icon's `<desc>` title metadata. In action code: `resolveTitleSettings(graphicSvg, getGlobalTitleSettings(), settings.titleOverrides, "DEFAULT\nTITLE")`.

## Radio Frame switches — `frameOptionsFromSettings()`

`raceEngineerRadioBeeps` and `raceEngineerPitAmbience` (#1064) are read ONLY through `frameOptionsFromSettings(settings)` → `{ beeps, ambience }`: off only for an explicit `false` / `"false"`, otherwise on, so a wrong reading fails towards the full frame. Every reader uses it — the plugins' `getFrameOptions`, the Background preview's `readFrameOptions`, the scenario harness; don't write another `!== false` pair. Its return type is the structural `RadioFrameSwitches` because `@iracedeck/settings` must not depend on `audio-scenarios`.

## Per-callout opt-in/out — `callout<Polarity><Family><Subject>`

For N parallel opt-ins over individual Race Engineer callouts (e.g. #467, every flag), use one boolean key per subject named `callout` + `Enabled` + family + subject (`calloutEnabledFlagYellowLocal`, `calloutEnabledPitActionFuel`) so `grep calloutEnabled` finds them all. Polarity is **always** `Enabled`. **Per-item booleans, never an array or bitmask:** a subject added later gets its field default for every existing user via `passthrough()`, with no migration.

1. **Declaration** — every key is declared once, as an entry in the `@iracedeck/callout-settings` registry (`packages/callout-settings/src/families/<family>.ts`, #1350): its `key`, its checkbox `label`, and the callout id it serves as the entry's object key. Never declare one anywhere else — not as a hand-written schema field, not in a map beside the feature catalog, not as a hand-written checkbox. The package has no dependencies, so `@iracedeck/settings` and `audio-scenarios` can both reach it; its `CLAUDE.md` has the shapes.
2. **Default** — on unless the entry says `default: false`, the only value the field takes: new Race Engineer functionality ships on, so an off default is the visible exception (today six fuel countdown counts). `calloutDefault(key)` turns it into the schema default.
3. **Schema** — derived, never written: `calloutEnabledFields()` in `global-settings.ts` builds a field for every `CalloutSettingKey` with the shared `calloutEnabledField` shape (`z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true").default(calloutDefault(key))`). The keys are a published contract: the settings package's frozen baseline (`callout-settings-baseline.test.ts` over `src/__fixtures__/callout-settings-baseline.json`, the 100 keys before #1350) fails when one is dropped, renamed or re-defaulted, which is when a migration is owed — never regenerate the baseline to make it pass.
4. **Lookup and live gating** — read an opt-in through `isCalloutEnabled(key)` from `@iracedeck/settings`, typed to `CalloutSettingKey` so a misspelt key does not compile, or, in a pure function, from a typed `GlobalSettings` value its caller hands it (`evaluateSetupWarning` takes a `Pick<GlobalSettings, …>` of the keys it reads); never through a cast `Record<string, unknown>` such as `(getGlobalSettings() as Record<string, unknown>)[key] !== false`. Write one the same way, through `setCalloutEnabled(key, enabled)` (the Corner Names toggle is the one writer today), never an untyped `updateGlobalSettings({ calloutEnabled…: … })` literal. Read it on every event arrival (e.g. the audio-scenarios `where:` predicate), not by re-registering on `onGlobalSettingsChange`, so a toggle never cuts work in flight. `registerPitCrew` takes it as the one `PitCrewDeps.isCalloutEnabled` dependency, and each family resolves its callout id to a key through the registry (`enabledIn(<FAMILY>_CALLOUTS)`).
5. **UI** — derived too: the settings window's Callouts card renders one `<sdpi-item>` per `CALLOUT_PI_GROUPS` heading, its rows the groups' families' entries in order, from the `calloutPiGroups` render data `pi-template-plugin.mjs` passes to `race-engineer-callouts.ejs`. It reads them per build from the built registry through `loadCalloutPiGroups()` (`pi-components/src/build/callout-pi-groups.mjs`), in a fresh Node process so a watch-mode rebuild is not served from the ESM cache, and watches the registry's compiled files; tests that render the partial call the same function. Rows sit in a two-column grid sized from the row count, never a hardcoded one. An on row gets `default="true"`; an off row omits the attribute, because `default="false"` renders checked.

Reference: `packages/callout-settings/CLAUDE.md`; `isCalloutEnabled` and `setCalloutEnabled` in `packages/settings/src/global-settings.ts`; `enabledIn` in `registerPitCrew` (`packages/audio-scenarios/src/catalog/pit-crew/index.ts`).

## Settings Key Convention

Global settings, bindings included, use flat key names (`blackBoxLapTiming`), never nested paths.

## PI Warning Banners — `_warnings` + `setWarning`/`clearWarning`

Banners at the top of every PI (#610) live in `_warnings`, a JSON array of `{ id, level, message }` (`level`: `"info" | "warning" | "error"`), keyed by `id` so producers coexist. Passthrough, run-scoped. The record type is `PiWarning` (and `PiWarningLevel`) in `@iracedeck/app-constants`, beside `PI_WARNINGS_KEY` (#1366), so the writers, every evaluator and the `ird-warnings` reader name one type; `@iracedeck/settings` owns the writes, not the shape.

```typescript
import { setWarning, clearWarning, reconcileWarnings } from "@iracedeck/settings";

setWarning("elevation-mismatch", "warning", "…message…"); // upsert by id; skips an identical write
clearWarning("elevation-mismatch");                         // no-op when absent
reconcileWarnings(["settings-window-server", "settings-window-open"], warnings); // one write for a family of ids
```

Use `reconcileWarnings` whenever one condition raises more than one banner (#1005): each set/clear is a full write — persist plus synchronous listener fan-out. `ird-warnings` (auto-injected by `head-common.ejs`) prepends a level icon, so **messages must not start with an emoji**. Banners are state-driven, not dismissible. A warning about one control renders beside it via the `only`/`except` filters (`@.claude/rules/stream-deck-actions.md`); the settings window withholds both settings-window ids (#1014) by placing its own `<ird-warnings data-auto except="…">` as the body's first child.

Every producer is a **pure** evaluator (`PiWarning | null`, or a list) plus a thin adapter that alone touches the store, wired once for all three plugins in `plugin-runtime`'s phases (`src/phases/settings.ts`, `start-services.ts` for the elevation probe, `voice-packs.ts` for the missing-script reporter):

- **Elevation mismatch** (#610) — `createElevationCheckSubscriber` over `evaluateElevationWarning()` + injected `getElevationStatus()`, both in `@iracedeck/deck-iracing` (#1351).
- **Settings window** (#1005) — `createSettingsWindowWarningReporter({ getStorePath })` over `evaluateSettingsWindowWarning()`, as the controller's `onStatus` hook (the controller reports what it tried, `SettingsWindowStatus`, since only it knows which stage failed). Two ids because **placement is keyed by id**: `settings-window-server` (`error`, page-wide strip) and `settings-window-open` (`warning`, beside the button). Exclusive conditions in the same place get one self-replacing id; split only for different homes, with the reporter clearing the sibling.
- **Settings file rejected** (#1036) — `createSettingsFileRejectionReporter()` over `evaluateSettingsFileRejectionWarning(rejection)`, wired as `createFileSettingsStore`'s `onRejected`; id `settings-file-rejected`, `error`, page-wide. It fires while the store is still loading, so the write is an early write, which `becomeReady()` applies AFTER stripping run-scoped keys from the migrated raw — so it reaches the ready cache, the loopback channel and the once-per-start mirror. Set-only: a start whose file parses has nothing to clear. The one path it misses is a host that never answers the migration read (`fresh`, no mirror), a double failure. The message is raised before the host's answer, so it names both outcomes ("the copy your deck software keeps … or defaults if it had none") rather than guessing one.
- **Missing callout script** (#1064) — `createVoiceScriptWarningReporter({ set: setWarning, clear: clearWarning })` over `evaluateVoiceScriptWarning({ activeVoice, scriptedVoices, labels })`, both in `@iracedeck/voice-packs` (#1366), which takes the two writers injected rather than importing `settings`, id `voice-script-missing`, while the active voice (`resolveActiveRaceEngineerVoice`) has no parsed script in `voicePackService.scripts()`. Names the voice by its `_voiceLabels` label, else the title-cased voice half of the id — never the raw composite. Re-evaluated after every scan and every settings change, straight after `migrateRaceEngineerVoiceId`.

### `_warnings` is run-scoped — never persisted (#1014)

`RUN_SCOPED_SETTING_KEYS` (`settings/src/run-scoped-settings.ts`) holds `_warnings`, `_voicePacks` (#1034), `_voicePackStatus` (#1100) and `_profileCaptureStatus` (#1338) — observations about THIS run. They are stripped at every boundary: **into the cache** (`becomeReady()` in `global-settings.ts`), **out to the file** (the single `persist()` funnel; a write touching only run-scoped keys skips the save, `hasOnlyRunScopedKeys`), and **in from a UI** (`settings-window-server.ts` strips them from every `setGlobalSettings` frame, since sdpi saves a whole snapshot that can predate the cache). Within a run they behave normally, including the once-per-start mirror — so a fallen-back PI sees only banners raised before the mirror.

- Retiring or renaming a warning id needs no cleanup.
- **Every producer must re-assert its state within the run**: the settings-window reporter at every `ensureStarted()`; `validateSetupWarningPatterns` on the first settings arrival and every change; the elevation probe per iRacing connection; `_voicePacks` after every scan and every PI appearance; `_voicePackStatus` on every installer phase change; the missing-script reporter after every scan and settings change (on a fresh run the first settings arrival raises it — `onPacksChanged` returns early behind `isGlobalSettingsInitialized()`); the settings-file rejection reporter on every start whose load rejects the file. The only exemptions are the voice-pack REMOVAL banner (#1100) and the CPU profile capture status (#1338), whose conditions expire with the process (a capture dies with it, and an absent status reads as idle); claim it only for such a condition. A new producer's re-assertion goes in the `plugin-runtime` phase that wires it — usually the settings phase.

Enrol a key only when it is an *observation about this run*, never a user choice. Membership is an explicit list, not a naming rule — `_lastSeenVersion` and `_lastChangelogOpenedAt` are durable.

## Version-upgrade changelog — `_lastSeenVersion` + `runVersionCheck` (#680, #742, #870, #901)

On the first settings arrival each start, each plugin compares `getPluginVersion()` with passthrough `_lastSeenVersion`; on a strictly newer **stable** version (first install included) it persists the version and opens `CHANGELOG_BASE_URL` once. Pre-releases and same/older versions are inert; the stored value is never lowered.

- **Never opens while iRacing runs** (#870): `runVersionCheck`'s `isSimRunning` (plugins pass `isIRacingActive` from `@iracedeck/deck-iracing`'s `app-monitor.ts`) is checked BEFORE persisting, and true → `defer`; the check re-runs from `onIRacingTerminated`. Exit comes from `applicationDidTerminate` (notified after the running flag and SDK connection are down; `setReconnectEnabled(false)` is try/caught) or the SDK-disconnect fallback: a loss sustained `IRACING_EXIT_SDK_CONFIRM_MS` (5 s), deduped per episode, skipped while an event-set running flag says iRacing runs, and clearing a running flag whose only evidence was that connection. An adapter without app-monitoring events declares `supportsApplicationMonitoring = false` (Ulanzi), which keeps SDK reconnect polling on at startup. The startup check waits `VERSION_CHECK_STARTUP_GRACE_MS` (15 s). The settings phase's `runStartupNotices()` (`plugin-runtime`, the first-run check then the version check) re-reads the live cache, is guarded on `startupDefaultsApplied`, and its terminate listener is gated on `shouldOpenChangelog`.
- **Policy** (#742) — `changelogNotification`, `z.enum(CHANGELOG_NOTIFICATION_POLICIES).default(DEFAULT_CHANGELOG_NOTIFICATION_POLICY).catch(...)` (both in `@iracedeck/app-constants`' `changelog-policy.ts`): `always`; `features` (major/minor; patches persist silently); `monthly` (≤ once per 30 days anchored on `_lastChangelogOpenedAt`, stamped on every open under any policy; a suppressed update stays pending); `never` (still persists silently). **Default `never` since #1061**, new installs only, deliberately no migration. UI: `global-common-updates.ejs` on the What's New tab (pane id `updates`), plain-language labels.
- **Helpers** in `app-updates/src/version-check.ts`: `shouldOpenChangelog`, `resolveChangelogDecision` → `"open" | "track-silently" | "defer" | "skip"`, `buildChangelogUrl({ ecosystem, deviceType })`, `runVersionCheck(...)`, which persists before opening (open failures swallowed). `openUrl` is an `IDeckPlatformAdapter` member since #1349. The URL carries anonymous `ecosystem` and best-effort `type` (device type, Elgato). User docs: `packages/website/src/content/docs/docs/features/whats-new-page.md`.

## Binding-configured detection — `isConfigured` / `isBindingMissing` (#612)

A binding is "configured" when a keyboard binding **or** a SimHub role is set, regardless of iRacing or SimHub reachability; `BindingDispatcher.isConfigured(settingKey)` is the source of truth. `ConnectionStateAwareAction.isBindingMissing(keys: string | string[] | null | undefined)` is true when any required key is unconfigured, false for `null`/empty (api/chat/fixed-key modes). Drive the per-button missing-binding icon with `isBindingMissing(<per-context key(s)>)` — **never** the shared `isActiveBindingMissing()`/`activeBindingKeys`, which is one value per action class and bleeds across its buttons. The PI `ird-binding-status` line shows the same state per mode; a SimHub-bound mode with SimHub not running is "configured", with a separate live "SimHub not connected" caveat.
