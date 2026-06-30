# Pit Speed Limiter

Toggles the pit lane speed limiter.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.pit-speed-limiter` |
| Type | Toggle |
| SDK Support | No |
| Communication Method | Key binding |
| Dial Support | No |

## Behavior

### Button Press
- Toggles pit speed limiter on/off

## Settings

None.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Toggle | A | Pit Speed Limiter |

## Icon States

The icon is tri-state (issue #638). It mirrors the other tri-state buttons (Auto-Fuel, Windshield Tear-off, Fast Repair) — a colored status bar at the bottom conveys the state and drives the border color — but keeps the pit-speed-limit number-in-a-circle as the central graphic in every state. The limit comes from session info (track), so the number stays meaningful even when the car has no limiter.

The `PIT LIMITER` title is hidden by default so the speed number renders larger; it can be enabled via the per-action Title Overrides (the circle then shrinks to leave room for the title at the top).

| State | Description |
|-------|-------------|
| Off | Limiter disabled — speed-number circle + red `OFF` status bar and red border |
| On | Limiter engaged — speed-number circle + green `ON` status bar and green border |
| Not available | Car has no pit limiter — speed-number circle + grey `N/A` status bar and grey border. Pressing the button still sends the configured binding, consistent with the other tri-state buttons. |

## Telemetry Integration

Can read `dcPitSpeedLimiterToggle` from telemetry to show actual state.

## Notes

- Essential for pit stops to avoid speeding penalties
- Automatically limits car to pit lane speed limit
- Should be engaged before entering pit lane
