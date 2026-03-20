# Splits & Reference

Manages splits delta display cycling and reference car toggling.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.splits-delta-cycle` |
| Type | Multi-toggle |
| SDK Support | No |
| Encoder Support | Yes |

## Behavior

### Button Press
Triggers the action configured in Settings (cycle delta mode or toggle reference car).

### Encoder (Cycle mode only)
- **Rotate clockwise**: Next splits delta display
- **Rotate counter-clockwise**: Previous splits delta display

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Cycle | Action mode |
| Direction | Dropdown | Next | Cycle direction (Cycle mode only) |

### Mode Options
- **Cycle** - Cycle through splits delta display modes
- **Toggle Reference Car** - Toggle the reference car display on/off

### Direction Options (Cycle mode)
- **Next** - Cycle to next display mode
- **Previous** - Cycle to previous display mode

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Next | TAB | Next Splits Delta Display |
| Previous | Shift+TAB | Prev Splits Delta Display |
| Toggle Reference Car | Ctrl+C | Toggle Display Reference Car |

## Icon States

| State | Icon |
|-------|------|
| Cycle Next | Delta icon with up arrow |
| Cycle Previous | Delta icon with down arrow |
| Toggle Reference Car | Reference car icon |

## Notes

- Uses default iRacing keybindings (TAB / Shift+TAB for cycle, Ctrl+C for reference car)
- Cycle mode cycles through: Off, Session Best, Session Optimal, Personal Best, etc.
- The "Toggle Reference Car" mode was previously available as a separate option in the Toggle UI Elements action
