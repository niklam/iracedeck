> **Issue:** [#1584](https://github.com/niklam/iracedeck/issues/1584) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Cycle UI Visibility Mode and Toggle Minimal Drive UI on Toggle UI Elements

## Decisions

**Both are modes on Toggle UI Elements, not a new action.** They are two more of the Interface controls that change what iRacing draws on screen, which is what Toggle UI Elements already presses: Dash Box, Speed / Gear / Pedals, Radio, FPS / Network, Weather Radar, Virtual Mirror, UI Edit and Driving Line. A new action would add a manifest entry, a UUID and a registration in every plugin for one key press each. The `element` enum gains `ui-visibility-mode` and `minimal-drive-ui`. Existing values keep their meaning, so no migration is needed.

**Cycle UI Visibility Mode is a key binding, not the SDK.** The SDK's only lever on the UI is the `UIHidden` flag in `CamCameraState`, which Replay UI already sets and clears through `camera.showUI` / `camera.hideUI`. It has two states. Since 2026 Season 4 the control cycles three: Normal, Minimal and Hidden (#1158). A flag that cannot express Minimal cannot drive the cycle, so the mode taps the user's binding, `toggleUiCycleVisibility`. This is the one-way SDK-first exception `keyboard-shortcuts.md` allows: the SDK does not provide the needed functionality. The binding defaults to `Space`, iRacing's own default.

**Replay UI stays as it is.** It is the deterministic replay-overlay show/hide with state readback, and users have it on keys. The two modes are distinct in the dropdown: *Replay UI* (SDK) and *UI Visibility Mode* (key binding). Whether the cycle's Hidden step and the `UIHidden` flag are the same state is not known. Nothing here depends on it, because neither mode reads the other. The capture that would settle it is a Telemetry Snapshot in each of the three cycle states, in the car and in a replay, reading `CamCameraState` bit `0x0008`.

**Toggle Minimal Drive UI is a key binding that defaults to unassigned.** It is new in Season 4 and has no SDK surface. iRacing ships it with no key, so any default we picked would press a key the sim does not listen to, or one the user has bound to something else. `toggleUiMinimalDriveUi` is added with `"default": ""`, the same shape as Black Box Selector's cycle bindings. The comms catalog entry keeps that safe: the PI's binding-status line and the key's #612 warning show until the user assigns it.

**The key shows no state.** Telemetry reports neither the visibility mode nor the minimal-drive state, so the icons are static. A stateful key would be guessing.

**Icons and titles.** There are two new icons in `packages/icons/toggle-ui-elements/`, in the action's existing style. UI Visibility Mode shows a screen whose overlay steps through three fill levels. Minimal Drive UI shows a screen with a reduced overlay. Niklas approves both on a review page. The key titles are `UI\nVISIBILITY` and `MINIMAL\nDRIVE UI`, following the `subLabel\nmainLabel` shape of the other titles.

## Out of scope

- Jumping to a specific visibility mode (Normal, Minimal or Hidden). iRacing exposes only the cycle, and nothing reports the current mode, so the key could not be deterministic.
- Season 4's other new surface named in #1158: the Pit Summary and Car Damage widgets, and the Reference Car Offset and Opacity options.
- Any change to Replay UI, or to the other Interface controls already covered. Those are Video Timer (Media Capture), Report Latency (Cockpit Misc), Scale UI Up / Down (View Adjustment's UI Size) and Pause Sim (Car Control).
- A dial surface for Toggle UI Elements. It stays keypad-only.

## Testing

- Unit: the settings parse accepts both new values and still parses every existing one. `UI_ELEMENT_GLOBAL_KEYS` maps each new value to its binding. A press taps that binding. The missing-binding state shows for an unassigned Minimal Drive UI binding. Both icons render with their titles.
- The comms-catalog freshness test and the key-binding cross-check (every keybind key exists in `key-bindings.json`) cover the new keys.
- Manual, in the sim: press UI Visibility Mode three times with the default `Space` binding, and the driving UI steps Normal → Minimal → Hidden → Normal. Assign a key to Toggle Minimal Drive UI in iRacing and the same key in iRaceDeck, and the key toggles it. With that binding unassigned, the key shows the missing-binding warning and the PI shows the status line. Replay UI still hides and shows the replay overlay.
