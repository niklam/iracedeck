# Keys show a disconnected look while the sim is not connected

> **Issue:** [#1599](https://github.com/niklam/iracedeck/issues/1599) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

While iRacing is not running, every key whose current mode needs it gets a dim layer over the whole icon and a small "disconnected" badge on top of that layer. One global setting turns the look on or off. The issue carries the request. This spec records how it is built, and why the readiness machinery that once drew a disconnected look is removed rather than switched back on.

## What exists today, and why it is not switched back on

- `BaseAction` already sends every key image through `applyOverlayIfNeeded(svg)`, which calls `applyInactiveOverlay` while the action is inactive and `disableWhenDisconnected` is on. That overlay has drawn nothing since January 2026: `overlayConfig.inactiveOverlayEnabled` is hard-coded `false` in `overlay-utils.ts`. It greyed the key with an `feColorMatrix` filter and replaced the title with "N/A", which made icon design painful with iRacing closed.
- The settings window still shows **Disable buttons when iRacing is not connected** (`disableWhenDisconnected`, default `true`, in `global-common-window-focus.ejs`). Its help text, and the website's settings page, say presses are ignored. Nothing ignores them, and the checkbox does nothing at all.
- The state behind it is held per action instance, not per key. `BaseAction._isActive`, `ConnectionStateAwareAction.lastReadyStatus` and `activeBindingKeys` are each one value per class instance, and one instance serves every key the action is placed on. Two keys of one action in different modes would share whatever was evaluated last. The bleed was invisible only because the overlay was off. #1596 is a listener-lifetime bug in the same machinery, and it is equally invisible.
- Readiness is evaluated on every sim tick for every key, through a `_readiness:<id>` subscription, for a value that changes only when the connection changes.
- Readiness mixes three things: the sim connection, whether a binding is configured, and whether SimHub is reachable. The new look is about the sim only. A missing binding already has its own ⚠ overlay (#612), drawn by the actions through the stateless `isBindingMissing`.

## Behaviour

- **Shown when all three hold:** the setting is on, the sim has been absent for the sim's absent delay (iRacing: 5 s, below), and this key's current mode needs the sim.
- **Cleared on the first connected tick**, at once. At plugin start the sim counts as present until the delay passes without a connection, so a start with iRacing already running never flashes the look. A short SDK drop never flashes it either.
- **The look:** the key's own image, title and art included, is drawn unchanged. Over it goes one rectangle covering the whole canvas, in black at `DISCONNECTED_DIM_OPACITY`. On top of that goes the badge, in a corner. The opacity, the badge glyph, its size and its corner are set on the review page during implementation (below). The constraints are fixed here:
  - The badge takes at most about a third of the key's width.
  - It leaves clear the bottom title band, the centre (where the #612 ⚠ sits) and the top-right corner (where the "A" automatic-mode badge sits).
  - It is built only from `rect`, `circle`, `polygon`, `path` and `opacity`, the shape set of the binding-warning glyph.
  - It must read correctly with `pngRasterization` off, because it carries essential information (`svg-platform-compatibility.md`).
- **Other looks are drawn first and dimmed with the rest of the key.** That covers the binding ⚠ and the unavailable look (`iracing-actions/src/shared/unavailable-look.ts`, the grey that Replay Markers, Replay Control and Pause Sim use for "this press would do nothing right now"). Both are part of the action's image, and the dim layer goes over the whole image. The unavailable look is a per-action state while the sim runs; the disconnected look is one state for the whole deck. They stack rather than merge, and each still reads.
- **Presses still go through.** The look is information, not a gate (Out of scope).
- **The flags overlay is unaffected.** Flags only flash while the sim is connected, and the restore after a flash goes through the same decoration as every other image.

### Which keys need the sim

A key needs the sim unless its action says otherwise for its current mode. **The binding type does not change the answer.** A mode bound to a SimHub role needs the sim as much as one bound to a key. Niklas confirmed this on 2026-11-02: a SimHub-bound key does not work without iRacing. SimHub's Control Mapper turns the role into an input for the sim.

| Action, mode | Needs the sim? | Why |
|-----|----------------|-----|
| Every API, chat and binding mode, every display key | yes | It talks to, or reads, iRacing |
| Pit Crew, every mode (Race Engineer, Radar, Radar Volume, Corner Names) | **no** | Each changes a plugin setting |
| Switch Profile | **no** | It switches a deck profile |
| Audio Controls, the Race Engineer and Radar categories | **no** | They step the plugin's own audio buses (`audio-volume.ts`) |
| Telemetry Control, Capture CPU Profile | **no** | It records the plugin's own CPU profile |

Every other Telemetry Control mode, and the other three Audio Controls categories (Push to Talk, Voice Chat, Master), need the sim.

## Architecture

### 1. One debounced sim-presence signal, in `sim-connection.ts`

- **API:** `isSimAbsent()` and `onSimPresenceChange(listener) → unsubscribe`, beside the sim-connection singleton.
- **Why in `sim-connection.ts`:** `_resetSimConnection()` resets presence along with everything else, so no test can be left with a module that thinks it is subscribed and gets no ticks. A separate module would need `sim-connection.ts` to import it back, a source cycle the plugin builds refuse.
- **One subscription for the plugin's lifetime.** It is made on the first listener (queued and replayed before `initializeSimConnection`, like any subscription) and never released. The SDK controller runs for the translator and the app monitor anyway, so ref-counting it would save nothing. The debounced value survives a moment with no listeners, such as a page or profile switch with iRacing closed.
- **The debounce:** a disconnected tick arms one `setTimeout(absentDelayMs)`, a connected tick clears it, and listeners run only when the debounced value changes. `SDKController.subscribe` calls a new subscriber back at once with `isConnected=false`, so the timer is armed at start even though a disconnected controller sends no further ticks.
- **The delay belongs to the sim, not to deck-core.** `initializeSimConnection(connection, { absentDelayMs })` takes it, without widening the `SimConnection` interface. `deck-iracing`'s `initializeSDK` (`sdk-singleton.ts`) passes `IRACING_EXIT_SDK_CONFIRM_MS` (5 s), the confirm the app monitor already uses for the same fact. The constant moves from `app-monitor.ts` to a leaf module both import, because `app-monitor` already imports `sdk-singleton` and the reverse import would be a source cycle, which the plugin builds refuse. So iRacing has one answer to "how long before a lost connection counts as gone". It also sits well clear of the controller's 2000 ms reconnect poll (`SDKController.ts:131-144`), which a 2 s debounce would race. A second sim passes its own value.
- **Lifecycle:** `_resetSimConnection()` clears the timer and the listeners.

### 2. Per-key "needs the sim", and readiness removed

- **The hook.** `ConnectionStateAwareAction` gets `protected needsSim(settings: unknown): boolean`, returning `true` by default. It is handed the raw settings of the context being drawn. `BaseAction` keeps each context's latest raw settings from `onWillAppear` / `onDidReceiveSettings` and clears them on `onWillDisappear`. The overrides parse those settings with the action's own schema:
  - Pit Crew and Switch Profile return `false`.
  - Audio Controls returns `false` for the `race-engineer` and `radar` categories.
  - Telemetry Control returns `false` for `capture-profile`.
- **Why a hook over the context's settings.** The answer is per mode, and so per key. It is static, and it is sim-neutral: nothing is widened and no host is involved.
- **The presence listener** is held while the action has at least one live key. It is subscribed when the first context appears and released when the last disappears, so one key leaving never stops another's updates (the #1596 class). On a change, every live context's image is pushed again.
- **Readiness is deleted, not converted.** That covers `lastReadyStatus`, `evaluateReadiness`, the `_readiness:` subscription, `activeBindingKeys`, the two listener fields, the deprecated `updateConnectionState()` (two callers in `iracing-actions`) and `isActiveBindingMissing()` (no production caller; one test). It also covers **`setActiveBinding` itself**: with no exemption by binding type its only output was readiness, so its 55 call sites in `iracing-actions` are removed and their tests' assertions with them.
- **What stays:** `isBindingMissing`, `isBindingKeyboardBound` and the binding-dispatch delegates, which never depended on readiness, and `getConnectionStatus()`.
- **No settings listener is added.** `BaseAction`'s constructor-lifetime `onGlobalSettingsChange` already re-renders every context when the setting is toggled.

#1596 (3.8.1) fixes listeners whose only output is `setActive`, and `setActive` pushes images that `applyInactiveOverlay` returns unchanged. So the bug cannot be seen, and its code is deleted here. Whether to close it as superseded by #1599 rather than ship it is a call for the PO.

### 3. Composition in `BaseAction`'s one image funnel

- `BaseAction` gets `protected showsDisconnected(contextId): boolean`, `false` by default. `ConnectionStateAwareAction` overrides it as `getGlobalSettings().showDisconnectedState && isSimAbsent() && this.needsSim(<that context's raw settings>)`.
- `applyOverlayIfNeeded(svg)` becomes `decorateKeyImage(contextId, svg)` and returns `applyDisconnectedLook(svg)` when that is true.
- **Every path that sends a key image already goes through it.** The architect review checked this against the code: `setKeyImage`, `updateKeyImage` (which `IconUpdateThrottle` and dual press call back into), `setRegenerateCallback`'s reconcile push, the global-settings refresh, the flag-overlay restore and the title-template watcher. The adapters only forward `setImage`. So every action gets the look with no change of its own, on Elgato, Mirabox and Ulanzi, and the adapters rasterize the result as usual.
- **The two direct `setImage` calls are not key images:** the flag frames, which exist only while connected, and `pushDialNameIcon`, which draws the Stream Deck + strip slot.
- **Deleted:** `_isActive`, `setActive`, `getIsActive`, `shouldApplyOverlay`, `applyInactiveOverlay` and `overlayConfig`.
- **Kept and moved:** `hexToGrayscale` has a production caller (`unavailable-look.ts`). It moves to `@iracedeck/icon-composer` as a pure colour helper with one import path, and `deck-core` no longer exports it. `overlay-utils.ts` is left with only its re-exports from `icon-composer`, or removed if nothing imports it through `deck-core`.

### 4. The pure compose function (`icon-composer/src/disconnected-look.ts`)

- `applyDisconnectedLook(svg)` takes a raw SVG or an SVG data URI and returns the same form.
- It reads the root `viewBox` (`parseSvgViewBox`, falling back to `width` and `height`), and appends the dim rectangle and the badge just before the root `</svg>`, sized to that box.
- The badge is authored for the 144 canvas and scaled by the shorter side, as `bindingWarningSvg` scales its glyph. `assembleIcon` and the dynamic templates draw on 144×144, and a legacy 72×72 image is covered by the same scaling.
- Anything it cannot place (a PNG data URI, an SVG with neither a viewBox nor a size) is returned unchanged.
- It is pure and has no `deck-core` dependency, so the review page can render it.

### 5. The setting, and retiring `disableWhenDisconnected`

- **`showDisconnectedState`** in `GlobalSettingsSchema`: `z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true").default(false).catch(false)`. **Default off, for everyone** (Niklas, 2026-11-02). One setting covers both the dim layer and the badge. A new key gets its schema default for every user, existing ones included, so no migration is needed to reach anyone.
- **`disableWhenDisconnected` is retired.** Its name says "disable", and its text promises ignored presses; neither is true. It leaves the schema.
- **Nothing carries over.** With the new setting off by default, an old value no longer decides anything:
  - An old `false` would only restate the new default.
  - An old `true` was never a choice. Every install persisted the schema default `true`, and the box has drawn nothing since January, so turning the look on for those users would act on a value they never picked.
  - So the stale-copy hazard a carry-over would raise does not arise either. A whole-snapshot frame from an older page, or a late `mergeMigration` on a `_migrationPending` store, bringing the old key back cannot change what any key shows.
- **The dead key is deleted from the file.** Left in place, it would read as a live setting to anyone editing `global-settings.json` by hand, and it would be a trap if the name were ever reused. So a marker-free cleanup in `global-settings-migrations.ts` deletes it with `deleteGlobalSettings(["disableWhenDisconnected"])`.
  - It runs at every start once the store is ready, beside `migrateGlobalSettingsKeys` (through `runOnceSettingsStoreReady`), and only when the cache holds the key.
  - It can tell done from not-done (the key is there or it is not), so it needs no marker. A copy brought back by a frame or a merge is deleted at the next start, which is harmless because nothing reads it.
  - It needs no `isSettingsStoreHostDerived()` gate: it decides nothing on the absence of a key and destroys nothing anyone reads.
  - Per-key salvage and the host mirror are unaffected. A passthrough key is never validated, and the mirror carries the full cache, which no longer holds the key.
  - Downgrade: 3.8 writes its default `true` back, nothing in 3.8 acts on it, and the next upgrade deletes it again.
  - The name is never reused.
- **Settings window:** a new card on the Appearance tab (a partial `global-disconnected-look.ejs`, after the flag-flash card) with one `sdpi-checkbox` (`global`, and no `default` attribute, since `default="false"` renders checked). Its label and help text say:
  - keys that need iRacing are dimmed and badged while it isn't running;
  - Pit Crew, Switch Profile, the Race Engineer and Radar volume keys and Capture CPU Profile keep their look;
  - presses still go through.
- **The old item goes.** The Connection item and its text are removed from `global-common-window-focus.ejs`, and the card becomes Window Focus.

## Alternatives rejected

- **Turn `overlayConfig.inactiveOverlayEnabled` back on and restyle `applyInactiveOverlay`.** It keeps the per-instance bleed and ties the look to binding readiness and SimHub reachability. It also keeps a filter-based grey, which vanishes silently with `pngRasterization` off.
- **Per-action opt-in** (each action passes a `disconnected` flag into `assembleIcon`, as with `bindingMissing`). That is 40 actions to change and 40 chances to forget one, plus the dynamic templates and hand-assembled icons. The funnel already sees every key image.
- **Exempt keys whose bindings are all SimHub roles,** using the keys passed to `setActiveBinding`. Those keys are not what the context sends:
  - The dual-press setup views track only the tap direction's key, and a view key reads telemetry.
  - Car Control's Escape and five setup actions skip the call when a mode has no binding, so a context would keep the previous mode's keys.
  - The premise itself is wrong: a SimHub-bound key does nothing without iRacing (above).
- **Derive "needs the sim" from the comms catalog.** The catalog lives in `iracing-actions` and leaves out display-only actions, which do need the sim.
- **A 2 s debounce owned by deck-core.** It races the iRacing controller's 2 s reconnect poll and would be a third, unrelated "sim gone" delay beside the app monitor's. It is also sim timing inside sim-neutral code.
- **A separate setting for the dim layer.** Niklas asked for the dim layer and the badge "at the same time", and confirmed on 2026-11-02 that one setting covers both.
- **Carrying `disableWhenDisconnected` over to the new setting.** With the new setting off by default, an old `false` would only restate that default, and an old `true` was never a choice (§5).

## Out of scope

- **Dial screens** (`setDialCanvas`, the touch-strip name card, the Mirabox knob image). They are drawn through 18 call sites with no shared funnel; building one is its own refactor and a follow-up issue.
- **Dropping presses while disconnected.** The old help text promised it and it never existed. Whether to add it is a product question of its own.
- **A look for a SimHub-bound key while SimHub is unreachable.** Readiness tracked this but never drew it. If it is wanted, it is a separate state with its own design.
- **The Property Inspector.** It shows no global settings since #1003.
- **The Telemetry Snapshot.** Presence follows from the connection fields it already carries.

## Artifacts

- `packages/deck-core`:
  - `sim-connection.ts` (presence, and the `absentDelayMs` option), `base-action.ts`, `connection-state-aware-action.ts`, `overlay-utils.ts` and the barrel.
  - Their tests: `base-action.test.ts`, `connection-state-aware-action.test.ts`, `connection-state-aware-action.real-base.test.ts`, `overlay-utils.test.ts`, `sim-connection.test.ts`, and `simhub-service.test.ts` (its mocks hold `disableWhenDisconnected`).
  - `CLAUDE.md` (Base Classes, Sim Connection and Shared Utilities).
- `packages/deck-iracing`: `initializeSDK` passes `absentDelayMs: IRACING_EXIT_SDK_CONFIRM_MS`; the constant moves to a leaf module that `app-monitor.ts` and `sdk-singleton.ts` both import; plus their tests.
- `packages/icon-composer`: `disconnected-look.ts` (new), `hexToGrayscale` (moved), the barrel, the tests and `CLAUDE.md`.
- `packages/iracing-actions`:
  - the 55 `setActiveBinding` calls and their test assertions removed;
  - the two `updateConnectionState` callers;
  - `needsSim` overrides on Pit Crew, Switch Profile, Audio Controls and Telemetry Control;
  - `unavailable-look.ts` imports `hexToGrayscale` from `icon-composer`;
  - the comment in `actions/settings/settings.ejs:8`;
  - `CLAUDE.md`, whose unavailable-look line ("a new 'this key cannot act now' state uses it too") gains the disconnected look as the deck-wide state that stacks over it.
- `packages/settings`: the schema field, the dead-key cleanup in `global-settings-migrations.ts`, and their tests. `plugin-runtime`'s `phases/start-services.ts` calls the cleanup beside `migrateGlobalSettingsKeys`. `global-settings.test.ts` and `snapshot-settings.test.ts` assert `disableWhenDisconnected` today.
- `packages/pi-components`: the new partial, `global-common-window-focus.ejs` and `accordion-partial.test.ts`. Also `settings-window.ejs` in iracing-actions (it includes the card), `scripts/lib/settings-window-capture/seed.mjs`, and new settings-window screenshots (`pnpm capture:settings`).
- Website:
  - `docs/getting-started/settings.md`: the old checkbox paragraph is replaced by the new one under Appearance.
  - A short section on the disconnected look where key appearance is described.
  - `docs/development/architecture.md:65`: "greying out while the sim is disconnected" becomes the dim layer and badge, still through SEAM 3.
  - A changelog fragment under Features.
- Rules:
  - `icons.md`: the badge as a shared marker, as the "A" badge is.
  - `svg-platform-compatibility.md`: the badge's shape set, beside the binding-warning glyph.
  - `global-settings.md`: the schema example names `disableWhenDisconnected`. A line also records that a retired key is deleted by a marker-free cleanup, and why nothing carried over (§5).
  - `stream-deck-actions.md`: `setActiveBinding` is removed from every example; the `needsSim` override is added; "offline behavior is handled centrally" is reworded.
  - `plugin-structure.md`: its stale `disableWhenDisconnected` comment.
- The badge design: a review page (`review-page` skill) shows a range of real keys with and without the look, at a few opacities, for Niklas to approve before it is committed:
  - a plain icon and a dynamic template;
  - a key with the #612 ⚠;
  - an unavailable Replay Markers key;
  - a key with the "A" badge;
  - a Pit Crew key, which never gets the look.

## Testing

**Unit (Vitest):**

- **Presence:**
  - present at start;
  - absent only after `absentDelayMs` of disconnection (fake timers), including when the controller sends no tick after the initial `false`;
  - a reconnect inside the delay never fires a change;
  - present on the first connected tick;
  - the value survives every listener leaving and a new one arriving;
  - listeners added before `initializeSimConnection` are replayed;
  - `_resetSimConnection()` clears the timer and the listeners.
- **`ConnectionStateAwareAction`:**
  - **Two contexts of one action in different modes while the sim is absent** (Audio Controls with Radar on one key and Master on the other): only the Master key is decorated. As a positive control, the same two-key arrangement must show the old per-instance code giving both keys one state.
  - One context disappearing leaves the other updating on a presence change, and the last one disappearing releases the listener.
  - Each `needsSim` override, mode by mode.
- **`BaseAction`:**
  - every funnel path (`setKeyImage`, `updateKeyImage`, the reconcile push, the settings refresh, the flag restore, the title watcher) decorates when `showsDisconnected` is true and passes the image through untouched when it is false;
  - the stored original is never the decorated one.
- **`applyDisconnectedLook`:**
  - raw SVG and data-URI round trips;
  - 144 and 72 viewBoxes, and a size-only SVG;
  - a PNG data URI comes back unchanged;
  - the output holds no `filter`, `mask`, `clipPath` or `<style>`.
- **Settings:**
  - the schema field's coercion, default and `.catch`;
  - the cleanup deletes `disableWhenDisconnected` whatever its value, leaves `showDisconnectedState` at what it was, does nothing without the key or before the store is ready, and is idempotent over two runs.

**Manual (Niklas, on all three hosts):**

1. On a fresh install and on an upgraded one, the new box on the Appearance tab is unticked and no key shows the look. Tick it.
2. With iRacing closed, restart the deck host. About 5 s after the plugin starts, every sim key dims and shows the badge. Pit Crew and Switch Profile keys don't, nor do Audio Controls' Race Engineer and Radar keys, nor Capture CPU Profile.
3. Start iRacing and join a session: the look clears as it connects. Change session within the event (practice to qualifying): the look does not appear. Leave to the iRacing UI: it appears about 5 s after the sim exits.
4. Untick the setting with iRacing closed: the look clears at once. Tick it: the look comes back.
5. A key with a missing binding and an unavailable Replay Markers key, while disconnected: both show their own look dimmed, with the badge on top.
6. With iRacing running, the flags overlay still flashes and restores normally.
7. Switch Stream Deck pages with iRacing closed: the new page's keys show the look at once, not after another 5 s.
8. After upgrading a 3.8 install, `disableWhenDisconnected` is gone from `global-settings.json`, whether it was ticked or not.

**Review level:** `xhigh`. The change retires a `GlobalSettingsSchema` field and adds a cleanup that deletes a stored key (a persisted contract), and it removes `ConnectionStateAwareAction` API that every action uses. The second read applies, because the presence debounce and the per-context listener lifetime are a state machine.
