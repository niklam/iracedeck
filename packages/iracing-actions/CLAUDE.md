# @iracedeck/iracing-actions

The platform-agnostic iRaceDeck action classes — one folder per action under `src/actions/`. Actions contain no platform-specific code — they import from `@iracedeck/deck-core`, and the iRacing side (`SimIRacingAction`, `getCommands()`, the fuel, unit and hotkey helpers) from `@iracedeck/deck-iracing` (#1351), and shared constants and their pure helpers (today the Mouse to Sim target resolver) from `@iracedeck/app-constants` (#1364); Replay Markers and Replay Control reach the per-session replay store through `@iracedeck/replay-store`, and Telemetry Control's Capture Profile mode the CPU profile capture through `@iracedeck/diagnostics` (#1367). They are registered for all three plugins (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi`) through `@iracedeck/plugin-runtime`'s shared action list (`src/actions.ts`, #1349).

## Package Structure

```text
src/
  index.ts                               # Barrel export of all actions + UUIDs
  actions/
    <action-name>/                       # One folder per action, self-contained
      <action-name>.ts                   # Action class + UUID constant
      <action-name>.test.ts              # Unit tests
      <action-name>.ejs                  # Property Inspector template
      icon.svg                           # Category icon (20x20)
      key.svg                            # Key icon (72x72)
    race-admin/                          # Same layout plus non-action helper modules
                                         # (commands, modes, #732 selector slot math + icon,
                                         # #491 useViewedCar settings migration)
    replay-markers/                      # Same layout plus the dial split (#1230): the schema
                                         # both surfaces parse (replay-markers-settings.ts), the
                                         # store operations both share (replay-markers-ops.ts),
                                         # and the dial surface (replay-markers-dial-surface.ts)
    comms-catalog.ts                     # Authoritative per-(action, mode) comms source (#612)
    data/                                # Shared template data
      action-comms.json                  # GENERATED from comms-catalog.ts
      docs-urls.json
      icon-defaults.json
      key-bindings.json
      profiles.json                      # GENERATED bundled-profile registry (pnpm generate:action-profiles)
    settings/                            # Plugin-global PI template
      settings.ejs
  audio/                                 # Shared audio helpers: Race Engineer/Radar master gates and
                                         # the side effects of a gate change (feature-gates, #1007),
                                         # voice-sequence player + toggle acknowledgment
                                         # (audio-toggles), bus volume steppers (audio-volume)
  icons/                                 # status-bar: tri-state (on/off/na) toggle indication shared
                                         # by status bars, state borders, and dial bar styling
  shared/                                # Cross-action utilities (see below)
icons/                                   # Dynamic SVG templates (telemetry-driven)
```

`src/shared/` holds cross-action utilities:

- `adjust-styles.ts` — paired +/− key styles: style catalog, shared settings fields + fresh-key seeding, value-source gating over VIEW_DEFS, and the SVG renderer (spec: docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md)
- `black-box.ts` — canonical black-box id↔global-key map (`BLACK_BOX_GLOBAL_KEYS`, also consumed by `comms-catalog.ts`) plus `showBlackBox()` / `resolvePrimeKey()`: press a different box first, then the target, because a black-box hotkey toggles and telemetry never reports the shown box (#818). The prime matches the target's binding kind first (keyboard target → keyboard prime, SimHub target → SimHub prime); both keys keyboard-bound → one atomic key sequence (no flash), a SimHub role involved → a serialized tap-then-tap that presses the target only if the prime went out (#962)
- `car-cycle-bindings.ts` — the one home of iRacing's Next Car / Previous Car binding keys (`CAR_CYCLE_BINDING_KEYS`: `replayControlNextCar` / `replayControlPrevCar`, V / Shift+V), dependency-free because two actions tap them: Replay Control's Next Car / Previous Car modes and Camera Controls' Cycle by Track Order on the keypad and the dial (#1277). One sim control, one setting — `key-bindings.json` lists the pair under both `replayControl` and `cameraControls`; `CAR_CYCLE_BINDING_DEFAULTS` (`V` / `Shift+V`, literals rather than a JSON import so the plugin bundle does not carry `key-bindings.json`; a test cross-checks them against both sections) is what every plugin hands `@iracedeck/settings`' `seedBindingDefaultsIfAbsent` at startup, so an upgraded user who never opened a Replay Control Next / Previous Car panel does not get the #612 warning on CAR AHEAD / CAR BEHIND
- `car-select-intent.ts` — per-device intent deciding what a selector car-key press means (admin target vs camera focus, #790)
- `dial-box.ts` — the dial "dash box" dispatcher + `dialAppearanceFields` settings fragment: `renderDialBox(canvas, args)` takes the context's `DialCanvasProfile` and dispatches by `canvas.id` (an exhaustive switch — a new profile id stops compiling until it gets a drawing) to `renderStripBox` or `renderKnobBox` (#1013). Thirteen surfaces render through it — the seven Setup dials, Camera Editor Adjustments, Cockpit Misc, Force Feedback, Replay Markers, Splits & Reference and View Adjustment — resolving their per-setting accent plus user color overrides with `resolveDialBoxColors` (#811). Besides the label, value and `pending` slot, `DialBoxArgs` carries `sideMarker` (`"left"` / `"right"` for one lit side, #953, or `{ left, right }` for each side on its own), an optional `caption` line under the value, and `dimmed` to fade the whole box (#1230); all are additive, so a surface that passes none draws exactly as before. Fuel Service, Audio Controls, Camera Controls and Black Box Selector draw their own strip/knob pairs over the same colours.
- `dial-strip-box.ts` — `renderStripBox`, the Stream Deck+ 200×100 drawing, byte-pinned to its pre-#1013 output by `__fixtures__/dial-strip-box.json`. Identity-only labels are baseline-centered (`+0.36em`) so they sit truly centered rather than above center (#804)
- `dial-knob-box.ts` — `renderKnobBox`, the Stream Dock knob drawing at 176×112 (#1013): designed for that screen rather than scaled from the strip, with the same vocabulary (label, value, pending bar, binding warning). Its `KNOB_BOX_WIDTH` / `KNOB_BOX_HEIGHT` are the one knob size: the self-drawn knob renderers (Fuel Service, Audio Controls, Black Box Selector) import them rather than repeating 176×112
- `dial-fit.ts` — `fitValueFontSize`, the value-fitting both dash-box renderers share
- `dial-side-markers.ts` — the dash box's two side triangles (`renderSideMarkers`, `resolveSideMarks`, the `DialSideMarker` / `DialSideMarks` types): one drawing both renderers call, each side lit or dimmed on its own (#953 lit one; #1230 any combination)
- `dial-preview.ts` — `renderPendingBar`, the one #1120 hold-preview mark every renderer draws
- `dial-release.ts` — `classifyDialReleaseForHost`, the one release rule every dial surface calls: deck-core's `classifyDialRelease` where `__FEATURE_DIAL_EXTENDED_GESTURES__` is on; never `long` where it is off (`"push-turn"` after a pressed rotation, `"short"` otherwise) (#1013)
- `dial-context.ts` — `hasDialInputContext`, the one gate in front of every dial surface's input events (#1329): a `rotate` / `down` / `touchTap` acts only on a context `willAppear` / `didReceiveSettings` created, and one arriving after `willDisappear` is dropped with a single debug line (`Dial <event> dropped: no context for <id> (it has disappeared)`) before any side effect. Each surface calls it from its private `inputContext`, which hands an existing context to `ensureContext` so it is refreshed exactly as before (rule 11 in `.claude/rules/encoders-and-touchscreen.md`)
- `dial-name-icon.ts` — plain two-line action-name image for dial contexts (#775); push it with `pushDialNameIcon`, which sends it only on the `sd-plus-strip` profile — on a Stream Dock knob `setImage` IS the live screen (#1013). The `shared/dial-*` modules import deck-core and zod only; `dial-sim-agnostic.test.ts` keeps them free of `@iracedeck/iracing-sdk` / `@iracedeck/sim-events-iracing`
- `profile-entries.ts` — shared `_deviceProfiles` PI-dropdown entry building + echo-loop change guard (#790)
- `repeat-controller.ts` — long-press hold-to-repeat timing controller
- `replay-cursor.ts` — single, process-wide owner of iRacing's one replay cursor (#1203): a long-running driver (the fastest-lap walk, a record jump waiting for its landing) claims it, and any one-shot replay command in any action cancels the claim before it sends — the hidden legacy Replay Navigation, Replay Speed and Replay Transport included, every mode and dial path, owner `<action>-<mode>` (#1334). It also holds the two values the Replay Markers surfaces share (#1230): the pending landing of the last marker jump, and the last replay sighting behind `readReplayContext`'s debounced `inReplay` — iRacing reports `IsReplayPlaying` false for ~300 ms after every `setPlayPosition`, so leaving a replay counts only after `REPLAY_EXIT_GRACE_MS` (1 s) of false — except after a real exit to live: a `goToEnd` (Replay Control's Jump to Live, Replay Navigation's Jump to End) that was sent outside a saved replay drops the sighting at once through `noteReplayGoToEnd`, so an Add pressed straight after it files at the live edge; in a saved replay the same command only seeks to the end of the file, so the grace stands
- `replay-seek.ts` — `seekReplayFrame`, an absolute jump that waits until `ReplayFrameNum` reads the frame sent (#1275): iRacing covers a long jump in steps of at most `maxFramesToSearchPerUpdate` frames, and a command arriving mid-search cuts it short, so nothing may follow a jump until it lands. `waitForReplay` is the same poll for any other condition (the record jump waits for its pause to show). Shared by the fastest-lap walk and the record jump
- `replay-session.ts` — `isReplayOnlySession(sessionInfo)`: whether the loaded session is a saved replay (`WeekendInfo.SimMode === "replay"`, #604), where a replay command such as `goToEnd` only seeks instead of returning to the car (#1230). A local read; iracing-actions does not import `@iracedeck/sim-events-iracing`, which has its own copy for the translator.
- `setup-view.ts` — registry, formatters, and render helper for the setup actions' "View …" sub-modes (#541)
- `spotter-bindings.ts` — canonical AI Spotter control↔global-key map (`SPOTTER_GLOBAL_KEYS`, also consumed by `comms-catalog.ts`): the spotter has no SDK surface, and two actions dispatch its bindings — AI Spotter Controls (every control, keypad) and the Audio Controls dial's Spotter mode (louder/quieter on rotation, silence on press as Skip Spotter Call, #809/#1015)

The former `icon-update-throttle.ts` (per-context 10 Hz throttle + trailing-edge coalescer for telemetry-driven `setKeyImage` bursts, #493) moved to `@iracedeck/deck-core` in #899 — import `IconUpdateThrottle` from there.

The top-level `icons/` directory holds one 144x144 runtime template per dynamic-icon action (content rendered from live telemetry) — see the directory for the current set and `.claude/rules/icons.md` for the template format.

## Action Pattern

See `.claude/rules/stream-deck-actions.md` for the full requirements (UUID constant, `ConnectionStateAwareAction`, `CommonSettings`, icon assembly, super calls, settings handlers). An action that reads iRacing directly through `this.sdkController` (telemetry, session info, the template context, its own telemetry subscription) extends `@iracedeck/deck-iracing`'s `SimIRacingAction` instead, which adds the typed controller; one that only calls `getCommands()` does not need it. `deck-core`'s `ConnectionStateAwareAction` has no `sdkController`.

## Dial surfaces

A dial-capable action routes its dial events to a `*-dial-surface.ts` module beside it; `fuel-service/fuel-dial-surface.ts` is the reference and `.claude/rules/encoders-and-touchscreen.md` holds the rules. Two shapes every surface shares: the per-context state is created only by the lifecycle events (`willAppear`, `didReceiveSettings`, through `ensureContext`) while the input events go through `inputContext` and never create one (#1329); and where `__FEATURE_DIAL_EXTENDED_GESTURES__` is off the hold preview is deck-core's one `NOOP_HOLD_PREVIEW`, never a local copy (#1329). A test that drives dial input makes the dial appear first, since input on a context that never appeared is dropped.

Dial PIs switch between keypad and dial views through `@iracedeck/pi-components`' `dial-controller` partial; never a local `resolveController` / `applyDialView` (#1329).

## Comms Catalog (#612)

`src/actions/comms-catalog.ts` (in this package) is the authoritative record of how every (action, mode) talks to iRacing — API, key binding, or chat. Editing it in a Claude Code session regenerates `data/action-comms.json` through the post-edit hook; run `pnpm generate:action-comms` from the repo root otherwise. A freshness test (`comms-catalog.test.ts`) fails when the committed JSON drifts from the catalog, and a cross-check verifies every keybind key exists in `key-bindings.json`. The full wiring (PI status line, icon overlay) is in `.claude/rules/stream-deck-actions.md` §"Per-Mode Communication Method & Binding Status".

## Build

This package has **no build step**. It exports raw TypeScript source. Consumer packages (e.g., `iracing-plugin-stream-deck`) bundle it via their shared Rollup config (`@iracedeck/plugin-build`) with `@rollup/plugin-typescript`.

The shared factory (`createPluginRollupConfig` in `packages/plugin-build/src/plugin-rollup.mjs`, which all three plugins' `rollup.config.mjs` call) includes:
- `resolve-actions-ts` plugin — resolves `.js` → `.ts` for relative imports within this package and `@iracedeck/plugin-runtime`, the two raw-TypeScript packages
- `typescript({ include: ["src/**/*.ts", "../iracing-actions/src/**/*.ts", "../plugin-runtime/src/**/*.ts"] })` — compiles the plugin's, the actions' and the runtime's TypeScript (the globs are relative to the plugin package the build runs in)
- `svg` plugin — resolves `@iracedeck/icons/` and relative SVG imports (such as `../../icons/`) to their file and imports the SVG as a string

The full step order and options are in `packages/plugin-build/CLAUDE.md`.

## Tests

```bash
# The whole package (same as `pnpm test` inside packages/iracing-actions)
pnpm --filter @iracedeck/iracing-actions test

# Or a specific test file, from the monorepo root
pnpm test packages/iracing-actions/src/actions/splits-delta-cycle/splits-delta-cycle.test.ts
```

Tests mock `@iracedeck/deck-core` (not `@elgato/streamdeck`), and the global-settings names (`getGlobalSettings`, `getGlobalColors`, …) on `@iracedeck/settings` in a second factory, never on deck-core (#1365) — the canonical mock is in `.claude/rules/testing.md`. The iRacing names (`getCommands`, the fuel and unit helpers) are mocked on `@iracedeck/deck-iracing` with `importOriginal`, as that file shows. `@iracedeck/replay-store` and `@iracedeck/diagnostics` are mocked on their own packages where a test stubs one of their names (the Replay Markers, Replay Control and Telemetry Control tests); `replay-markers-dial-surface.test.ts` loads `replay-store`'s `src/replay-markers.ts` by relative path past that mock, so its fake store answers exactly as the real one does. `@iracedeck/app-constants` is a pure leaf with no imports, so tests use the real module rather than mocking it (`shared/mouse-to-sim.test.ts`). Binding-aware actions additionally stub `isBindingMissing` on the mock `ConnectionStateAwareAction` (see `splits-delta-cycle/splits-delta-cycle.test.ts`).

## Adding a New Action

See `packages/iracing-plugin-stream-deck/CLAUDE.md` for the full step-by-step guide. The action source file and PI template (`<name>.ejs`) stay in this package alongside the action code; action registration goes in `@iracedeck/plugin-runtime`'s shared action list (`src/actions.ts`), once for all three plugins, and the `manifest.json` entries in every plugin package (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi`).
