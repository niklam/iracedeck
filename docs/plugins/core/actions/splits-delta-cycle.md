# Splits Delta Cycle

Cycles through split-time delta display modes.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.splits-delta-cycle` |
| Type | Multi-toggle |
| SDK Support | No |
| Encoder Support | Yes |

## Behavior

### Button Press
Triggers the direction configured in Property Inspector (next or previous).

### Encoder
- **Rotate clockwise**: Next splits delta display
- **Rotate counter-clockwise**: Previous splits delta display

## Property Inspector

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Next | `Next` or `Previous` |

## Keyboard Simulation

| Action | Key | iRacing Setting |
|--------|-----|-----------------|
| Next | TAB | Next Splits Delta Display |
| Previous | Shift+TAB | Prev Splits Delta Display |

## Icon States

| State | Description |
|-------|-------------|
| Default | Shows delta icon |

## Notes

- Uses default iRacing keybindings (TAB / Shift+TAB)
- Cycles through: Off, Session Best, Session Optimal, Personal Best, etc.
