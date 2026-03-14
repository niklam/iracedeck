---
title: Action Types
description: Common action types used across iRaceDeck Stream Deck actions.
---

Common action types used across all iRaceDeck actions.

## Button

Single press action that sends a key or command once.

- **Behavior**: Triggers on button press
- **Visual feedback**: None (stateless)
- **Encoder support**: Typically no

## Toggle

On/off state action with visual feedback.

- **Behavior**: Alternates between on and off states
- **Visual feedback**: Icon changes to reflect current state
- **Encoder support**: Typically no

## Multi-toggle

Cycles through multiple options.

- **Behavior**:
  - Short press: Next option
  - Long press: Previous option (or opens selector)
- **Visual feedback**: Icon/label shows current selection
- **Encoder support**: Yes (rotate to cycle)
- **Configuration**: Options may be fixed or configurable via Property Inspector

## +/- (Increment/Decrement)

Adjustment action for values that can increase or decrease.

- **Behavior**: Button press triggers the configured direction (increase or decrease)
- **Visual feedback**: Icon reflects configured direction; may show current value if available from telemetry
- **Encoder support**: Yes (rotate clockwise = increase, counter-clockwise = decrease)
- **Property Inspector**: Direction dropdown with "Increase" and "Decrease" options

### Standard Settings

All +/- actions use a consistent setting:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Direction | Dropdown | Increase | `Increase` or `Decrease` |

## Adjustment

SDK-based value adjustment with precise control.

- **Behavior**: Sets or adjusts a specific value via iRacing SDK
- **Visual feedback**: Shows current value from telemetry
- **Encoder support**: Yes
- **Configuration**: May include presets or specific value targets

## Hold

Action that activates while button is held.

- **Behavior**: Active only while button is pressed
- **Visual feedback**: Icon changes while held
- **Encoder support**: No

## Configurable

Action with behavior determined by settings.

- **Behavior**: Varies based on Property Inspector configuration
- **Visual feedback**: Depends on configuration
- **Encoder support**: Depends on configuration
- **Configuration**: Dropdown or input fields in Property Inspector
