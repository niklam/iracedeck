# Enter/Exit/Tow Car

Enters, exits, or requests a tow for the car.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.enter-exit-tow-car` |
| Type | Button |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | No |

## Behavior

### Button Press (Hold)
- Uses long-press: hold the Stream Deck button until iRacing registers the action
- Context-dependent action:
  - If in garage: Enter car
  - If in car: Exit car
  - If stuck on track: Request tow

## Settings

None.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Enter/Exit/Tow | Shift+R | Enter / Exit / Tow Car |

## Icon States

| State | Description |
|-------|-------------|
| Test (out of car, test session) | Steering wheel on green background, "TEST" label |
| Practice (out of car, practice session) | Steering wheel on blue background, "PRACTICE" label |
| Qualify (out of car, qualifying session) | Stopwatch with a lightning bolt on purple background, "QUALIFY" label |
| Grid (out of car, race not started) | Cars lined up on the grid, green background, "GRID" label |
| Race (out of car, race underway) | Flag on green background, "RACE" label |
| Unknown (no session info) | Steering wheel on default background, "DRIVE" label |
| Exit Car (in pit stall) | Exit arrow on red background, "EXIT" label |
| Reset to Pits (on track, non-race) | Reset arrow on red background, "RESET" label |
| Tow (on track, race) | Tow hook on red background, "TOW" label |

## Notes

- Single binding handles all three actions based on context
- Tow brings car back to pit box
- Cannot exit car while moving at speed
