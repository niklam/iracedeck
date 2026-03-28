---
title: Car Control
description: Control car functions including starter, ignition, pit limiter, headlights, DRS, escape, and more
sidebar:
  badge:
    text: "10 modes"
    variant: tip
---

The Car Control action provides quick access to essential car functions. Toggle the pit speed limiter, headlights, Push To Pass, DRS, starter, ignition, or tear off your visor — plus exit the car with Escape — all from a single button.

## Modes

| Mode | Description |
|------|-------------|
| Pit Speed Limiter | Toggles the pit speed limiter. Icon updates based on telemetry to reflect current state. |
| Push To Pass | Activates Push To Pass / Overtake (IndyCar, Super Formula, LMDh, and other cars with OTP). Icon shows ON/OFF status from telemetry (`P2P_Status`). |
| DRS | Toggles DRS (Formula cars). Icon shows ON/OFF status from telemetry (`DRS_Status`). |
| Headlight Flash | Flashes headlights while held. Useful for multi-class racing communication. |
| Tear Off Visor | Tears off visor film in open-wheel cars, clearing the view. |
| Ignition | Toggles the ignition on or off. |
| Starter | Engages the car starter. Hold button to crank. |
| Enter/Exit/Tow | Context-aware car entry, exit, pit reset, or tow. Icon updates dynamically based on telemetry. Hold button to confirm. |
| Escape | Sends the ESC key to exit the car or dismiss dialogs. Supports manual hold or auto-hold (1.5s timed hold with tap-to-cancel). |
| Pause Sim | Pauses the simulation. |

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
Pit Speed Limiter, Push To Pass, DRS, and Enter/Exit/Tow modes feature telemetry-aware icons that reflect the current state in real time. Push To Pass reads the `P2P_Status` variable (not the momentary button press), so it accurately shows whether overtake power is currently active. Enter/Exit/Tow, Headlight Flash, and Starter use a hold pattern — the action is active while the button is pressed. Escape also uses a hold pattern by default, with an optional auto-hold mode that holds ESC for 1.5 seconds on a single tap (press again to cancel early).
:::

:::caution
Headlight Flash, Push To Pass, DRS, and Tear Off Visor have no default iRacing key binding. You must configure both the iRacing binding and the action key binding for these modes to work.
:::
