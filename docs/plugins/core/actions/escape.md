# Escape

Sends the ESC key to iRacing. Used to exit the car or dismiss dialogs.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.car-control` |
| Type | Car Control sub-action |
| SDK Support | No |
| Encoder Support | Yes |

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Control | Dropdown | Pit Speed Limiter | Set to "Escape" for this feature |
| Auto Hold | Checkbox | Off | When enabled, a single tap simulates a 1.5s long press |

The Auto Hold checkbox is only visible when the Escape control is selected.

## Behavior

### Manual hold (Auto Hold OFF)

Press and hold the button to hold ESC. Release the button to release ESC. Same pattern as Starter and Headlight Flash.

### Auto-hold (Auto Hold ON)

- **First press**: Presses ESC and holds it. After 1.5 seconds, ESC is automatically released.
- **Second press** (while timer is running): Cancels the auto-hold and releases ESC immediately.

This lets users tap once to exit the car without physically holding the button for the full duration.

## Keyboard Simulation

| Action | Key | Notes |
|--------|-----|-------|
| Escape | ESC | Hardcoded — not configurable via global bindings |

Unlike other Car Control sub-actions, the Escape key is always ESC in iRacing and is not user-configurable.

## Icon States

| State | Description |
|-------|-------------|
| Default | ESC keycap icon with "ESCAPE" label |

## Notes

- In iRacing, exiting the car requires holding ESC for several seconds
- Auto-hold eliminates the need to physically hold the Stream Deck button
- The ESC key is sent via direct keyboard input, not through the binding dispatcher
- No global key binding is needed — ESC is always ESC in iRacing
