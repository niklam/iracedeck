# UI Size Adjust

Adjusts the overall UI scale.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.ui-size-adjust` |
| Type | +/- |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | Yes |

## Behavior

### Button Press
Triggers the direction configured in Settings (up or down).

### Encoder
- **Rotate clockwise**: Scale UI up
- **Rotate counter-clockwise**: Scale UI down

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Up | Adjustment direction |

### Direction Options
- **Up** - Increase UI scale
- **Down** - Decrease UI scale

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Up | Ctrl+PageUp | Scale UI Up |
| Down | Ctrl+PageDown | Scale UI Down |

## Icon States

| State | Icon |
|-------|------|
| Up | Larger UI element icon |
| Down | Smaller UI element icon |

## Notes

- Affects all UI elements proportionally
- Useful for different monitor sizes/resolutions
- Changes persist across sessions
