# Architecture review — 2026-10-09

> **Previous:** [2026-10-05](2026-10-05-architecture-review.md) · **Follow-ups:** [#1373](https://github.com/niklam/iracedeck/issues/1373) · [#1374](https://github.com/niklam/iracedeck/issues/1374) · [#1375](https://github.com/niklam/iracedeck/issues/1375) · [#1376](https://github.com/niklam/iracedeck/issues/1376) · [#1377](https://github.com/niklam/iracedeck/issues/1377) · [#1378](https://github.com/niklam/iracedeck/issues/1378) · **Related:** [#714](https://github.com/niklam/iracedeck/issues/714), [#643](https://github.com/niklam/iracedeck/issues/643)
>
> Point-in-time review of `master` at `3d8cc28b9` (v3.6.0-dev.0). The code and the developer [Architecture page](../../../packages/website/src/content/docs/docs/development/architecture.md) are the truth; this is not documentation. It is frozen once committed: a later review is a new dated file, never an edit to this one.

## Scope and method

Four days and 70 commits after the 2026-10-05 review, all three of its follow-ups have merged: [#1349](https://github.com/niklam/iracedeck/issues/1349) (one composition root), [#1350](https://github.com/niklam/iracedeck/issues/1350) (one callout opt-in registry) and [#1351](https://github.com/niklam/iracedeck/issues/1351) with its sub-issues #1363–#1367 (`deck-core` split, sim-connection seam). The questions were the same as last time — what is good, what is bad, how extendable the structure is, whether package boundaries are respected, and how ready it is for a second sim — plus a new one: what moved since the previous review.

Four read-only reviewers again took one seam each (sim and telemetry; deck platform; audio and Race Engineer; cross-cutting build, settings and process), using the previous review as the baseline. Each re-measured the old figures and re-ran its counts on `944b186f8` as well, so the old and new figures use the same method. The coordinator then re-measured the figures the conclusions rest on, and checked the sharpest new claims against the code. Figures marked **(verified)** were re-measured by the coordinator; the rest come from a single reviewer's measurement. Judgements are marked as such.

Line counts are non-test `.ts` lines under `src/` unless stated.

## Verdict

The three follow-ups did what they set out to do:

- **One composition root.** The composition root exists once.
- **One registry.** Each callout opt-in is declared in one place.
- **A real deck layer.** `deck-core` is now a deck layer of 6.6k lines with no simulator import, and a lint rule with a positive-control test enforces that.

What did not move is everything those issues deliberately left alone. The god modules are byte-for-byte unchanged, the native addons still fall back silently to fake data, and above the deck layer the sim seam is exactly as iRacing-shaped as it was. The refactors also left a trail:

- **Package count.** It rose from 25 to 38, and the boundary guards and the documentation have not kept pace with the split.
- **New iRacing-specific types.** The new wiring packages add types that a second sim would have to match.

The direction is right and the debt is smaller. What remains is mostly the work #714/#643 gate on a real second SDK, plus a round of tidying the split left behind.

## What moved since 2026-10-05

| #   | Previous finding                | Status                       | Now                                                                                                                                                                                  |
| --- | ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Composition root ×3             | **Fixed**                    | Shells are 22–24 lines (verified); `startPlugin` runs nine typed phases plus `connect()`, with the order pinned by `start-plugin.test.ts`; rollup configs are 9–11 lines over `plugin-build`; the harness calls `wireRaceEngineer` |
| 2   | `deck-core` catch-all           | **Mostly fixed**             | 6,555 lines / 32 files / 343-line barrel (verified), no sim import (verified). Remaining: 2.5k lines of OS input services and iRacing vocabulary without imports (item 9)             |
| 3   | Sim seam neutral only in types  | **Deck layer fixed; rest unchanged** | `SimConnection` is real for greying-out, the flag overlay and titles. Catalog reads, action reads, unchecked casts, payload encodings and the title vocabulary are unchanged (item 1) |
| 4   | Settings monolith, keys ×4      | **Fixed**                    | Each key is written once, in `callout-settings`; the schema and the EJS rows are generated from it; `global-settings.ts` 2,720 → 2,024 lines (verified)                             |
| 5   | God modules                     | **Unchanged** (one improved) | `translator.ts`, `state.ts`, `interpreter.ts` and `replay-control.ts` are untouched. `pit-crew/index.ts` 2,297 → 1,907 lines (verified), dependency bag 58 → 28 keys                |
| 6   | Silent mock fallback            | **Unchanged**                | Neither `index.ts` has been touched since the baseline (verified)                                                                                                                    |
| 7   | Boundaries by convention only   | **Improved a little**        | One ESLint boundary rule plus its test; everything else listed in item 4 below                                                                                                       |
| 8   | Singletons, implicit order      | **Order fixed; singletons moved, not removed** | The order is typed and tested. `_reset*` hooks 32 → 33; module-level nullable `let`s 75 → 61                                                                                    |
| 9   | Smaller items                   | **Mixed**                    | Adapter host calls moved behind a typed `PluginExtension`; the rest is listed in item 9 below                                                                                        |

## Baseline figures

The numbers a later review should re-measure. The "2026-10-05" column is re-measured on `944b186f8` with the same method as "Now", so where it differs from the previous review's own figure, see *Corrections* below.

| Measure                                                             | 2026-10-05                      | Now                                                            |
| ------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Packages                                                            | 25                              | 38 (verified)                                                  |
| Declared `@iracedeck` edges (dep + dev) / longest dependency chain  | 96 / 6                          | 178 / 7                                                        |
| Package-level dependency cycles                                     | none                            | none (verified, with a positive control)                       |
| `plugin.ts` size, Stream Deck / Mirabox / Ulanzi                    | 1,796 / 1,734 / 1,740           | 22 / 23 / 24 (verified)                                        |
| `plugin-runtime`                                                    | —                               | 2,236 lines, 18 files (verified); `initSettings` alone is 457 lines (verified) |
| `deck-core` size / barrel                                           | 26.2k lines, 101 files / 904    | 6,555 lines, 32 files / 343 (verified)                         |
| `deck-core` files importing a sim package                           | 7                               | 0 (verified)                                                   |
| Places a callout opt-in key is written by hand                      | 4                               | 1                                                              |
| `calloutEnabled*` keys / `GlobalSettingsSchema` fields              | 100 / ~121                      | 100 / 139                                                      |
| `PitCrewDeps` keys                                                  | 58                              | 28                                                             |
| `audio-scenarios` non-test files importing `iracing-sdk` / either sim package | 9 / 15                 | 9 / 15                                                         |
| Unchecked `e.telemetry as TelemetryData` casts                      | 12 sites in 8 files             | 12 sites in 8 files                                            |
| Action files: `SimIRacingAction` subclasses or `sdkController` / `getCommands()` / `event-bus` | 27 / 15 / 2 | 27 / 15 / 2 (the 15 and 2 verified)                      |
| `sim-events-iracing/src/translator.ts` / `handleTick`               | 2,705 / 644                     | 2,705 / 644 (file untouched; verified)                         |
| `TranslatorState` top-level members                                 | 220                             | 220 (file untouched)                                           |
| `audio-scenarios/src/interpreter.ts`                                | 3,128                           | 3,128 (byte-identical; verified)                               |
| Largest action file                                                 | `replay-control.ts`, 2,611      | same, 2,611 (verified); `runFastestLapWalk` still 557          |
| Test files importing a sibling package's `src` by relative path     | 19                              | 16                                                             |
| Hand-kept `@iracedeck/*` aliases in `vitest.config.ts`              | 14                              | 24                                                             |
| `.claude/rules` total / largest file                                | 787k / 248k                     | 806k / 248k `race-engineer-callout-examples.md` (verified)     |
| Always-loaded rules + `.claude/CLAUDE.md`                           | 106k                            | 117k of Claude Code's 150k limit (verified)                    |
| `CLAUDE.md` files / chars                                           | 17 / 378k                       | 30 / 474k (verified)                                           |
| Top-level `scripts/*.test.mjs`                                      | 26                              | 29 (verified)                                                  |

### Corrections to the 2026-10-05 baseline

Three figures in the previous review do not reproduce on `944b186f8` with an explicit method, and should not be compared against:

- **"90 of about 121" `calloutEnabled*` fields.** The previous review gave 90; the baseline has 100. #1350's own frozen record holds exactly 100 keys.
- **"19 non-test `audio-scenarios` files import a sim package".** The true figure was 15. The 19 counted files that only name a package in a comment, and #1351's spec already corrected it.
- **"46 test files (32 in `iracing-actions`)" reaching into siblings by relative path.** Two reviewers each wrote a resolver that follows the import path; both found 19–20 at the baseline (15 in `iracing-actions`).

## What is good

- **The composition root is one, and it is a pipeline.**
  - `startPlugin` runs nine phase functions, and each takes its predecessors' outputs as typed parameters. The required order is now carried by types and pinned by `start-plugin.test.ts` against a call log recorded from the pre-#1349 `plugin.ts`. Before, it was comments written three times.
  - `scripts/plugin-shell-guard.test.mjs` keeps the shells thin.
  - `plugin-runtime/src/actions.test.ts` checks the shared action list against every manifest.
- **Host-only code is in one file.** The Elgato-only calls (`devices`, bundled profiles) sit behind a typed `PluginExtension` in `elgato-extension.ts`, and `plugin-runtime` has no host-name branches.
- **`deck-core` is a deck layer.**
  - It has no simulator import, and importing its barrel no longer loads the native addon.
  - `eslint.config.js:71-101` refuses the four sim packages, and `scripts/deck-core-sim-boundary.test.mjs` proves the rule fires for both value and type-only imports in each guarded package.
  - A second sim implements five methods of `SimConnection` in a sibling `deck-<sim>`. The pending-connection queue has a fake for tests.
- **One declaration per callout opt-in, typed end to end.**
  - `isCalloutEnabled(key: CalloutSettingKey)` makes the literal keys in actions compile-checked.
  - The Race Engineer settings partial shrank from 608 to 96 lines.
  - The previous version of every key and default is frozen in `settings/src/callout-settings-baseline.test.ts`.
- **One Race Engineer wiring path.** `race-engineer-wiring` (380 lines) builds `Required<PitCrewDeps>`, so a missing dependency fails typecheck in the one place the plugins and the harness share. The previous review's "silent for the wrong reason twice" harness drift is closed for the engine side.
- **The extracted packages are coherent, and the graph stays clean.**
  - The extracted packages: `voice-packs`, `settings`, `settings-window`, `replay-store`, `diagnostics`, `app-updates`, `app-constants`, `fetch-utils` and `deck-iracing`.
  - Every new package has an `exports` map.
  - No source file imports an `@iracedeck` package it does not declare.
  - There are still no cycles at 38 packages and 178 edges.
- **Two strong new guards.**
  - `app-constants/src/admission.test.ts` refuses every import form in that leaf, and its `types: []` removes Node and DOM globals.
  - `pi-components`' rollup guard admits only the two browser-safe leaves.
  - Together they removed the PI's copied constants.
- **The Architecture page's leak figures are exact.** Its "Seams & where the abstraction leaks" counts (26 subclasses, 15 `getCommands()` files, 15 catalog files, 8 `getLatestTelemetry()` readers) re-measure to the number.

## What is bad, ranked

### 1. Above the deck layer, the sim seam has not moved, and the new wiring is iRacing-typed — high for a second sim, medium otherwise

Everything item 3 of the previous review listed outside `deck-core` is unchanged:
- **Catalog sim reads.** 15 catalog files import a sim package, and 8 read raw telemetry through `getLatestTelemetry()`.
- **Unchecked casts.** The 12 `telemetry as TelemetryData` casts remain.
- **Session-type strings.** `"Lone Qualify"` is still compared in `radar-engine.ts:162` and `spotter-engine.ts:365`.
- **Payload encodings.** `pitService.statusChanged` still carries raw `irsdk_PitSvStatus` numbers, and `carIdx` appears in 6+ payloads.
- **Actions.** 27 action files read the SDK and 15 send commands.
- **Title templates.** The user-stored vocabulary is iRacing's (`telemetry.Speed`), even though the call path is now neutral.

That part is deliberately gated on #714/#643. What is new is that the packages #1349 and #1351 added carry iRacing types into the places a second sim would plug in:

- **`SimRuntime` is `typeof` 17 iRacing getters** (`race-engineer-wiring/src/sim-runtime.ts:29-47`, verified). A second translator would have to reproduce iRacing's function signatures, `getLiveCarPosition(carIdx)` included.
- **The catalog bypasses `SimRuntime`.** It imports `getLatestTelemetry`, `getSessionType`, `getStandingStart` and `isDamageRepairNeeded` directly from `sim-events-iracing` (verified for `getSessionType`: `rolling-start.ts:29`, `start-lights.ts:50`). Injecting a different runtime cannot redirect those reads. The harness works only because it runs the real iRacing translator. The previous review missed this.
- **`plugin-runtime` knows the sim in 7 files, not one.**
  - `Core.controller` is typed as the iRacing `SDKController` (`types.ts:11`).
  - Six phases import `deck-iracing`, `iracing-native` or `iracing-sdk` (verified).
  - `architecture.md:309` says "`initSim` is the only phase that knows which sim is running", which is false.
- **Catalog knowledge in the composition root.** `plugin-runtime/src/phases/sim.ts` reaches into `audio-scenarios`' pit-crew catalog for `OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID` to build a translator-side opt-in.
- **iRacing vocabulary below the seam, without imports.**
  - `deck-core`: `focusIRacingBeforeInput` runs on every keystroke, and it exports the `IRacingHotkeyPreset` type and an `isReady(…, iRacingConnected)` parameter.
  - `app-constants`: `focus-iracing-mode.ts` and `sim-pointer-target.ts`.
  - The window title is hard-coded in the addon (`addon.cc:574`).

  Mostly naming, but the window target and the hotkey presets are real per-sim knowledge.

Judgement: when #714 starts, `SimRuntime` should be built from what the catalog actually reads, including the getters it imports directly today. Typing it as `typeof` the iRacing functions locks in the shape a neutral model is meant to replace.

### 2. The native addons still fall back silently to fake data — medium

Unchanged and untouched since the previous review (verified):
- **The fallback.** On Windows, `iracing-native/src/index.ts:35-37` and `audio-native/src/index.ts:56-58` catch a failed `.node` load with a bare `catch {}` and use the mock. The mock's `startup()` returns `true` and serves believable rotating data.
- **No signal.** No log line, flag or `isMock` export surfaces it, and nothing in `plugin-runtime` checks for it.
- **The risk.** A user whose addon fails to load (AV quarantine, a missing VC++ runtime, a host locking the file — the last is a known local hazard) would see fake telemetry instead of an error.

This is the cheapest fix on this list, a log line and a flag, and still not filed.

### 3. The god modules are byte-for-byte unchanged, and two new ones arrived with the split — medium

| File                                               | Lines        | Problem                                                                                                                 |
| -------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `sim-events-iracing/src/translator.ts`             | 2,705        | `handleTick` (644 lines) calls 31 diff functions by hand in an order that matters; 28 query getters and the YAML parsing in the same file |
| `sim-events-iracing/src/state.ts` (`TranslatorState`) | 220 members | One flat bag handed to every diff module                                                                             |
| `audio-scenarios/src/interpreter.ts`               | 3,128        | `ScenarioEngine` (~2,570 lines, ~70 methods) does registration, vocabulary, compilation, arbitration and playback        |
| `audio-scenarios/src/catalog/pit-crew/index.ts`    | 1,907        | Smaller, but `registerPitCrew` is ~778 lines of hand-written `enabledIn` gates, `defineContract` loops and vocabulary calls |
| `iracing-actions/.../replay-control.ts`            | 2,611        | `runFastestLapWalk` is still 557 lines of replay-search domain logic inside an action                                   |
| `plugin-runtime/src/phases/settings.ts` / `voice-packs.ts` | 457 / ~450 per function | **New.** `initSettings` (lines 54–511, verified) and `initVoicePacks` are single functions: the god scope of the old `plugin.ts` moved without being split |
| `scenario-harness/src/scenario-shortcuts.ts`       | 3,358        | One shortcut list for every callout; grows with each one                                                                |

Judgement: the plugin-runtime phases are the cheapest of these to split now, while the code is fresh and the phase boundaries already exist.

### 4. Boundary enforcement lags the split — medium

The package count rose by half. The guards and the declared graph did not follow:

- **The sim-boundary lint covers 5 of the 7 packages that left `deck-core`.**
  - It omits `settings` and `voice-packs` (verified in `eslint.config.js`). Neither imports a sim today.
  - `settings` sits *below* `deck-core`, though. If it gained a sim dependency, `deck-core` would load the SDK transitively and nothing would go red.
  - The rule's own comment ("the packages split out of deck-core keep the same boundary") overstates its reach.
  - The rule matches exact names (`paths`), so subpaths and `import()` slip it. Today `tsc` and the undeclared dependency catch those, so the boundary holds through lint and the dependency list together, not through lint alone.
- **Vitest aliases.** They went from 14 to 24, one per new package, with no completeness check. Tests resolve aliased packages to `src` while builds use `dist`, and the adapters and `rasterizer` are not aliased at all. Every new package widens that split.
- **Relative reaches into sibling packages: 16 test files.** Examples include `audio-assets/src/pack-voice.test.ts` reaching `../../voice-packs/src/*.ts` while declaring the package, and 9 files importing `deck-core/src/dial-gesture.js`.
- **Reverse and cross-tree reads.** `pi-components/src/build/action-templates.ts:17` still reads `../../../iracing-actions/src/actions`, and `plugin-build/src/plugin-rollup.mjs` reads `../../../scripts/lib/*`.
- **The declared graph overstates the real one.**
  - The plugins declare workspace dependencies their shells no longer import. Mirabox declares 15 but imports 2 (verified); some are needed for the native externals (judgement).
  - The website declares `deck-core`, `audio-scenarios` and `audio-service` and imports none of them.
  - `audio-scenarios` still lists `audio-assets` as a runtime dependency that only its tests use.
  - `audio-assets` uses `callout-script` in production build scripts but declares it only as a devDependency, although `plugin-build` and the harness consume those scripts.
- **No test proves the `pi-components` browser guard fires.**

### 5. Wiring and settings still drift in places no compiler sees — medium

- **The harness's translator gets none of the Race Engineer's translator settings.**
  - `scenario-harness/src/main.ts:66` calls `initializeSimEventsIracing` with no options (verified).
  - `plugin-runtime/src/phases/sim.ts:27-60` passes six: the fuel margin, the corner lead, the gap threshold and minimum change, the opponent-flag opt-in gate and the opponent-flag range.
  - In the harness those settings never reach the translator, and the opponent-flag opt-ins are not enforced. #1349 shared the engine-side wiring; the translator side is still written twice.
- **Settings ↔ translator constants are mirrored by comment.** `fuelCalloutMarginLaps` and `cornerCalloutLeadSeconds` (`settings/src/global-settings.ts:421,436`, verified) say "Must match" a `sim-events-iracing` constant, and no test ties them.
- **Typed settings are read untyped.** Of the `(getGlobalSettings() as Record<string, unknown>).x` reads, 4 are in `race-engineer-wiring/src/pit-crew-deps.ts` and 14 in `plugin-runtime`'s phases. `GlobalSettings` now lives in its own typed package, so the casts only hide a future rename.
- **The frozen key baseline does not cover additions.** `callout-settings-baseline.test.ts` holds exactly the 100 pre-#1350 keys (verified). The 101st `calloutEnabled*` key, itself a persisted contract, gets no rename or default-change guard.

### 6. A new callout family still has hand-kept lists — medium-low

#1350 removed the settings and plugin duplication. What a family still needs by hand:

- **A new live dependency is written in about 6 places across 3 packages:**
  - the `PitCrewDeps` key
  - its default
  - the destructure in `registerPitCrew` (unchecked)
  - the translator getter
  - the `SimRuntime` type and `createIracingSimRuntime`
  - `buildPitCrewDeps`
- **Per-family lists a family descriptor could derive:**
  - `SCENARIO_ID_TO_*` maps (17 across the catalog)
  - `<FAMILY>_SCENARIO_IDS`
  - `<FAMILY>_CLIP_SOURCES` literals in 28 files
  - the `registerPitCrew` gate, contract loop and vocabulary call
- **A count floor bumped by hand:** `CATALOG_FLOOR = 159`.
- **Two first-party voices.** With two first-party voices, every callout is authored, generated and catalog-bumped twice. #1180, a new event with no opt-in of its own, touched 24 files across 7 packages.

The contract, script and clips earn their ceremony. The lists above do not.

### 7. Singletons and init naming: moved, not reduced — low-medium

- **The singletons were moved, not reduced.** Module-level state was redistributed, not removed: `deck-core`'s 26 singletons are now spread over `deck-core` (12), `settings` (7), `deck-iracing` (5) and one each in three other packages.
- **`_reset*` test hooks:** 32 → 33.
- **Naming got worse.**
  - There are 13 `initialize*` functions, 6 library `init*` functions and 7 phase functions also named `init*`.
  - `initMousePointer` and `initWindowFocus` still have no `is*Initialized`.
- **"One sim and one engine per process"** is still baked in. The typed phase pipeline makes this matter less than it did.

### 8. Documentation drift from the split — low-medium

Each of these contradicts the code, and the project's rule is that docs move in the same change:

- **Architecture page (`architecture.md`).**
  - **Line 309.** It says "`initSim` is the only phase that knows which sim is running", which is false (item 1). It also calls the iRacing-shaped `SimRuntime` "#1351", but #1351 is closed and its spec handed that work to #714.
  - **Line 6.** "Add a device by writing one new adapter, and nothing else changes" still overstates. A fourth host also needs a protocol client, a copied file logger, a `PLATFORMS` entry in `plugin-build`, a feature-flags entry, a hand-written manifest (572–905 lines today), a `HOST_EXTRAS` test entry and possibly a PI bridge.
  - **The Mermaid graph.**
    - It does not draw `audio-scenarios → iracing-sdk`, which is a production edge and the seam's main leak, and it does not name that edge among the omissions.
    - It also leaves out `iracing-actions → iracing-sdk` and `→ audio-service`, and `plugin-runtime → callout-script` and `→ iracing-native`.
    - It places `audio-assets` in a "no internal deps" box.
- **Stale comments.** These still claim the translator is the only telemetry reader:
  - `sim-events-iracing/src/translator.ts:6-7`
  - `plugin-runtime/src/phases/sim.ts:21-23`

  And these still point at #1351 for a sim-neutral `SimRuntime`:
  - `race-engineer-wiring/src/sim-runtime.ts:6-7`
  - `race-engineer-wiring/CLAUDE.md`
- **`packages/audio-scenarios/CLAUDE.md` lists 8 catalog files that do not exist** (`position-range.ts`, `pools.ts`, `welcome.ts`, `tips.ts`, `pit-exit.ts`, `pit-approach.ts`, `service-reminder.ts`, `stall-departure.ts`, verified). `pools.ts` is cited in `race-engineer-callouts.md` too.
- **README.**
  - Its structure tree lists 28 of the 38 packages, missing the whole audio and Race Engineer stack.
  - It gives the action count as "33 actions" in one place and "32" in another, and nothing re-checks either against `SHARED_ACTIONS`.
- **`.claude/CLAUDE.md`.**
  - It says `startPlugin` runs "ten startup phases"; there are nine plus `connect()`.
  - It says `callout-script` has "three consumers"; eight packages declare it.

### 9. Smaller items — low

- **The dead re-export.** `iracing-plugin-stream-deck/src/shared/index.ts` (94 lines) still has no importers (verified), and #1365 updated it rather than deleting it. The 2,724 lines of `deck-core` tests still live in that plugin, three of them under the same names as `deck-core`'s own tests.
- **Two near-identical file loggers.** The Mirabox and Ulanzi adapters still carry `file-logger.ts` files (147 and 145 lines) that differ in 6 code lines.
- **`IDeckPlatformAdapter` capabilities.** They are now expressed five ways: optional members, no-ops, a nullable `logLocation`, build flags and the extension's presence. `switchToProfile` is called only through the concrete Elgato adapter, so the Mirabox and Ulanzi no-ops implement a member nobody calls through the interface. `deviceType` is still documented as Elgato's `DeviceType` (`deck-core/src/types.ts:28`).
- **A test fixture in shipped source.** `deck-core/src/fake-sim-connection.ts` is test support that is not named `.test.ts`, so it ships in `dist`.
- **`app-constants` is grouped by "browser-safe, zero imports", not by domain.** It already holds iRacing-specific constants and is the likeliest next catch-all.
- **`pi-components` still copies three helper sets.** They are the voice-id helpers (`voice-select.ts:50-82`), `stripTakeSuffix` and the catalog-URL resolver. It has to, because `callout-script` carries zod; a zod-free subpath export would remove the copies.
- **`replay-store` depends on all of `settings`** for two path helpers and a retry schedule.
- **`iracing-sdk` still holds generic helpers** (`gap-utils`, `wind-utils`, `expression-evaluator`).
- **Two packages ship as raw `src`.** `iracing-actions` (39.7k lines) and now `plugin-runtime` are compiled again by each of the three plugins.
- **Two actions read the SDK at module level through `getSDK()`** (`car-control.ts:176`, `tire-service.ts:216`), outside the `SimIRacingAction` path.
- **`turbo.json` repeats** an identical ~15-line `build` block for each plugin.

## Extensibility

| Change                            | 2026-10-05       | Now                  | Why                                                                                                                                                                       |
| --------------------------------- | ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New first-party voice pack        | Low              | Low-moderate         | A config, clips and catalog entry, plus `VOICE_PACKS` / `FIRST_PARTY_SCRIPTS` rows and full coverage of 159 contracts; each pack also raises the cost of every later callout |
| Third-party voice pack            | Low, by design   | Low, by design       | Unchanged                                                                                                                                                                 |
| New action                        | Moderate, linear | Moderate, linear     | About 8 touch points: one `SHARED_ACTIONS` entry instead of three registrations; three manifests, parity-tested                                                           |
| New callout in an existing family | Moderate         | Low-moderate         | Its opt-in key is one registry line; what remains is the catalog lists and generated artifacts                                                                            |
| New callout family                | High             | Moderate-high        | About 28–30 files across 8 packages, about 15 hand-written; the settings plumbing is down to 3 files in one package; a new live dependency is still ~6 places (item 6)     |
| New deck host                     | High             | Medium               | An adapter plus protocol client (~0.9–1.3k lines), a copied logger, a hand-written manifest and possibly a PI bridge; the shell and rollup config are ~20 lines together  |
| Second sim                        | Very high        | High                 | The deck layer now carries over (a `SimConnection` in a sibling `deck-<sim>`). About half the catalog, 27 actions, the payload encodings, the title vocabulary and the iRacing-typed `SimRuntime` do not |

The previous review's conclusion still holds: a second sim would at first get only the Race Engineer events the catalog expresses neutrally. Item 1's direct catalog reads are the first thing to move, and `SimRuntime` is now the obvious place to move them to.

## The process layer

Judgement, not a defect. The rules grew from 787k to 806k characters, and the largest file is still `race-engineer-callout-examples.md` at 248k. `CLAUDE.md` files went from 17 to 30, because every new package got one; the new ones are small (11–63 lines), and the big three are unchanged. The always-loaded set is now 117k of the 150k-character limit. 6.9k of the 11k growth since the last review is `.claude/CLAUDE.md`'s package list, which grows by about 0.5–1k per package. If the session's auto-memory index loads against the same limit (unverified), the headroom is nearer 13k. The hooks barely moved; three meta-tests were added (`deck-core-sim-boundary`, `plugin-shell-guard`, `lint-format-coverage`).

The cost of a package is now mostly outside the code:
- an `.claude/CLAUDE.md` entry
- a package `CLAUDE.md`
- Architecture-page edges
- a README row
- a vitest alias

The README has already fallen behind (item 8), which shows that cost in practice. The package list in `.claude/CLAUDE.md` is now the largest single piece of the always-loaded set to grow per change.

Operational, not architectural: the gitignored local turbo cache in the `master` checkout is 87 GB across about 50k files (verified), and nothing prunes it.

## Follow-ups

Filed with this review, in the order it would take them:

1. [#1373](https://github.com/niklam/iracedeck/issues/1373): the silent native mock fallback, with a log line and a mock flag in both addons (item 2). Small and user-facing.
2. [#1374](https://github.com/niklam/iracedeck/issues/1374): documentation drift from the split, including the Architecture page's `initSim` and one-adapter claims (item 8).
3. [#1375](https://github.com/niklam/iracedeck/issues/1375): boundary tidy-up. Lint coverage for `settings` and `voice-packs`, a vitest-alias completeness check, pruning the plugins' vestigial dependencies, and deleting `shared/index.ts` (items 4, 9).
4. [#1376](https://github.com/niklam/iracedeck/issues/1376): harness ↔ plugin translator-settings parity, the settings ↔ translator constant mirror, the untyped settings casts, and a guard for callout keys added after the baseline (item 5).
5. [#1377](https://github.com/niklam/iracedeck/issues/1377): splitting `initSettings` and `initVoicePacks` into their sub-steps (item 3).
6. [#1378](https://github.com/niklam/iracedeck/issues/1378): routing the catalog's direct `sim-events-iracing` reads through a declared `SimRuntime`, as input to #714 rather than ahead of it (item 1).

Not proposed: the remaining god modules (`translator.ts`, `interpreter.ts`, `replay-control.ts`), the per-family descriptor (item 6) and the singleton naming (item 7). Each is worth doing, but none is getting worse fast enough to schedule ahead of the above.
