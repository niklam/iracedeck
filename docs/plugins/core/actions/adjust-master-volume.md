# Adjust Master Volume

Adjusts the iRacing master audio volume.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.adjust-master-volume` |
| Type | +/- |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | No |

## Behavior

### Button Press
Triggers the direction configured in Settings (louder or quieter).

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Louder | Adjustment direction |

### Direction Options
- **Louder** - Increase volume
- **Quieter** - Decrease volume

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Louder | Shift+Alt+NUMPAD + | Master Volume Louder |
| Quieter | Shift+Alt+NUMPAD - | Master Volume Quieter |

## Icon States

| State | Icon |
|-------|------|
| Louder | Speaker with plus/waves |
| Quieter | Speaker with minus |

## Notes

- Adjusts overall iRacing audio output
- Requires numpad keys for default bindings
- Separate from Windows system volume
