---
title: Car Control
description: Control car functions including starter, ignition, pit limiter, headlights, DRS, and more
sidebar:
  badge:
    text: "9 modes"
    variant: tip
---

The Car Control action provides quick access to essential car functions. Toggle the starter, ignition, pit speed limiter, headlights, Push To Pass, DRS, or tear off your visor — all from a single button.

## Modes

| Mode | Description |
|------|-------------|
| Starter | Engages the car starter. Hold button to crank. |
| Ignition | Toggles the ignition on or off. |
| Pit Speed Limiter | Toggles the pit speed limiter. Icon updates based on telemetry to reflect current state. |
| Enter/Exit/Tow | Context-aware car entry, exit, pit reset, or tow. Icon updates dynamically based on telemetry. Hold button to confirm. |
| Pause Sim | Pauses the simulation. |
| Headlight Flash | Flashes headlights while held. Useful for multi-class racing communication. |
| Push To Pass | Activates Push To Pass / Overtake (IndyCar, Super Formula, LMDh, and other cars with OTP). Icon shows ON/OFF status from telemetry (`P2P_Status`). |
| DRS | Toggles DRS (Formula cars). Icon shows ON/OFF status from telemetry (`DRS_Status`). |
| Tear Off Visor | Tears off visor film in open-wheel cars, clearing the view. |

## Encoder Support

Yes.

### Enter/Exit/Tow States

The Enter/Exit/Tow mode dynamically changes its icon based on your current state in iRacing:

| State | Condition | Icon |
|-------|-----------|------|
| Enter Car | Out of car (replay/spectator) | Car with inward arrow |
| Exit Car | In the pits | Car with outward arrow |
| Reset to Pits | On track, non-race session | Car with reset arrow |
| Tow | On track, race session | Tow hook |

:::note
Pit Speed Limiter, Push To Pass, DRS, and Enter/Exit/Tow modes feature telemetry-aware icons that reflect the current state in real time. Push To Pass reads the `P2P_Status` variable (not the momentary button press), so it accurately shows whether overtake power is currently active. Enter/Exit/Tow, Headlight Flash, and Starter use a hold pattern — the action is active while the button is pressed.
:::

:::caution
Headlight Flash, Push To Pass, DRS, and Tear Off Visor have no default iRacing key binding. You must configure both the iRacing binding and the action key binding for these modes to work.
:::
