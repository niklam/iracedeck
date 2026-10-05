# Architecture review — 2026-10-05

> **Follow-ups:** [#1349](https://github.com/niklam/iracedeck/issues/1349) · [#1350](https://github.com/niklam/iracedeck/issues/1350) · [#1351](https://github.com/niklam/iracedeck/issues/1351) · **Related:** [#714](https://github.com/niklam/iracedeck/issues/714), [#1104](https://github.com/niklam/iracedeck/issues/1104), [#643](https://github.com/niklam/iracedeck/issues/643)
>
> Point-in-time review of `master` at `944b186f8` (v3.6.0-dev.0). The code and the developer [Architecture page](../../../packages/website/src/content/docs/docs/development/architecture.md) are the truth; this is not documentation. It is frozen once committed: a later review is a new dated file, never an edit to this one.

## Scope and method

The questions were: what is good, what is bad, how extendable the package structure is, and whether package boundaries are respected. Particular weight on readiness for a second simulator, which is on the roadmap.

Four read-only reviewers each took one seam (sim/telemetry; deck platform; audio and Race Engineer; cross-cutting build, settings and process), weighing the documented claims in `.claude/CLAUDE.md`, the package `CLAUDE.md` files and the Architecture page against the code. The coordinator then re-measured the figures the conclusions rest on. Figures marked **(verified)** were re-measured by the coordinator; the rest come from a single reviewer's measurement. Judgements are marked as such.

Line counts are non-test `.ts` lines under `src/` unless stated.

## Verdict

The inner pieces are designed well, but the outer edges are not. The translator's diff modules, the event bus mechanism, the callout-script grammar and the leaf packages are clean, and dependencies flow the right way. Three things are weak: the composition root is copied into all three plugins; `deck-core` has grown into a catch-all; and the sim seam is neutral in the type definitions but not in what the code actually reads. None of it is urgent, but each gets more expensive with every callout and action added.

## Baseline figures

The numbers a later review should re-measure to see what moved.

| Measure                                                                            | Value                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Package-level dependency cycles                                                    | none (verified)                                       |
| `plugin.ts` size, Stream Deck / Mirabox / Ulanzi                                   | 1,796 / 1,734 / 1,740 lines (verified)                |
| Code lines differing, Mirabox vs Ulanzi `plugin.ts` (comments and blanks stripped) | 4 (verified)                                          |
| `registerAction` calls per `plugin.ts`                                             | 37 (verified)                                         |
| `*_CALLOUT_SETTING_KEYS` maps imported per `plugin.ts`                             | 30 (verified)                                         |
| `deck-core` size / barrel                                                          | 26.2k lines, 101 files / 904-line `index.ts`          |
| `deck-core` voice-pack code (`voice-*`)                                            | 7,036 lines, 27% (verified)                           |
| `deck-core` files importing `@iracedeck/iracing-sdk`                               | 7 (verified)                                          |
| `calloutEnabled*` fields in `GlobalSettingsSchema`                                 | 90 of about 121 (verified)                            |
| `audio-scenarios` non-test files importing `iracing-sdk` / either sim package      | 9 / 19 (verified)                                     |
| Action files importing `@iracedeck/event-bus`                                      | 2, both in `session-info` (verified)                  |
| Action files reading `sdkController` telemetry directly                            | about 26                                              |
| `sim-events-iracing/src/translator.ts`                                             | 2,705 lines (verified); `handleTick` about 645        |
| `audio-scenarios/src/interpreter.ts` / `pit-crew/index.ts`                         | 3,128 / 2,297 lines (verified)                        |
| Largest action file                                                                | `replay-control.ts`, 2,611 lines                      |
| Test files importing a sibling package by relative path                            | 46                                                    |
| `.claude/rules` total / largest file                                               | 787k chars / `race-engineer-callout-examples.md` 248k |

## What is good

- **No cycles, and dependencies flow downward.** Lower layers receive what they need by injection rather than importing upward: `SDKController.setLivePositionsProvider`, the translator taking settings as closures rather than depending on `deck-core`, the rasterizer injected into `deck-core`. That is what lets `scenario-harness` run the real translator against a mock controller.
- **The leaf packages are exemplary.** `callout-script` depends only on `zod` and gives four consumers (`deck-core`, `audio-scenarios`, `audio-assets`, `scenario-harness`) one grammar without them depending on each other. `icon-composer`, `rasterizer`, `logger` and `track-data` have no internal dependencies.
- **The diff modules are uniform.** Each event family is one `diffX(state, telemetry, …, emit)` file under `sim-events-iracing/src/diff/`, emitting a typed `PendingEvent`, so a new family has an obvious shape.
- **The Race Engineer engine core is sim-independent.** `interpreter.ts`, `dsl.ts` and `script-compiler.ts` import neither `iracing-sdk` nor `sim-events-iracing`; the bus, audio service, manifest and voice are constructor-injected, and `ScenarioContext.telemetry` is `unknown`.
- **The contract/script split is sound.** Code owns the callout contracts; packs own the scripts. The grammar is deliberately small (`!` is the only operator, `case` keys are declared up front), an unknown name skips one callout with one warning, and pack lint has something concrete to check. A third-party pack cannot break more than one callout.
- **The voice-pack stack is injected, not wired.** `voice-pack-service.ts` imports only `callout-script` and `logger` and hands scripts to the engine through an `applyScripts` dependency; `deck-core` does not depend on the audio packages.
- **The stated boundary rules hold.** Nothing outside the Elgato adapter imports `@elgato/streamdeck`; no production code imports another package's `src/` or `dist/`; most packages declare an `exports` map.
- **The build is strict:** `noEmitOnError` in every rollup config, typecheck reaching every test file, the native addons behind one mock switch with a meta-test proving it applies, and explicit supply-chain settings.
- **The Architecture page is candid.** Its "Seams & where the abstraction leaks" section names the command path and the action layer's direct SDK imports. It does not list every leak (below), but it does not pretend there are none.

## What is bad, ranked

### 1. The composition root exists three times — high

The three `plugin.ts` files are near-copies. With comments and blank lines stripped, Mirabox and Ulanzi differ by four lines (the adapter import and constructor); Stream Deck differs by about 25 code lines, all host capabilities (log level, log location, device list, profiles).

Each copy re-implements the whole startup order: SDK → event bus → `initializeSimEventsIracing` with about 25 injected getters → keyboard → `initializeAudio` → about 300 lines of voice-pack services → `registerPitCrew` with its `calloutEnabled*` closures → settings store and window → 37 `registerAction` calls. That order is load-bearing (several subscriptions must happen "BEFORE `registerPitCrew`") and is written down only as comments, three times; the Mirabox and Ulanzi copies already defer to "see iracing-plugin-stream-deck plugin.ts for the full rationale". The three `rollup.config.mjs` files (362–405 lines) are near-copies too. `scenario-harness` wires `registerPitCrew` a fourth time, and its own comment records that a dependency missing there "has made a call silent for the wrong reason twice already".

This is the largest single source of cost found: every startup change and every new callout family is three edits with no test keeping them in step, and a fourth deck host would be a fourth copy. For a second sim, the translator would have to be chosen in three places plus the harness. → [#1349](https://github.com/niklam/iracedeck/issues/1349) (with [#1104](https://github.com/niklam/iracedeck/issues/1104) as its voice-pack slice).

### 2. `deck-core` is a catch-all, not a platform layer — high

| Concern                                                                        | ~Lines       |
| ------------------------------------------------------------------------------ | ------------ |
| Voice-pack stack                                                               | 7,040 (27%)  |
| Global settings and store                                                      | 3,550        |
| Settings window                                                                | 1,930        |
| Replay session store                                                           | 1,900        |
| Diagnostics (watchdog, CPU profiles, resources)                                | 1,460        |
| Changelog, update and version checks                                           | 1,010        |
| iRacing helpers                                                                | 980          |
| The deck abstraction itself (base classes, types, dial, icon, title, profiles) | ~3,000 (11%) |

It imports `iracing-sdk` in seven files: `sdk-singleton.ts` (`createSDK`, `Commands`), `connection-state-aware-action.ts` (every action's `sdkController` is the iRacing `SDKController`), `base-action.ts` (flag overlays from `SessionFlags`), `fuel-telemetry.ts` (`PitSvFlags`), `title-template.ts`, `unit-conversion.ts` (`DisplayUnits`) and `replay-session-subscriber.ts`. `app-monitor.ts`, `focus-iracing-mode.ts`, `iracing-hotkeys.ts` and `sim-pointer-target.ts` are iRacing-specific without importing the SDK. Through that chain, importing the barrel loads the native addon.

"Platform-agnostic" therefore means "agnostic about the deck host", which `deck-core/CLAUDE.md` says but `.claude/CLAUDE.md` does not. The voice-pack stack is cleanly injected, so moving it out is a cohesion fix, not untangling coupling. Browser code cannot import `deck-core`, so `pi-components` keeps test-pinned copies of its constants (`cpu-profile-capture-constants.ts` and others). → [#1351](https://github.com/niklam/iracedeck/issues/1351).

### 3. The sim seam is neutral in the types, not in practice — high for a second sim, medium otherwise

- **The callout catalog reads iRacing directly.** 19 non-test `audio-scenarios` files import a sim package; they read raw `SessionFlags` bits, `PitSvStatus`, `TrkLoc` and `dcPitSpeedLimiterToggle` through `getLatestTelemetry()`, and match session-type strings such as `"Lone Qualify"` (`radar-engine.ts`). The engine is sim-independent; about half the catalog is not.
- **Actions barely use the bus.** Only the two `session-info` files import it; about 26 action files read `sdkController` directly and 15 call `getCommands()`. Two documented claims are therefore false: `architecture.md` ("a button never reads telemetry itself") and `.claude/CLAUDE.md` / `sim-events-iracing/src/index.ts` ("the ONLY package that consumes iracing-sdk telemetry").
- **The envelope is `unknown` and consumers cast it unchecked.** `e.telemetry as TelemetryData | null` appears in `flag-alerts.ts`, `no-limiter.ts`, `pit-limiter.ts`, `rolling-start.ts`, `session-start.ts` and `caution.ts`. A second translator would compile cleanly and feed those consumers `undefined` fields.
- **Some catalog payloads carry iRacing encodings.** `pitService.statusChanged` sends raw `irsdk_PitSvStatus` numbers beside a comment saying the bus stays sim-agnostic; `carIdx` / `followCarIdx` is a per-sim id space that consumers pass back into `getLiveCarPosition`.
- **User title templates name iRacing variables** (`telemetry.Speed`, via `iracing-sdk/src/template-context.ts`), so a stored-settings contract would need translating for a second sim.

The connection half of this (what the base classes need) is ungated → [#1351](https://github.com/niklam/iracedeck/issues/1351). The read model and payload neutralisation stay with [#714](https://github.com/niklam/iracedeck/issues/714) / [#643](https://github.com/niklam/iracedeck/issues/643), deliberately gated on a concrete second SDK, because a model designed against one sim is that sim's model in disguise.

### 4. One settings monolith, callout keys repeated by hand — medium-high

`global-settings.ts` is 2,720 lines; `GlobalSettingsSchema` has about 121 fields, 90 of them `calloutEnabled*`. Each callout's key is written in four places — the `*_CALLOUT_SETTING_KEYS` map in `audio-scenarios`, the Zod field, the EJS row, and the literal lists in `global-settings.test.ts` ("Keys must match … exactly") — tied together by comments and a test, not the compiler. With item 1, this is why one new callout touches about 20 files across 9 packages. The contract / script / clip steps earn their ceremony; the settings and plugin steps are duplication. → [#1350](https://github.com/niklam/iracedeck/issues/1350).

### 5. God modules — medium

| File                                            | Lines       | Problem                                                                                                                                                      |
| ----------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sim-events-iracing/src/translator.ts`          | 2,705       | `handleTick` (~645 lines) calls 30+ diff functions by hand in an order that matters; the same file holds about 30 query getters and the session-YAML parsing |
| `TranslatorState` (`state.ts`)                  | ~235 fields | One flat bag handed to every diff module, so families are not encapsulated from each other                                                                   |
| `audio-scenarios/src/interpreter.ts`            | 3,128       | `ScenarioEngine` does registration, vocabulary, compilation, per-bus arbitration and playback in one class                                                   |
| `audio-scenarios/src/catalog/pit-crew/index.ts` | 2,297       | Takes a 57-entry dependency bag                                                                                                                              |
| `iracing-actions/.../replay-control.ts`         | 2,611       | A ~557-line replay-search method — domain logic living inside an action                                                                                      |

Not filed.

### 6. A silent fallback to mock data in production — medium

`iracing-native/src/index.ts`: on Windows, a failed `require` of the `.node` falls into a bare `catch {}` and uses `IRacingNativeMock`, whose `startup()` returns `true` and serves rotating fake data (verified). No log line or flag surfaces it (verified). `audio-native` has the same shape. A user whose addon fails to load (AV quarantine, missing VC++ runtime, a host locking the file) would see believable fake telemetry instead of an error. Since #1084 this path runs in no automated check. Not filed.

### 7. Boundaries are enforced by convention only — medium

No import-boundary lint rule or dependency-cruiser. 46 test files reach into sibling packages by relative path (32 in `iracing-actions`). `pi-components/src/build/action-templates.ts` reads `../../../iracing-actions/src/actions` — a reverse dependency. Tests resolve packages to `src` through 13 hand-kept aliases in `vitest.config.ts` while builds resolve to `dist`, so tests and builds use different module graphs. `iracing-actions` (39.7k lines) ships as raw `src`, so each plugin compiles it again. [#1351](https://github.com/niklam/iracedeck/issues/1351) adds one guard (`deck-core` must not import `iracing-sdk`); the rest is not filed.

### 8. Singletons with an implicit startup order — low-medium

About 33 module-level singletons, 31 `_reset*` test hooks, and both `initialize*` and `init*` naming (`initMousePointer` and `initWindowFocus` have no `is*Initialized`). The required order lives in comments inside the copied `plugin.ts` files. It also bakes in "one sim and one engine per process" — fine today, and the main obstacle to testing the wiring as a unit. Partly addressed by [#1349](https://github.com/niklam/iracedeck/issues/1349).

### 9. Smaller items — low

- `iracing-plugin-stream-deck/src/shared/index.ts` is a "backward compatibility" re-export with no importers (verified); about 3.8k lines of `deck-core` tests live in the same folder, outside the package they test.
- The Mirabox and Ulanzi adapters carry near-identical `file-logger.ts` files (~145 lines each).
- `IDeckPlatformAdapter` expresses host capabilities four ways (optional members, no-op methods, nullable returns, build flags), documents `deviceType` as an Elgato `DeviceType`, and the plugins call host methods outside the interface (`streamDeck.devices`, `switchToBundledProfile`). So "add a device by writing one adapter, and nothing else changes" (`architecture.md`) does not hold.
- `audio-assets` is a runtime dependency of `audio-scenarios` but only its tests import it.
- `iracing-sdk` holds generic helpers (`gap-utils`, `wind-utils`, `expression-evaluator`) that consumers can only get by depending on the iRacing package.

## Extensibility

| Change                            | Cost             | Why                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New first-party voice pack        | Low              | A config, clips and a catalog entry; completeness tests point out what is missing                                                                                                                                                                    |
| Third-party voice pack            | Low, by design   | Can re-script existing contracts and add frames and pools; cannot add callouts or vocabulary                                                                                                                                                         |
| New action                        | Moderate, linear | About 10 touch points (three registrations, three manifests, comms catalog, docs, website), all guarded by tests                                                                                                                                     |
| New callout in an existing family | Moderate         | Mostly the settings and plugin duplication (items 1, 4)                                                                                                                                                                                              |
| New callout family                | High             | About 20 files across 9 packages                                                                                                                                                                                                                     |
| New deck host                     | High             | An adapter (0.5–1.4k lines) plus a fourth ~1,750-line `plugin.ts`, a rollup config, a manifest and possibly a PI bridge                                                                                                                              |
| Second sim                        | Very high        | The bus mechanism, the engine, the audio stack below scenarios, the adapters and the settings infrastructure carry over. About half the callout catalog, the `deck-core` SDK coupling, about 26 actions and the title-template variable names do not |

Many actions (pit macros, camera, replay, setup, chat) are inherently iRacing and would need per-sim action sets rather than shared ones. Realistically a second sim would at first get only the Race Engineer events the catalog already expresses neutrally, and even that needs item 3's catalog reads moved first.

## The process layer

Judgement, not a defect: `.claude/rules` totals 787k characters, of which `race-engineer-callout-examples.md` alone is 248k (about 62k tokens whenever its path matches); 17 `CLAUDE.md` files add 378k; the Claude Code hooks are about 2.4k lines plus 2.3k of tests (`rules-bash.mjs` 1,289 lines, mostly a shell lexer); about 25 top-level `scripts/*.test.mjs` meta-tests guard repo invariants. Each piece was added for a real incident and is well reasoned. Collectively it is becoming a second codebase, and several meta-tests guard a rule a structural change would make unnecessary. The size of the add-a-callout guidance (`race-engineer-callouts.md` plus the `audio-scenarios` `CLAUDE.md`) is a symptom of item 4, not a substitute for fixing it.

About 12 kinds of generated artifact are committed with freshness tests (`changelog.json`, `pack-reference.json`, `corners.iracing.ts`, `action-comms.json`, `icon-defaults.json`, the voice catalogs and manifests, 395 icon previews). That keeps diffs reviewable and the website free of engine imports, at the cost of six generators the post-edit hook must run and stale-artifact failures for a contributor outside a Claude session.

## Follow-ups

Ordered at the top of the board's Next lane for 3.6.0, so they get the whole dev cycle of testing:

1. [#1349](https://github.com/niklam/iracedeck/issues/1349) — one shared composition root (items 1, 8).
2. [#1350](https://github.com/niklam/iracedeck/issues/1350) — callout settings derived from one per-family registry (item 4).
3. [#1351](https://github.com/niklam/iracedeck/issues/1351) — split `deck-core` and put iRacing behind a sim-connection seam, including correcting the false documentation claims (items 2, 3, part of 7).

Not filed at the time of this review: the god modules (5), the silent mock fallback (6), boundary lint beyond `deck-core` (7), and the smaller items (9).
