# Set FFB Max Force

Adjusts the maximum force feedback force.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.set-ffb-max-force` |
| Type | Adjustment |
| SDK Support | Yes |
| Dial Support | Yes |

## Behavior

### Button Press
Sets or adjusts FFB max force based on configured mode.

### Dial
- **Rotate clockwise**: Increase max force
- **Rotate counter-clockwise**: Decrease max force

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Adjust | Operation mode |
| Value | Number | - | Target max force value in Nm (Set mode only) |

### Mode Options
- **Set** - Set to a specific value
- **Adjust** - Increment/decrement current value

## Telemetry Integration

Uses iRacing SDK to set FFB max force value directly and read current value for display.

## Icon States

| State | Icon |
|-------|------|
| Default | FFB/steering wheel icon with current value |

## Notes

- SDK-based adjustment allows precise control
- Higher values = stronger feedback but possible clipping
- Lower values = weaker feedback but more detail
- Can read current value from telemetry to display
