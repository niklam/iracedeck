# Enter / Exit / Tow Car — Cockpit Misc Mode

**Issue**: #193
**Date**: 2026-03-27

## Overview

Add a context-aware "Enter / Exit / Tow Car" mode to the existing Cockpit Misc action. The mode dynamically updates its icon based on telemetry state while always sending the same key binding (default Shift+R).

## Context States

The mode defines 4 mutually exclusive states, evaluated in priority order:

| # | State ID | Condition | Icon Artwork | mainLabel |
|---|----------|-----------|-------------|-----------|
| 1 | `enter-car` | `!IsOnTrack` (spectating, replay, out of car) | Car with arrow pointing inward | ENTER |
| 2 | `exit-car` | `IsOnTrack && PlayerCarInPitStall` | Car with arrow pointing outward | EXIT |
| 3 | `reset-to-pits` | `IsOnTrack && !PlayerCarInPitStall && session !== "Race"` | Car with circular reset/return arrow | RESET |
| 4 | `tow` | `IsOnTrack && !PlayerCarInPitStall && session === "Race"` | Thick tow hook | TOW |

When telemetry is `null` (disconnected), default to `enter-car`.

### State Detection

A pure function `getEnterExitTowState(telemetry, sessionInfo)` returns one of the 4 state strings.

**Telemetry variables used**:
- `IsOnTrack` — boolean, whether the player car is on the track
- `PlayerCarInPitStall` — boolean, whether the player car is in a pit stall

**Session type**: Read from `SessionInfo.Sessions[SessionNum].SessionType` where `SessionNum` comes from telemetry. Check is `=== "Race"` — all other session types (Practice, Qualifying, Offline Testing, etc.) map to "Reset to Pits".

**Note**: These telemetry variables have not been verified against a live iRacing session. An investigation step is required during implementation to confirm they behave as expected in all 4 states.

## Icons

4 distinct SVGs at 144x144 canvas, each with bold recognizable artwork and a single large `mainLabel` (no `subLabel`). All use the standard Mustache template system with `{{backgroundColor}}`, `{{textColor}}`, `{{graphic1Color}}` color slots and `<desc>` metadata for color defaults.

Files:
- `packages/icons/cockpit-misc/enter-car.svg`
- `packages/icons/cockpit-misc/exit-car.svg`
- `packages/icons/cockpit-misc/reset-to-pits.svg`
- `packages/icons/cockpit-misc/tow.svg`

Labels are rendered via `renderIconTemplate()` with `subLabel` left empty. This keeps the rendering path unified with other cockpit-misc modes.

## Action Code Changes

### New Types

```typescript
type EnterExitTowState = "enter-car" | "exit-car" | "reset-to-pits" | "tow";
```

Add `"enter-exit-tow"` to the `CockpitMiscControl` union and Zod enum. It is NOT added to `DIRECTIONAL_CONTROLS`.

### Conditional Telemetry Subscription

The `CockpitMisc` class becomes a hybrid action — most modes remain static, but `enter-exit-tow` subscribes to telemetry:

- **`onWillAppear`**: If control is `enter-exit-tow`, subscribe via `this.sdkController.subscribe()`. Otherwise, no subscription (existing behavior).
- **`onDidReceiveSettings`**: If user switches TO `enter-exit-tow`, subscribe. If switching AWAY, unsubscribe.
- **`onWillDisappear`**: Unsubscribe if subscribed, clean up state caches.

### State Caching

A `Map<string, EnterExitTowState>` tracks the last computed state per action context. On each telemetry callback, compute the new state and only redraw if it changed.

### Icon Selection

The enter-exit-tow mode selects the SVG matching the current telemetry state, resolves colors, then renders via `renderIconTemplate()` with `mainLabel` only (ENTER, EXIT, RESET, or TOW) and empty `subLabel`.

### Key Binding

Single global key `cockpitMiscEnterExitTow` (default `Shift+R`). Always sends the same key regardless of state — only the icon changes.

### Long-Press Pattern

Enter-exit-tow uses `holdBinding`/`releaseBinding` instead of `tapBinding` (iRacing requires holding Shift+R for tow/reset confirmation):

- `onKeyDown`: If `enter-exit-tow`, `await this.holdBinding(ev.action.id, "cockpitMiscEnterExitTow")`. Otherwise, existing `tapBinding` path.
- `onKeyUp` (new override): If `enter-exit-tow`, `await this.releaseBinding(ev.action.id)`. No-op for other modes (they use tap, which is fire-and-forget).
- `onWillDisappear`: `await this.releaseBinding(ev.action.id)` (safety cleanup).

### Encoder

Enter-exit-tow is non-directional. Dial rotation is ignored (same as toggle-wipers). Dial press triggers the hold/release pattern.

### Global Keys Mapping

Add to `COCKPIT_MISC_GLOBAL_KEYS`:
```typescript
"enter-exit-tow": "cockpitMiscEnterExitTow"
```

## Property Inspector

### Control Dropdown

Add `"enter-exit-tow"` option with label "Enter / Exit / Tow Car" to the control dropdown in `cockpit-misc.ejs`. The direction dropdown is already hidden for non-directional controls.

### Key Bindings JSON

Add to the `cockpitMisc` array in `key-bindings.json`:
```json
{
  "id": "enterExitTow",
  "label": "Enter / Exit / Tow Car",
  "default": "Shift+R",
  "setting": "cockpitMiscEnterExitTow"
}
```

### Manifest

Update the cockpit-misc tooltip to include "enter/exit/tow" in the feature list.

## Testing

### State Detection (`getEnterExitTowState`)

- `null` telemetry → `"enter-car"`
- `IsOnTrack: false` → `"enter-car"`
- `IsOnTrack: true, PlayerCarInPitStall: true` → `"exit-car"`
- `IsOnTrack: true, PlayerCarInPitStall: false`, non-Race session → `"reset-to-pits"`
- `IsOnTrack: true, PlayerCarInPitStall: false`, Race session → `"tow"`

### Icon Generation

Verify each state produces a valid SVG data URI with the correct mainLabel (ENTER, EXIT, RESET, TOW) and empty subLabel.

### Subscription Lifecycle

- Subscribe when control is `enter-exit-tow` on `onWillAppear`
- Unsubscribe when switching away or on `onWillDisappear`
- No subscription for other control modes

### Hold/Release

- `holdBinding`/`releaseBinding` for enter-exit-tow mode
- `tapBinding` for all other modes

### Live Telemetry Investigation

Test against a live iRacing session to confirm `IsOnTrack`, `PlayerCarInPitStall`, and `SessionType` behave as expected in all 4 states before finalizing the state detection logic.

## Documentation & Skills

- **Action docs** (`packages/website/src/content/docs/docs/actions/cockpit/cockpit-misc.md`): Add "Enter / Exit / Tow Car" mode, document the 4 context states, add Shift+R keyboard entry.
- **Skills** (`iracedeck-actions`): Update cockpit-misc mode/sub-action listings.
