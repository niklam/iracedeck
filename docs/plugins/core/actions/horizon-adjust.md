# Horizon Adjust (VanishY)

Adjusts the vertical horizon position in the driver's view.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.horizon-adjust` |
| Type | +/- |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | No |

## Behavior

### Button Press
Triggers the direction configured in Settings (up or down).

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Up | Adjustment direction |

### Direction Options
- **Up** - Shift horizon up
- **Down** - Shift horizon down

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Up | Shift+] | Shift Horizon Up |
| Down | Shift+[ | Shift Horizon Down |

## Icon States

| State | Icon |
|-------|------|
| Up | Horizon line with up arrow |
| Down | Horizon line with down arrow |

## Notes

- Moves the vanishing point up or down
- Useful for adjusting view comfort without changing FOV
- Also known as VanishY in camera settings
