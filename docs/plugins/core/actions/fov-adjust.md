# FOV Adjust

Adjusts the driver's field of view.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.fov-adjust` |
| Type | +/- |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | No |

## Behavior

### Button Press
Triggers the direction configured in Settings (increase or decrease).

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Increase | Adjustment direction |

### Direction Options
- **Increase** - Widen field of view
- **Decrease** - Narrow field of view

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Increase | ] | Increase Driver Field of View |
| Decrease | [ | Decrease Driver Field of View |

## Icon States

| State | Icon |
|-------|------|
| Increase | Wider FOV icon (expanding lines) |
| Decrease | Narrower FOV icon (converging lines) |

## Notes

- Wider FOV shows more but objects appear smaller/further
- Narrower FOV shows less but better depth perception
- Find a balance between visibility and realism for your setup
