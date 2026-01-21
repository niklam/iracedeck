# Black Box Selector

Cycles through or directly selects iRacing black box screens.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.black-box-selector` |
| Type | Multi-toggle |
| SDK Support | No |
| Encoder Support | Yes |

## Behavior

### Button Press
Opens the specific black box (Direct mode) or cycles to next/previous (Next/Previous mode).

### Encoder
- **Rotate clockwise**: Next black box
- **Rotate counter-clockwise**: Previous black box
- **Press**: Open currently displayed black box

## Property Inspector

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Direct | `Direct`, `Next`, or `Previous` |
| Black Box | Dropdown | Lap Timing | Target black box (Direct mode only) |

### Black Box Options

| Option | iRacing Setting |
|--------|-----------------|
| Lap Timing | Lap Timing Black Box |
| Standings | Standings Black Box |
| Relative | Relative Black Box |
| Fuel | Fuel Black Box |
| Tires | Tires Black Box |
| Tire Info | Tire Info Black Box |
| Pit-stop Adjustments | Pit-stop Adjustments Black Box |
| In-car Adjustments | In-car Adjustments Black Box |
| Mirror Adjustments | Mirror Adjustments Black Box |
| Radio Adjustments | Radio Adjustments Black Box |
| Weather | Weather Black Box |

## Icon

### Next/Previous Mode
Shows "BB" with arrow indicating direction (up for next, down for previous).

### Direct Mode
Each black box selection has a unique icon:

| Black Box | Icon Description |
|-----------|------------------|
| Lap Timing | Stopwatch/timer icon |
| Standings | Podium/ranking icon |
| Relative | Cars with gap indicator |
| Fuel | Fuel pump icon |
| Tires | Tire icon |
| Tire Info | Tire with temperature/wear indicator |
| Pit-stop Adjustments | Pit crew/wrench icon |
| In-car Adjustments | Steering wheel/cockpit icon |
| Mirror Adjustments | Mirror icon |
| Radio Adjustments | Microphone/headset icon |
| Weather | Cloud/weather icon |

## Global Key Bindings Used

| Binding ID | iRacing Setting | Default Key |
|------------|-----------------|-------------|
| `blackBoxLapTiming` | Lap Timing Black Box | F1 |
| `blackBoxStandings` | Standings Black Box | F2 |
| `blackBoxRelative` | Relative Black Box | F3 |
| `blackBoxFuel` | Fuel Black Box | F4 |
| `blackBoxTires` | Tires Black Box | F5 |
| `blackBoxTireInfo` | Tire Info Black Box | F6 |
| `blackBoxPitstop` | Pit-stop Adjustments Black Box | F7 |
| `blackBoxIncar` | In-car Adjustments Black Box | F8 |
| `blackBoxMirror` | Mirror Adjustments Black Box | F9 |
| `blackBoxRadio` | Radio Adjustments Black Box | F10 |
| `blackBoxWeather` | Weather Black Box | F11 |
| `nextBlackBox` | Next Black Box | (no default) |
| `prevBlackBox` | Prev Black Box | (no default) |

## Notes

- Next/Previous mode requires user to configure `nextBlackBox` and `prevBlackBox` bindings (iRacing has no defaults)
- Direct mode uses individual black box bindings (F1–F11 by default in iRacing)
