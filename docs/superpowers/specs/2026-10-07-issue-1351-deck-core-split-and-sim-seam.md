# Split `deck-core` by concern and put iRacing behind a sim-connection seam

> **Issue:** [#1351](https://github.com/niklam/iracedeck/issues/1351) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

The [2026-10-05 architecture review](../../architecture/reviews/2026-10-05-architecture-review.md) (items 2, 3 and part of 7) found `deck-core` to be a catch-all. Its 101 source files and 908-line barrel hold the deck abstraction (about 11 %) beside the voice-pack stack (27 %), the settings store and window, the replay store, diagnostics and the update checks. It is also sim-agnostic in name only: seven files import `@iracedeck/iracing-sdk`, and importing the barrel loads the native addon.

Measured on `master` at `34ba89f52` for this spec:

- **The SDK coupling is narrow.** Five files use the SDK at runtime:
  - `sdk-singleton.ts`: `createSDK` and the `getController` / `getCommands` singletons.
  - `base-action.ts`: the flag overlay reads `SessionFlags` through `resolveAllActiveFlags`, and the title-template watcher subscribes to the controller.
  - `title-template.ts`: `getCurrentTemplateContext` + `resolveTemplate`.
  - `fuel-telemetry.ts`: `PitSvFlags`.
  - `unit-conversion.ts`: `DisplayUnits`.

  Two files import types only: `connection-state-aware-action.ts`, whose `sdkController` getter returns `SDKController`, and `replay-session-subscriber.ts`. `ConnectionStateAwareAction` itself calls only `subscribe`, `unsubscribe` and `getConnectionStatus`.
- **The actions use the controller far more widely.**
  - 27 `iracing-actions` files read `this.sdkController`: `getCurrentTelemetry` in 21 files, `getSessionInfo` in 9, `getCurrentTemplateContext` in 2, plus `subscribe` / `unsubscribe`.
  - 15 files call `getCommands()`: camera, replay, chat, pit, videoCapture, texture and telem.
  - Porting these is out of scope (below), so the iRacing-typed controller has to stay reachable from actions.
- **The concerns are tangled through the deck layer and through constants.**
  - The deck abstraction depends on global settings at runtime in nine places: bindings, title defaults, window focus and SimHub. So settings belongs below the deck layer, not beside it.
  - Settings forms cycles with the voice packs, diagnostics, the update checks and the iRacing helpers. Every one of those cycles runs through a constant: `ENSURED_VOICE_PACK_ID`, `VOICE_PACK*_KEY`, `PROFILE_CAPTURE_STATUS_KEY`, the changelog policies and `focus-iracing-mode`.
  - `global-settings.ts` and `settings-channel-publisher.ts` type their host as `IDeckPlatformAdapter`.
  - `window-focus-service.ts`, part of the deck layer, imports the iRacing elevation check.
- **Browser code cannot import `deck-core`, so `pi-components` keeps copies of its constants.**
  - Pinned by tests: `warnings-constants.ts`, `cpu-profile-capture-constants.ts`, `voice-pack-catalog-constants.ts`, `SETTINGS_WINDOW_HTML`, the focus modes and the changelog policies.
  - Not pinned: `_devBaseUrl`, the catalog base URL, and the `CommDescriptor`, `BindingValue` and voice-pack types copied under "SYNC NOTE" comments.
  - The one precedent for sharing instead of copying is the `@iracedeck/deck-core/key-binding-defaults` subpath.

## Decision

### The sim-connection seam

`deck-core` gains `sim-connection.ts`, the only thing the deck layer knows about a simulator:

```typescript
export interface OverlayFlag {
  label: string;
  color: string;
  textColor: string;
  pulse: boolean;
}

export interface SimConnection {
  isConnected(): boolean;
  subscribe(id: string, onTick: (isConnected: boolean) => void): void;
  unsubscribe(id: string): void;
  /** Active flags in priority order; empty when none are out or the sim is disconnected. */
  activeFlags(): readonly OverlayFlag[];
  /** Resolves a user-entered title template; disconnected, variables render empty and parse errors stay verbatim. */
  resolveTitleTemplate(text: string): string;
}
```

It comes with the singleton trio `initializeSimConnection` / `getSimConnection` / `isSimConnectionInitialized` plus `_resetSimConnection`. Before initialisation, `getSimConnection()` returns a disconnected null connection. That replaces the try/catch `BaseAction` wraps around a missing SDK today.

- **`BaseAction`.** The flag overlay and the title-template watcher subscribe to the connection's tick and pull `activeFlags()` and `resolveTitleTemplate()` on it. `OverlayFlag` is the shape `FlagInfo` already has, and the overlay reads nothing else, so the overlay's drawing does not change.
- **`ConnectionStateAwareAction`.** It tracks readiness through `getSimConnection()` and loses its `sdkController` getter.
- **`resolveTitleSettings`.** It goes through `getSimConnection().resolveTitleTemplate`.
- **`window-focus-service`.** It takes `hasElevationMismatch` as an injected delegate beside the `isIRacingActive` it already receives (#1176), so it no longer imports `elevation-check`.

**What the interface deliberately leaves out:**

- **Commands.** `camera.switchNum(carIdx…)`, `replay.setPlayPosition` and `pit.fuel` are iRacing's vocabulary. A sim-neutral command surface is a read and write model, which is #714, gated on a concrete second SDK for the reason that issue gives: a model designed against one sim is that sim's model in disguise. The issue lists "the command surface actions use" among the interface's contents; this spec declines that part for this reason. `getCommands()` stays on the iRacing side.
- **Reconnect control.** `setReconnectEnabled` has one caller, the app monitor, which moves to the iRacing side with it.
- **Window focus.** It is already a seam: the focuser is injected, and the target window is the native addon's concern. The `focusIRacing*` identifiers and the `focusIRacingWindow` setting keep their names. The setting is a persisted contract, and renaming only the code would buy nothing.

**The iRacing side is a new package, `@iracedeck/deck-iracing`,** depending on `deck-core`, `settings`, `replay-store` (for the subscriber) and `iracing-sdk`. It has the same shape `sim-events-iracing` has on the bus side: a future sim is a sibling `deck-<sim>`, chosen in `plugin-runtime` and nowhere else. It holds:

- **`IRacingSimConnection`:** implements `SimConnection` over `SDKController`. It maps `SessionFlags` through `resolveAllActiveFlags` and the template context through `resolveTemplate`, and falls back to `EMPTY_TEMPLATE_CONTEXT`, which moves here too.
- **`IRacingAction<T> extends ConnectionStateAwareAction<T>`:** adds `protected get sdkController(): SDKController`. The 27 action files that read the controller extend it; every other action stays on `ConnectionStateAwareAction`.
- **`sdk-singleton`** (`initializeSDK`, `getSDK`, `getController`, `getCommands`), whose `initializeSDK` also calls `initializeSimConnection`.
- **The remaining iRacing helpers:** `app-monitor`, `fuel-telemetry`, `unit-conversion`, `iracing-hotkeys`, `elevation-check`, `elevation-warning`, and `replay-session-subscriber` (typed on `SessionInfo`).

**A lint guard keeps the seam.** An ESLint `no-restricted-imports` rule on `packages/deck-core/src/**` forbids `@iracedeck/iracing-sdk`, `@iracedeck/iracing-native`, `@iracedeck/sim-events-iracing` and `@iracedeck/deck-iracing`. `deck-core/package.json` drops the `iracing-sdk` dependency, so even a type-only import fails to resolve.

### The package map

Each package depends only on packages above it in this table, and every package is named for one concern.

| Package | Owns | Depends on (internal) |
| --- | --- | --- |
| `app-constants` (leaf) | <ul><li>Setting-key names: run-scoped and warning keys (`PI_WARNINGS_KEY`, …), the voice-pack keys and `ENSURED_VOICE_PACK_ID`, `PROFILE_CAPTURE_STATUS_KEY`, the dev-base-url key.</li><li>Value sets: `VOICE_PACK_INSTALL_PHASES`, the changelog notification policies.</li><li>Settings-window ids and `SETTINGS_WINDOW_HTML`.</li><li>Modules: `focus-iracing-mode`, `sim-pointer-target`, and `key-binding-defaults` (moved from deck-core's subpath).</li></ul> | none |
| `fetch-utils` (leaf) | `abortAfter`, `readCappedJson` | none |
| `settings` | `global-settings`, its migrations, `settings-store`, `run-scoped-settings`, `json-error-location`, `pi-warnings`, `setup-warning*`, `settings-file-rejection-*`, `first-run`, `feature-startup-*` | app-constants, callout-settings, callout-script |
| `deck-core` | `types`, `feedback-types`, the base classes, `sim-connection`, dial and icon modules, title modules, overlay, `device-profiles`, `profile-switcher`, `plugin-config`, `rasterizer-service`, bindings and the keyboard / clipboard / SimHub / window-focus / mouse-pointer services, `comm-descriptor`, `common-settings`, `migrate-legacy-action` | settings, app-constants, icon-composer |
| `voice-packs` | every `voice-*` module and `voice-script-warning*` | app-constants, fetch-utils, callout-script |
| `replay-store` | `replay-session-store`, `-file`, `replay-markers`, `replay-laps` | settings (its atomic-write and path helpers) |
| `diagnostics` | `main-thread-watchdog`, `resource-monitor`, `cpu-profile-capture` | app-constants |
| `app-updates` | `changelog-feed-client`, `changelog-html-sanitize`, `published-changelog`, `update-check`, `update-check-service`, `version-check` | app-constants, fetch-utils |
| `settings-window` | `settings-window*`, `chromium-browser`, `open-folder`, `settings-channel-publisher` | settings, app-constants, app-updates (types) |
| `deck-iracing` | the iRacing side above | deck-core, settings, replay-store, iracing-sdk |

`logger` and the third-party dependencies follow their modules: `fflate` to `voice-packs`, `ws` to `settings-window`, `semver` wherever it is imported, `keysender` (optional) stays with `deck-core`'s keyboard service. `audio-session-identity.ts` moves to `plugin-runtime`, which is now the shared home of plugin-layout knowledge and its only consumer.

Three rules make the map hold:

- **`app-constants` admits only constants, types and pure functions over them.** It has zero dependencies and uses no Node or DOM globals, so browser code and every layer can import it. A test refuses any import in its sources, as `key-binding-defaults`' test does today. `pi-components` imports it directly and its pinned copies are deleted, the unpinned ones too where the value is in the leaf. `pi-components`' Rollup subpath guard changes from "only `@iracedeck/deck-core/key-binding-defaults`" to "only `@iracedeck/app-constants`", and `deck-core`'s subpath export is removed.
- **`fetch-utils` is its own leaf** because `abortAfter` uses `AbortController` and timers, which the constants leaf's rule excludes. Putting it in `voice-packs` and having `app-updates` import it from there would make an update check depend on the voice-pack stack.
- **`settings` declares the host it needs.** It defines a narrow `SettingsHost` interface covering the global-settings read and write it actually calls, rather than importing `IDeckPlatformAdapter`. The adapter satisfies it structurally, so no adapter changes.

### One import path per name

`deck-core`'s barrel re-exports nothing that moved. Every importer switches to the new package in the same change as the move.

The reason is the 83 test files that mock `@iracedeck/deck-core`, 72 of them in `iracing-actions`, many to stub `getGlobalSettings`. If a name had two paths, an action importing it from `@iracedeck/settings` while its test mocks `deck-core`'s re-export would run the real function, and nothing would go red. The cost is a mechanical sweep: those tests gain a `vi.mock` of the new package, and the canonical mock block in `.claude/rules/testing.md` splits the same way. The existing `icon-composer` re-exports are not this issue's and stay.

The other relative-path reaches into `deck-core/src/` move in the change that moves their target:

- about 20 tests and scripts, including `audio-assets`' `pack-voice.test.ts`, `scripts/lib/voice-catalog-data.mjs` and the `iracing-actions` tests importing `dial-gesture` or `unit-conversion`;
- the stream-deck plugin's `src/shared/index.ts` re-export list;
- the hook scripts' hard-coded `packages/deck-core/src/global-settings.ts`.

### Delivery: five pull requests

The issue is delivered as five PRs. Each has its own sub-issue and `ir-<n>` worktree, and each updates the documentation it makes stale.

1. **The sim seam.** Contents:
   - `sim-connection` and `deck-iracing`;
   - `IRacingAction` and the 27 base-class switches;
   - the `hasElevationMismatch` injection;
   - the lint guard, and `iracing-sdk` dropped from `deck-core`'s dependencies;
   - the false claims corrected (below).

   It goes first because it delivers the second-sim value and its guard then protects every later move.
2. **The two leaves.** `app-constants` and `fetch-utils`, with `pi-components`' copies deleted. Settings cannot drop below `deck-core` until the constant cycles are gone.
3. **`settings`.** The `SettingsHost` interface and the mock sweep, the largest churn, kept apart.
4. **`voice-packs`.** 7,000 lines, plus the `audio-assets` test and catalog scripts that import it by path.
5. **`replay-store`, `diagnostics`, `app-updates`, `settings-window`.** Small, and mostly consumed by `plugin-runtime` alone.

### The false claims

PR 1 corrects these, listing what is actually true as known leaks in the Architecture page's "Seams & where the abstraction leaks" section rather than asserting the leaks away:

- **`.claude/CLAUDE.md` and `sim-events-iracing/src/index.ts`:** "sim-events-iracing is the ONLY package that consumes `iracing-sdk` telemetry".
- **`architecture.md`:** "a button … never reads telemetry itself".

The truth on `master` at the time of writing: 27 action files read `sdkController`, 15 call `getCommands()`, and 19 `audio-scenarios` catalog files read iRacing telemetry directly. After PR 1 the action reads go through `deck-iracing`'s `IRacingAction`, which gives the leak a name and a single place to find it.

### What #1349's spec assigned here

The #1349 spec, frozen since #1349 shipped, lists "a sim-neutral `SimRuntime` and a second translator" as #1351's. This spec declines both:

- **A second translator** needs a second sim in hand.
- **`SimRuntime`'s members** are the translator's query getters the Race Engineer reads. Making them sim-neutral is the read model, which is #714's gated design.

`SimRuntime` stays iRacing-shaped. The sim *connection* is what is neutral after this issue.

## Out of scope

- **The sim-agnostic telemetry read model and neutral event-catalog payloads.** That covers `carIdx`, the raw `irsdk_PitSvStatus` in `pitService.statusChanged` and the untyped `telemetry` envelope, and belongs to #714 / #643.
- **Porting actions or the Race Engineer catalog off direct iRacing telemetry reads.**
- **Sim-neutral commands, a sim-neutral `SimRuntime`, a second translator** (see above).
- **Renaming `focusIRacing*`, the `focusIRacingWindow` / `mouseToSim*` settings or any other persisted key.** No setting key, default or schema changes in any of the five PRs.
- **Import-boundary rules beyond `deck-core`'s,** and the review's other item-7 findings: relative cross-package test imports in general, the `vitest.config.ts` src aliases, and `pi-components` reading `iracing-actions` by path.
- **The `icon-composer` re-exports from `deck-core`.**

## Testing

Every PR passes the full set by hand before review: `install` → `build` → `typecheck` → `format` → `lint` → `test`. The build output is read, not just its exit code.

- **The guards are proven to fire.** Each check gets a planted violation that has to fail, run once by hand and recorded in the PR:
  - the `no-restricted-imports` rule on `deck-core`, against a planted `@iracedeck/iracing-sdk` import;
  - `app-constants`' no-import test, against a planted import.
- **The seam has unit tests against a fake `SimConnection`.** They cover the null connection before initialisation, readiness tracking in `ConnectionStateAwareAction`, the overlay starting and stopping on `activeFlags()` changes, and the title watcher re-resolving on tick. `IRacingSimConnection` is tested over `MockSDKController`: flag mapping, the disconnected empty flags, and the disconnected title fallback.
- **Nothing is lost in a move.** No behaviour changes in PRs 2–5, so the existing suites carry them. Each PR's test-file and test counts are compared with `master`'s, so a test silently dropped by a move shows up. The existing guards (`package-test-scripts`, `typecheck-script-coverage`, `tsconfig-base-inheritance`, `lint-format-coverage`) must stay green with the new packages enrolled, not exempted.
- **Manual test on a linked Stream Deck per PR, scoped to what moved:**
  1. Keys grey out and return with the sim connection, the flag overlay flashes on a flag, and a templated title updates live.
  2. The settings window renders with the warning banners and the voice-pack card phases.
  3. Settings persist across a restart, and the settings window opens and saves.
  4. The voice pack is ensured at start, and installing and removing one from the catalog works.
  5. Replay markers save and load, the update check runs, and a CPU-profile capture writes its files.

## Documentation changed with it

Each PR updates, for what it moved:

- the new packages' `CLAUDE.md` files, and `deck-core/CLAUDE.md`'s module map;
- `.claude/CLAUDE.md`'s package list;
- the rules naming `deck-core` paths: `global-settings.md`, `settings-window.md`, `keyboard-shortcuts.md`, `platform-feature-flags.md`, `plugin-structure.md`, `race-engineer-callouts.md` and `testing.md`'s mock block;
- the Architecture page's packages, seams and dependency graph;
- `README.md`'s project structure.

No user-facing change, so no changelog line.
