> **Issue:** [#1584](https://github.com/niklam/iracedeck/issues/1584) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Toggle Minimal Drive UI on Toggle UI Elements

## Decisions

**It is a mode on Toggle UI Elements, not a new action.** It is one more Interface control that changes what iRacing draws on screen, which is what Toggle UI Elements already presses: Dash Box, Speed / Gear / Pedals, Radio, FPS / Network, Weather Radar, Virtual Mirror, UI Edit and Driving Line. The `element` enum gains `minimal-drive-ui`. Existing values keep their meaning, so no migration.

**What the control does, from iRacing's 2026 Season 4 release notes.** On the Drive screen it switches between the normal UI and Minimal, which shows only pinned and required widgets. Unlike the session screen's Cycle UI Visibility Mode, it never goes completely hidden. It enters Minimal only when at least one widget is pinned; with none pinned, a press changes nothing, which is the sim's behaviour to own.

**It is a key binding that defaults to unassigned.** It has no SDK surface. iRacing ships it with no key, so any default we picked would press a key the sim does not listen to, or one the user has bound to something else. `toggleUiMinimalDriveUi` is added with `"default": ""`, the same shape as Black Box Selector's cycle bindings. The comms catalog entry keeps that safe: the PI's binding-status line and the key's #612 warning show until the user assigns it.

**Cycle UI Visibility Mode needs nothing.** It is iRacing's rename of Toggle UI Visibility, which the Replay UI mode already covers. Only the stale row in `docs/keyboard-shortcuts.md` is renamed.

**The key shows no state.** Telemetry does not report the minimal-drive state, so the icon is static. A stateful key would be guessing.

**Icon and title.** A new icon in `packages/icons/toggle-ui-elements/`, in the action's existing style: a screen with a reduced overlay of a few pinned widgets. Niklas approves it on a review page. The key title is `MINIMAL\nDRIVE UI`, following the `subLabel\nmainLabel` shape of the other titles.

## Out of scope

- Setting a specific state (normal or Minimal). iRacing exposes only the toggle, and nothing reports the current state, so the key could not be deterministic.
- Any change to Replay UI or to the Cycle UI Visibility Mode coverage.
- Season 4's other new surface named in #1158: the Pit Summary and Car Damage widgets, and the Reference Car Offset and Opacity options.
- A dial surface for Toggle UI Elements. It stays keypad-only.

## Testing

- Unit: the settings parse accepts `minimal-drive-ui` and still parses every existing value. `UI_ELEMENT_GLOBAL_KEYS` maps it to `toggleUiMinimalDriveUi`. A press taps that binding. The missing-binding state shows while it is unassigned. The icon renders with its title.
- The comms-catalog freshness test and the key-binding cross-check (every keybind key exists in `key-bindings.json`) cover the new key.
- Manual, in the sim: pin a widget, then assign the same key to Toggle Minimal Drive UI in iRacing and in iRaceDeck. On the Drive screen the key switches between normal and Minimal and back. With the binding unassigned, the key shows the missing-binding warning and the PI shows the status line.
