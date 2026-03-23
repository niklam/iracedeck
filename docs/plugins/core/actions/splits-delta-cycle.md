# Splits & Reference

Manages splits delta display cycling, reference car toggling, custom sector markers, and active reset controls.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.splits-delta-cycle` |
| Type | Multi-toggle |
| SDK Support | No |
| Encoder Support | Yes |

## Behavior

### Button Press
Triggers the action configured in Settings.

### Encoder
- **Rotate clockwise**: Next splits delta display (Cycle mode only)
- **Rotate counter-clockwise**: Previous splits delta display (Cycle mode only)
- **Press**: Triggers the configured action (all modes except Cycle)

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Cycle | Action mode |
| Direction | Dropdown | Next | Cycle direction (Cycle mode only) |

### Mode Options
- **Cycle** - Cycle through splits delta display modes
- **Toggle Reference Car** - Toggle the reference car display on/off
- **Custom Sector Start** - Marks the start point for a custom sector
- **Custom Sector End** - Marks the end point for a custom sector
- **Set Active Reset Point** - Saves the current car state as a reset snapshot (solo practice only)
- **Reset to Start Point** - Teleports the car back to the saved active reset snapshot (solo practice only)

### Direction Options (Cycle mode)
- **Next** - Cycle to next display mode
- **Previous** - Cycle to previous display mode

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Next | TAB | Next Splits Delta Display |
| Previous | Shift+TAB | Prev Splits Delta Display |
| Toggle Reference Car | Ctrl+C | Toggle Display Reference Car |
| Custom Sector Start | *(none)* | Mark Start Point |
| Custom Sector End | *(none)* | Mark End Point |
| Set Active Reset Point | *(none)* | Set Start Point |
| Reset to Start Point | *(none)* | Reset to Start Point |

## Icon States

| State | Icon |
|-------|------|
| Cycle Next | Delta icon with up arrow |
| Cycle Previous | Delta icon with down arrow |
| Toggle Reference Car | Reference car icon |
| Custom Sector Start | Flag marker (green, pointing right) |
| Custom Sector End | Flag marker (red, pointing left) |
| Set Active Reset Point | Location pin with yellow center |
| Reset to Start Point | Circular reset arrow with yellow center |

## Notes

- Uses default iRacing keybindings (TAB / Shift+TAB for cycle, Ctrl+C for reference car)
- Cycle mode cycles through: Off, Session Best, Session Optimal, Personal Best, etc.
- The "Toggle Reference Car" mode was previously available as a separate option in the Toggle UI Elements action
- Active Reset only works in solo practice sessions. The car's full state (position, speed, temperatures) is captured when setting the point.
- Custom Sector and Active Reset key bindings have no defaults in iRacing — users must assign keys in both iRacing settings and the action's Property Inspector.
