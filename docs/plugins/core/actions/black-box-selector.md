# Black Box Selector

Cycles through or directly selects iRacing black box screens.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.black-box-selector` |
| Type | Multi-toggle |
| SDK Support | No |
| Communication Method | Key binding |
| Dial Support | Yes |

## Behavior

### Button Press
- **Direct mode**: Opens the selected black box immediately
- **Next/Previous mode**: Cycles to the next or previous black box

### Dial
- **Rotate clockwise**: Next black box
- **Rotate counter-clockwise**: Previous black box
- **Press**: Opens the currently selected black box

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Direct | Selection mode |
| Black Box | Dropdown | Lap Timing | Target black box (Direct mode only) |

### Mode Options
- **Direct** - Opens a specific black box immediately
- **Next** - Cycles to the next black box
- **Previous** - Cycles to the previous black box

### Black Box Options
- Lap Timing
- Standings
- Relative
- Fuel
- Tires
- Tire Info
- Pit-stop Adjustments
- In-car Adjustments
- Mirror Adjustments
- Radio Adjustments
- Weather

## Keyboard Simulation

### Direct Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Lap Timing | F1 | Lap Timing Black Box |
| Standings | F2 | Standings Black Box |
| Relative | F3 | Relative Black Box |
| Fuel | F4 | Fuel Black Box |
| Tires | F5 | Tires Black Box |
| Tire Info | F6 | Tire Info Black Box |
| Pit-stop Adjustments | F7 | Pit-stop Adjustments Black Box |
| In-car Adjustments | F8 | In-car Adjustments Black Box |
| Mirror Adjustments | F9 | Mirror Adjustments Black Box |
| Radio Adjustments | F10 | Radio Adjustments Black Box |
| Weather | F11 | Weather Black Box |

### Next/Previous Mode
| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Next | *(none)* | Next Black Box |
| Previous | *(none)* | Prev Black Box |

## Icon States

All Direct mode icons include a small "BB" label in the corner to distinguish them from similar icons used elsewhere.

| Mode | Icon |
|------|------|
| Next | "BB" with up arrow |
| Previous | "BB" with down arrow |
| Direct: Lap Timing | Stopwatch + BB label |
| Direct: Standings | Podium + BB label |
| Direct: Relative | Gap indicator (±) + BB label |
| Direct: Fuel | Fuel gauge + BB label |
| Direct: Tires | Tire + BB label |
| Direct: Tire Info | Tire with temperature bars + BB label |
| Direct: Pit-stop | Pit board + BB label |
| Direct: In-car | Sliders/adjustments + BB label |
| Direct: Mirror | Mirror + BB label |
| Direct: Radio | Headset + BB label |
| Direct: Weather | Cloud + BB label |

## Notes

- Next/Previous mode requires configuring custom keybindings in iRacing (no defaults set)
- Direct mode uses iRacing's default F1–F11 bindings
