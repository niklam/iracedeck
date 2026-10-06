# @iracedeck/plugin-runtime

The composition root the three deck plugins share (#1349). `startPlugin(host)` runs ten synchronous phases; a plugin's `plugin.ts` only builds its adapter (and on Stream Deck its `PluginExtension`) and calls it. Decision record: `docs/superpowers/specs/2026-10-05-issue-1349-shared-composition-root.md`.

## Phases (`src/phases/`, called in this order by `src/start-plugin.ts`)

| # | Phase | Takes | Returns |
| --- | --- | --- | --- |
| 1 | `initCore` | `PluginHost` | `Core` |
| 2 | `initSim` | `Core` | `SimRuntime` |
| 3 | `initInput` | `Core` | `Input` |
| 4 | `initAudio` | `Core` | `Audio` |
| 5 | `initVoicePacks` | `Core`, `Audio` | `VoicePacks` |
| 6 | `initRaceEngineer` | `Core`, `SimRuntime`, `Audio`, `VoicePacks` | — |
| 7 | `initSettings` | `Core`, `Audio`, `VoicePacks` | `Settings` |
| 8 | `registerActions` | `Core`, `Input` | — |
| 9 | `startServices` | `Core`, `Input`, `Settings`, `VoicePacks` | — |
| 10 | `adapter.connect()` | — | — |

A data dependency is a parameter, so a phase cannot run before what it needs exists. An ordering with no data edge stays inside one phase, adjacent, with its comment. `src/start-plugin.test.ts` records every effectful startup call (init, start, listener, registration, subscription, constructor, factory) against a fake adapter and fails naming the first call that moved or ran extra — update `expectedOrder()` there only for an intended change, and its `PURE_FACTORIES` set only for a new pure factory whose product goes straight into a recorded call.

## Rules

- Raw TypeScript, no build: each plugin's Rollup compiles `src/` (its `typescript` include and `.js`→`.ts` resolver name this package), and `@rollup/plugin-replace` substitutes the `__FEATURE_*__` constants here as in `iracing-actions`. `platform-features.d.ts` and `svg.d.ts` declare them for this package's own program.
- `src/actions.ts` is the only importer of `@iracedeck/iracing-actions`: the shared action list and the plugin-level hooks. A new action goes in `SHARED_ACTIONS` (or a host extension's `extraActions`) and every manifest; `src/actions.test.ts` fails until they match.
- Host differences arrive through `IDeckPlatformAdapter` (`setLogLevel`, `logLocation`, `openUrl`, `onOpenSettingsRequest`) or the optional `PluginExtension`. Test for the extension's presence, never for a host name.
- Never import from `src/index.ts` inside the package (a cycle fails the plugin build). Phases take their shared types from `src/types.ts`.
- Tests mock collaborators through `src/test-support/recorder.ts`; never initialise a real singleton (`initializeSDK`, `initializeEventBus`, …) in a test here. The `vi.mock` factory bodies live in `src/test-support/module-mocks.ts` (its header has the block to paste); each test file still names every mocked module, because `vi.mock` is hoisted per file. `src/test-support/fake-host.ts` builds the host, adapter and extension whose calls land in the same `callLog`; the adapter keeps its logger scopes in `scopes` and its event listeners to fire, and a file that builds hosts calls `cleanupTempBinDirs()` in `afterAll`. An unimplemented stub is a truthy function, so a test that depends on a settings branch implements `getGlobalSettings` — read the header of `recorder.ts` before writing an expected call list.
