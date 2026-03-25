# Enter/Exit/Tow Car

Enters, exits, or requests a tow for the car.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.enter-exit-tow-car` |
| Type | Button |
| SDK Support | No |
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
| Default | Car/tow icon |

## Notes

- Single binding handles all three actions based on context
- Tow brings car back to pit box
- Cannot exit car while moving at speed
