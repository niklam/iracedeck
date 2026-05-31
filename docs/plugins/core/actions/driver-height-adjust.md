# Driver Height Adjust

Adjusts the virtual driver's seating height.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.driver-height-adjust` |
| Type | +/- |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | Yes |

## Behavior

### Button Press
Triggers the direction configured in Settings (increase or decrease).

### Encoder
- **Rotate clockwise**: Increase height
- **Rotate counter-clockwise**: Decrease height

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Increase | Adjustment direction |

### Direction Options
- **Increase** - Raise driver height
- **Decrease** - Lower driver height

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Increase | Ctrl+] | Increase Driver Height |
| Decrease | Ctrl+[ | Decrease Driver Height |

## Icon States

| State | Icon |
|-------|------|
| Increase | Seat icon with up arrow |
| Decrease | Seat icon with down arrow |

## Notes

- Simulates moving the driver seat up or down
- Affects view of hood, mirrors, and instruments
- Saved per car in iRacing
