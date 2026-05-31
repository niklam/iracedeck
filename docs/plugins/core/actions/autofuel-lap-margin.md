# Autofuel Lap Margin

Adjusts the lap margin for automatic fuel calculation.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.autofuel-lap-margin` |
| Type | +/- |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | Yes |

## Behavior

### Button Press
Triggers the direction configured in Settings (increase or decrease).

### Encoder
- **Rotate clockwise**: Increase lap margin
- **Rotate counter-clockwise**: Decrease lap margin

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Increase | Adjustment direction |

### Direction Options
- **Increase** - Add more lap margin
- **Decrease** - Reduce lap margin

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Increase | *(none)* | Autofuel Lap Margin Inc |
| Decrease | *(none)* | Autofuel Lap Margin Dec |

## Icon States

| State | Icon |
|-------|------|
| Increase | Fuel icon with up arrow |
| Decrease | Fuel icon with down arrow |

## Notes

- Sets how many extra laps of fuel to add beyond calculated minimum
- Higher margin = more safety buffer but heavier car
- Works in conjunction with Autofuel Toggle
