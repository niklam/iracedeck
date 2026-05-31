# Look Direction

Changes the driver's view direction.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.look-direction` |
| Type | Multi-toggle |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | No |

## Behavior

### Button Press
Looks in the configured direction while held (momentary).

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Left | Look direction |

### Direction Options
- **Left** - Look left
- **Right** - Look right
- **Up** - Look up
- **Down** - Look down

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Left | Z | Look Left |
| Right | X | Look Right |
| Up | *(none)* | Look Up |
| Down | *(none)* | Look Down |

## Icon States

| State | Icon |
|-------|------|
| Left | Left arrow |
| Right | Right arrow |
| Up | Up arrow |
| Down | Down arrow |

## Notes

- Momentary action - view returns to forward when released
- Look Up/Down require custom keybindings in iRacing (no default keys)
- Useful for checking mirrors or blind spots
