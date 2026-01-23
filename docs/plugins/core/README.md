# Core Plugin (`com.iracedeck.sd.core`)

Core driving, cockpit, and interface controls for iRacing. Maps to the "In Car" section of [keyboard shortcuts](../../keyboard-shortcuts.md).

See [Action Types](../action-types.md) for type definitions.

## Overview

| Property | Value |
|----------|-------|
| Plugin ID | `com.iracedeck.sd.core` |
| Actions | 27 |
| Category | Core Driving & Interface |

## Actions

| # | Action | Type | Documentation |
|---|--------|------|---------------|
| 1 | Black Box Selector | Multi-toggle | [Details](actions/black-box-selector.md) |
| 2 | Splits Delta Cycle | Multi-toggle | [Details](actions/splits-delta-cycle.md) |
| 3 | Toggle Display Reference Car | Toggle | [Details](actions/toggle-display-reference-car.md) |
| 4 | Starter | Button | [Details](actions/starter.md) |
| 5 | Ignition | Button | [Details](actions/ignition.md) |
| 6 | Pit Speed Limiter | Toggle | [Details](actions/pit-speed-limiter.md) |
| 7 | Enter/Exit/Tow Car | Button | [Details](actions/enter-exit-tow-car.md) |
| 8 | Autofuel Toggle | Toggle | [Details](actions/autofuel-toggle.md) |
| 9 | Autofuel Lap Margin | +/- | [Details](actions/autofuel-lap-margin.md) |
| 10 | Toggle Dash Box | Toggle | [Details](actions/toggle-dash-box.md) |
| 11 | Trigger Windshield Wipers | Button | [Details](actions/trigger-windshield-wipers.md) |
| 12 | Look Direction | Multi-toggle | [Details](actions/look-direction.md) |
| 13 | FOV Adjust | +/- | [Details](actions/fov-adjust.md) |
| 14 | Horizon Adjust (VanishY) | +/- | [Details](actions/horizon-adjust.md) |
| 15 | Driver Height Adjust | +/- | [Details](actions/driver-height-adjust.md) |
| 16 | Recenter VR View | Button | [Details](actions/recenter-vr-view.md) |
| 17 | Speed/Gear/Pedals Display | Toggle | [Details](actions/speed-gear-pedals-display.md) |
| 18 | Radio Display | Toggle | [Details](actions/radio-display.md) |
| 19 | FPS/Network Display | Toggle | [Details](actions/fps-network-display.md) |
| 20 | Report Latency | Button | [Details](actions/report-latency.md) |
| 21 | Toggle Weather Radar | Toggle | [Details](actions/toggle-weather-radar.md) |
| 22 | Toggle Virtual Mirror | Toggle | [Details](actions/toggle-virtual-mirror.md) |
| 23 | Toggle UI Edit | Toggle | [Details](actions/toggle-ui-edit.md) |
| 24 | UI Size Adjust | +/- | [Details](actions/ui-size-adjust.md) |
| 25 | Pause Sim | Toggle | [Details](actions/pause-sim.md) |
| 26 | Set FFB Max Force | Adjustment | [Details](actions/set-ffb-max-force.md) |
| 27 | Adjust Master Volume | +/- | [Details](actions/adjust-master-volume.md) |

## Implementation Notes

- All actions require keyboard simulation (no SDK support for "In Car" controls)
- User must configure matching keybindings in iRacing settings
- Multi-toggle actions use Stream Deck's state system or property inspector dropdowns
