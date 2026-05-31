# Pit Speed Limiter

Toggles the pit lane speed limiter.

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.pit-speed-limiter` |
| Type | Toggle |
| SDK Support | No |
| Communication Method | Key binding |
| Encoder Support | No |

## Behavior

### Button Press
- Toggles pit speed limiter on/off

## Settings

None.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Toggle | A | Pit Speed Limiter |

## Icon States

| State | Description |
|-------|-------------|
| Off | Limiter disabled |
| On | Limiter engaged |

## Telemetry Integration

Can read `dcPitSpeedLimiterToggle` from telemetry to show actual state.

## Notes

- Essential for pit stops to avoid speeding penalties
- Automatically limits car to pit lane speed limit
- Should be engaged before entering pit lane
