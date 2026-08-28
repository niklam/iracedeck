# Ignition

Toggles the car's ignition.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.ignition` |
| Type | Button |
| SDK Support | No |
| Communication Method | Key binding |
| Dial Support | No |

## Behavior

### Button Press
- Toggles ignition on/off

## Settings

None.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Ignition | I | Ignition |

## Icon States

The icon is tri-state, matching the other tri-state buttons (Pit Speed Limiter, DRS, Push to Pass, Auto-Fuel, Windshield Tear-off, Fast Repair) — a colored status bar at the bottom conveys the state and also drives the key's border color. Because the border color is state-driven, the per-action border color picker is ignored for this key; the border width setting still applies.

The title is now a single line reading `IGNITION`. It previously read a two-line `ON/OFF` / `IGNITION`, which is redundant now that the status bar itself shows the on/off state.

| State | Description |
|-------|-------------|
| Off | Ignition off — red `OFF` status bar, red border, and the artwork itself turns red |
| On | Ignition circuit live — green `ON` status bar, green border, and the artwork itself turns green |
| Not available | No live telemetry (disconnected, watching a replay, or not in the car) — grey `N/A` status bar, grey border, grey artwork. Does not mean the car lacks an ignition; pressing still sends the configured binding. |

## Telemetry Integration

Detects ignition state from the `Voltage` telemetry field, since iRacing publishes no dedicated ignition field of any kind.

## Notes

- Must be on before using the starter
- Turning off kills the engine immediately
- Some cars may require ignition toggle for specific procedures
