# @iracedeck/iracing-actions

The platform-agnostic iRaceDeck action classes — one folder per action under `src/actions/`. Actions contain no platform-specific code — they import from `@iracedeck/deck-core`, and the iRacing side (`SimIRacingAction`, `getCommands()`, the fuel, unit and hotkey helpers) from `@iracedeck/deck-iracing` (#1351), and shared constants and their pure helpers (today the Mouse to Sim target resolver) from `@iracedeck/app-constants` (#1364); Replay Markers and Replay Control reach the per-session replay store through `@iracedeck/replay-store`, and every replay action sends its replay commands through `@iracedeck/replay-engine` (#1467), and Telemetry Control reaches `@iracedeck/diagnostics` for two modes: Capture Profile uses the CPU profile capture (#1367), and Take Snapshot collects the plugin's own state through `collectStateSections()` (#1387). The telemetry it writes beside that state is the tick the state was computed from, chosen by `selectSnapshotTelemetry` between the translator's latest tick (`getLatestTelemetry()` from `@iracedeck/sim-events-iracing`) and a fresh `getCurrentTelemetry()`. A fresh read can be one frame ahead of that state, and then the translator's tick is written. A fresh read of the same `SessionTick` is preferred, because the controller dispatches a tick once and iRacing goes on changing fields under a frozen one (the camera target in a paused replay), so the translator's copy can be as old as the pause. With no tick in the translator the fresh read is used. Nothing is awaited between the read and the collection, so no tick lands in between. They are registered for all three plugins (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi`) through `@iracedeck/plugin-runtime`'s shared action list (`src/actions.ts`, #1349).

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
    replay-control/                      # Same layout plus the dial split (#1316): the dial's
                                         # schema (replay-control-dial-settings.ts), the seam
                                         # between the surface and its rotation modes
                                         # (replay-control-dial-mode.ts), the modes — Speed
                                         # Control (replay-control-speed-mode.ts) over its ladder
                                         # (replay-speed-ladder.ts), Frame Jog
                                         # (replay-control-frame-jog.ts, #1317), and #801's Lap
                                         # and Session (replay-control-step-mode.ts, -lap-mode.ts,
                                         # -session-mode.ts), Incident (-incident-mode.ts) and Track
                                         # Order (-track-order-mode.ts), with the lap readout
                                         # (replay-dial-lap-readout.ts) — the dial surface
                                         # (replay-control-dial-surface.ts) and the per-car
                                         # arrays (replay-car-arrays.ts); the replay engine they
                                         # drive is @iracedeck/replay-engine (#1467)
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
                                         # (audio-toggles), bus volume steppers (audio-volume), the
                                         # audio session hold that keeps the device open while iRacing
                                         # runs and a gate is on (audio-session-hold, #1347)
  icons/                                 # status-bar: tri-state (on/off/na) toggle indication shared
                                         # by status bars, state borders, and dial bar styling
  shared/                                # Cross-action utilities (see below)
icons/                                   # Dynamic SVG templates (telemetry-driven)
```

`src/shared/` holds cross-action utilities:

- `adjust-styles.ts` — paired +/− key styles: style catalog, shared settings fields + fresh-key seeding, the repeat constants, value-source gating over VIEW_DEFS (the setup actions' value lookup), the value → no-value style mapping (`noValueFormOf`), and the SVG renderer with its opt-in `labelOnNoValueStyles` (spec: docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md). Used by the seven setup actions and, through `volume-key-styles.ts`, by the volume keys (#1453)
- `volume-key-styles.ts` — the same styles on the volume keys of Audio Controls and AI Spotter Controls (#1453): a `VolumeKeyDescription` (label, direction, an optional level reader the action hands in — this module imports from neither action), the stored-style resolution (a value style draws its no-value form on a key with no level; the stored value is never rewritten), the level text (`"55"` / `"OFF"`) and `renderVolumeKeyIconOrNull`, null for Legacy so the action falls back to its own icon. Each action keeps its own `RepeatController`, and every volume step, the first press and each repeat, goes through the action's `performVolumeStep` (spec: docs/superpowers/specs/2026-10-18-issue-1453-volume-key-styles.md)
- `black-box.ts` — canonical black-box id↔global-key map (`BLACK_BOX_GLOBAL_KEYS`, also consumed by `comms-catalog.ts`) plus `showBlackBox()` / `resolvePrimeKey()`: press a different box first, then the target, because a black-box hotkey toggles and telemetry never reports the shown box (#818). The prime matches the target's binding kind first (keyboard target → keyboard prime, SimHub target → SimHub prime); both keys keyboard-bound → one atomic key sequence (no flash), a SimHub role involved → a serialized tap-then-tap that presses the target only if the prime went out (#962)
- `car-cycle-bindings.ts` — the one home of iRacing's Next Car / Previous Car binding keys (`CAR_CYCLE_BINDING_KEYS`: `replayControlNextCar` / `replayControlPrevCar`, V / Shift+V), dependency-free because two actions tap them: Replay Control's Next Car / Previous Car modes and its dial's Track Order mode (#801), and Camera Controls' Cycle by Track Order on the keypad and the dial (#1277). One sim control, one setting — `key-bindings.json` lists the pair under both `replayControl` and `cameraControls`; `CAR_CYCLE_BINDING_DEFAULTS` (`V` / `Shift+V`, literals rather than a JSON import so the plugin bundle does not carry `key-bindings.json`; a test cross-checks them against both sections) is what every plugin hands `@iracedeck/settings`' `seedBindingDefaultsIfAbsent` at startup, so an upgraded user who never opened a Replay Control Next / Previous Car panel does not get the #612 warning on CAR AHEAD / CAR BEHIND
- `car-select-intent.ts` — per-device intent deciding what a selector car-key press means (admin target vs camera focus, #790)
- `dial-box.ts` — the dial "dash box" dispatcher + `dialAppearanceFields` settings fragment: `renderDialBox(canvas, args)` takes the context's `DialCanvasProfile` and dispatches by `canvas.id` (an exhaustive switch — a new profile id stops compiling until it gets a drawing) to `renderStripBox` or `renderKnobBox` (#1013). Fourteen surfaces render through it — the seven Setup dials, Camera Editor Adjustments, Cockpit Misc, Force Feedback, Replay Control, Replay Markers, Splits & Reference and View Adjustment — resolving their per-setting accent plus user color overrides with `resolveDialBoxColors` (#811). Besides the label, value and `pending` slot, `DialBoxArgs` carries `sideMarker` (`"left"` / `"right"` for one lit side, #953, or `{ left, right }` for each side on its own), an optional `caption` line under the value, and `dimmed` to fade the whole box (#1230), plus `reserveCaptionLine` (lay the value out for a caption with none drawn) and `neighbours` (dimmed short texts either side of the value, Replay Control's Track Order, #801), and `captionMark` (the replay busy look at the caption line's left end, drawn by `dial-caption-mark.ts`, #1437; a caption that gives way to it is left out with `reserveCaptionLine` set); all are additive, so a surface that passes none draws exactly as before — `dial-box-baseline.test.ts` pins every shape the surfaces pass, on both canvases, to `__fixtures__/dial-box-baseline.json`, captured before #801, and the caption mark's own shapes (`DIAL_BOX_MARK_BASELINE_SHAPES`) beside them. Fuel Service, Audio Controls, Camera Controls and Black Box Selector draw their own strip/knob pairs over the same colours.
- `dial-strip-box.ts` — `renderStripBox`, the Stream Deck+ 200×100 drawing, byte-pinned to its pre-#1013 output by `__fixtures__/dial-strip-box.json`. Identity-only labels are baseline-centered (`+0.36em`) so they sit truly centered rather than above center (#804)
- `dial-knob-box.ts` — `renderKnobBox`, the Stream Dock knob drawing at 176×112 (#1013): designed for that screen rather than scaled from the strip, with the same vocabulary (label, value, pending bar, binding warning). Its `KNOB_BOX_WIDTH` / `KNOB_BOX_HEIGHT` are the one knob size: the self-drawn knob renderers (Fuel Service, Audio Controls, Black Box Selector) import them rather than repeating 176×112
- `dial-fit.ts` — `fitValueFontSize`, the value-fitting both dash-box renderers share. A pure primitive with no dial dependency, so a keypad icon that draws a value in a fixed frame uses it too: Camera Controls' Switch by Car Number / Switch by Position keys, through `camera-controls/switch-target-value.ts` (#1352)
- `dial-side-markers.ts` — the dash box's two side triangles (`renderSideMarkers`, `resolveSideMarks`, `sideMarkGeometry`, the `DialSideMarker` / `DialSideMarks` types): one drawing both renderers call, each side lit or dimmed on its own (#953 lit one; #1230 any combination)
- `dial-label-fit.ts` — `labelClearsSideMarks(label, "strip" | "knob")`: whether a dash-box label leaves at least the room `INCIDENT` leaves between itself and the side marks on the knob (about 10 px a side), measured with the renderers' own geometry (#801). A mode label that fails it gets a shorter box label, as Track Order's `TRK ORD`
- `dial-text-width.ts` — `boldTextWidth`, bold Arial's advance widths (Arimo's too), for the checks where an overestimate is safe and an underestimate overlaps: the label fit and the neighbours (#801)
- `dial-value-neighbours.ts` — `renderValueNeighbours`, the `neighbours` slot both renderers draw: one shared size up to the canvas's cap that fits the room the value leaves, the pair dropped below 9 px rather than overlap (#801)
- `dial-preview.ts` — `renderPendingBar`, the one #1120 hold-preview mark every renderer draws
- `dial-release.ts` — `classifyDialReleaseForHost`, the one release rule every dial surface calls: deck-core's `classifyDialRelease` where `__FEATURE_DIAL_EXTENDED_GESTURES__` is on; never `long` where it is off (`"push-turn"` after a pressed rotation, `"short"` otherwise) (#1013)
- `dial-context.ts` — `hasDialInputContext`, the one gate in front of every dial surface's input events (#1329): a `rotate` / `down` / `touchTap` acts only on a context `willAppear` / `didReceiveSettings` created, and one arriving after `willDisappear` is dropped with a single debug line (`Dial <event> dropped: no context for <id> (it has disappeared)`) before any side effect. Each surface calls it from its private `inputContext`, which hands an existing context to `ensureContext` so it is refreshed exactly as before (rule 11 in `.claude/rules/encoders-and-touchscreen.md`)
- `dial-name-icon.ts` — plain two-line action-name image for dial contexts (#775); push it with `pushDialNameIcon`, which sends it only on the `sd-plus-strip` profile — on a Stream Dock knob `setImage` IS the live screen (#1013). The `shared/dial-*` modules import deck-core and zod only; `dial-sim-agnostic.test.ts` keeps them free of `@iracedeck/iracing-sdk` / `@iracedeck/sim-events-iracing` and of any relative import that is not another `./dial-*` module (#1437)
- `profile-entries.ts` — shared `_deviceProfiles` PI-dropdown entry building + echo-loop change guard (#790)
- `repeat-controller.ts` — long-press hold-to-repeat timing controller
- `replay-busy-indicator.ts` — what the pressed replay key or dial shows while its press is worked on (#1437): working, waiting or not done, read only from the replay engine's gate state seam (`subscribeReplayGate`, `getReplayGateView`) and sending nothing. It stays in this package, which has no registration entry point, so its logger is set by `plugin-runtime`'s `registerActions` through `setReplayBusyIndicatorLogger`, exported from the barrel (#1467). A key or dial registers its context id as the token (`registerReplayBusySurface`, with `drawsWorking` false for a mode whose own command is not a jump or search), draws from `getReplayBusyLook` (mapped to a key's mark by `replayBusyKeyMark` and to a dial box's caption mark by `replayBusyDialMark`, both in `replay-busy-mark.ts`), and the action reports a press it ignored itself (`reportReplayPressIgnored`). One interval for the plugin, every `REPLAY_BUSY_FRAME_MS` (125), alive only while a registered surface shows working; each tick re-reads the gate's view, and a five-minute ceiling stops a spinner the gate never ends. No start delay. Spec: `docs/superpowers/specs/2026-10-13-issue-1437-replay-key-busy-look.md`.
- `replay-engine-deck.test-support.ts` — test-only: `engineOverDeck(base)` configures `@iracedeck/replay-engine` over a test file's `@iracedeck/deck-iracing` mocks, as `plugin-runtime`'s `initReplay` wires it over the real ones (every read goes to `getController()` and every send to `getCommands()` at the time of use), and returns the file's `configureEngine` / `resetEngine` pair; `replayControlScopeOn(logger)` routes the engine's `ReplayControl` scope to the action's logger, where the Jump to Fastest Lap and Jump to Race Start presses log. Never imported by production code.
- `setup-view.ts` — registry, formatters, and render helper for the setup actions' "View …" sub-modes (#541)
- `spotter-bindings.ts` — canonical AI Spotter control↔global-key map (`SPOTTER_GLOBAL_KEYS`, also consumed by `comms-catalog.ts`): the spotter has no SDK surface, and two actions dispatch its bindings — AI Spotter Controls (every control, keypad) and the Audio Controls dial's Spotter mode (louder/quieter on rotation, silence on press as Skip Spotter Call, #809/#1015)
- `unavailable-look.ts` — `unavailableLook(colors, border)`, the look of a key whose press would do nothing right now: every colour slot but the background and the border's colour in grey, plus `assembleIcon`'s `dimmed`, spread into the `assembleIcon` call in place of the resolved colours and border. Replay Markers' Next / Previous with no marker that way (#1162) and Replay Control's Jump to Race Start in a replay with no race session (#1354) draw it; a new "this key cannot act now" state uses it too, so the look stays one.

The replay engine — the replay command gate (the one sender of replay commands), the cursor, the pending target, jump playback, seek, the frame-move rule, the record walk and record step, the replay timings, the paced search, the speed state and its display read (`shownReplaySpeed`), the speed text, the camera-switch waiter, the incident comparison and the Jump to Fastest Lap / Jump to Race Start presses with their lap walks — lived in `src/shared/` and `actions/replay-control/` until #1467 and is now `@iracedeck/replay-engine` (`packages/replay-engine/CLAUDE.md` has its module map and rules). The replay actions import it from that package; what stays here is the deck side: the busy indicator, the dial modes and surfaces, the speed ladder (`replay-speed-ladder.ts`), the per-car arrays (`replay-car-arrays.ts`), the lap readout, Replay Markers and its ops, and the legacy Replay Navigation, Replay Speed and Replay Transport actions. Replay Control calls `noteTelemetrySpeed` on its in-replay ticks and redraws on `onReplaySpeedChanged`. Every action's camera switch goes through `requestCameraSwitch` (#1467, #1428 / #1435): Replay Control's key and dial, Camera Controls' keypad and dial (at their shared dispatch, `requestSwitch`, so `camera-dial-surface.ts` needs no wrap of its own) and Race Admin's Car Selector focus press (`executeFocusSelect`, whose failure alert fires when the switch goes out). Each passes a `stillValid` that drops a switch whose context has left the screen (and, for Camera Controls, Race Admin and Replay Control's keys, one the replay was left under) and builds its target inside `send`, from the camera when the switch goes out. A switch that changes only the camera's angle (Camera Controls' Cycle Camera, Cycle Driving Cam, Change Camera and Cycle Sub-Camera) passes `interruptsWalks: false`. Set Camera State is left out and sent at once: it sets flags on the camera, not a camera target. Nothing checks this mechanically, since the send is a callback the caller hands in, so a new camera send keeps to it by hand.

The former `icon-update-throttle.ts` (per-context 10 Hz throttle + trailing-edge coalescer for telemetry-driven `setKeyImage` bursts, #493) moved to `@iracedeck/deck-core` in #899 — import `IconUpdateThrottle` from there.

The top-level `icons/` directory holds one 144x144 runtime template per dynamic-icon action (content rendered from live telemetry) — see the directory for the current set and `.claude/rules/icons.md` for the template format.

## Action Pattern

See `.claude/rules/stream-deck-actions.md` for the full requirements (UUID constant, `ConnectionStateAwareAction`, `CommonSettings`, icon assembly, super calls, settings handlers). An action that reads iRacing directly through `this.sdkController` (telemetry, session info, the template context, its own telemetry subscription) extends `@iracedeck/deck-iracing`'s `SimIRacingAction` instead, which adds the typed controller; one that only calls `getCommands()` does not need it. `deck-core`'s `ConnectionStateAwareAction` has no `sdkController`.

## Dial surfaces

A dial-capable action routes its dial events to a `*-dial-surface.ts` module beside it; `fuel-service/fuel-dial-surface.ts` is the reference and `.claude/rules/encoders-and-touchscreen.md` holds the rules. Two shapes every surface shares: the per-context state is created only by the lifecycle events (`willAppear`, `didReceiveSettings`, through `ensureContext`) while the input events go through `inputContext` and never create one (#1329); and where `__FEATURE_DIAL_EXTENDED_GESTURES__` is off the hold preview is deck-core's one `NOOP_HOLD_PREVIEW`, never a local copy (#1329). A test that drives dial input makes the dial appear first, since input on a context that never appeared is dropped. One surface keeps its rotation in a registry of modes: Replay Control's `ReplayControlDialSurface` hands a turn, the box's label and what the box reads to the `ReplayDialMode` that `dial.mode` picks from `DIAL_MODES` (`replay-control/replay-control-dial-mode.ts`, #1316) — Speed Control (`replay-control-speed-mode.ts`), Frame Jog (`replay-control-frame-jog.ts`, #1317), or Lap, Session, Incident and Track Order (#801: `replay-control-lap-mode.ts`, `-session-mode.ts`, `-incident-mode.ts`, `-track-order-mode.ts`, the step modes sharing `replay-control-step-mode.ts`, the paced search in `@iracedeck/replay-engine`'s `replay-search-queue.ts`, and Lap's value and Session's caption, the `12/25` lap readout, in `replay-dial-lap-readout.ts` over the engine's `replay-lap-count.ts`) — and keeps the per-context state, the in-replay guard, the gestures (one `GESTURES` table: dial-hint label, run, hold-preview text; the Mode default has no row, `resolveDialGesture` turning it into the mode's own) and the hold preview itself, so a new rotation mode there is one module plus one registry row, plus its `dial.mode` value, PI option and comms entry.

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

Tests mock `@iracedeck/deck-core` (not `@elgato/streamdeck`), and the global-settings names (`getGlobalSettings`, `getGlobalColors`, …) on `@iracedeck/settings` in a second factory, never on deck-core (#1365) — the canonical mock is in `.claude/rules/testing.md`. The iRacing names (`getCommands`, the fuel and unit helpers) are mocked on `@iracedeck/deck-iracing` with `importOriginal`, as that file shows. `@iracedeck/replay-store` and `@iracedeck/diagnostics` are mocked on their own packages where a test stubs one of their names (the Replay Markers, Replay Control and Telemetry Control tests); `replay-markers-dial-surface.test.ts` loads `replay-store`'s `src/replay-markers.ts` by relative path past that mock, so its fake store answers exactly as the real one does. `@iracedeck/replay-engine` runs for real: a replay test configures the engine over its `@iracedeck/deck-iracing` mocks with `shared/replay-engine-deck.test-support.ts`'s `engineOverDeck` and resets it through the pair that returns; where a test stubs or spies on one engine name (the paced search, the gate's state seam, a lap press, `requestCameraSwitch`) its `vi.mock` spreads `importOriginal` and replaces only that name. It takes the engine's shared test helpers (`fakeReplay`, `steppedReplayState`, the lap-walk buffers, the race weekend) from `@iracedeck/replay-engine/testing` (#1467). `@iracedeck/app-constants` is a pure leaf with no imports, so tests use the real module rather than mocking it (`shared/mouse-to-sim.test.ts`). Binding-aware actions additionally stub `isBindingMissing` on the mock `ConnectionStateAwareAction` (see `splits-delta-cycle/splits-delta-cycle.test.ts`).

## Adding a New Action

See `packages/iracing-plugin-stream-deck/CLAUDE.md` for the full step-by-step guide. The action source file and PI template (`<name>.ejs`) stay in this package alongside the action code; action registration goes in `@iracedeck/plugin-runtime`'s shared action list (`src/actions.ts`), once for all three plugins, and the `manifest.json` entries in every plugin package (`iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, and `iracing-plugin-ulanzi`).
