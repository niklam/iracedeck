---
title: Car Control
description: Control car functions — starter, ignition, pit limiter, headlights, DRS, Push To Pass, escape, and more.
sidebar:
  badge:
    text: "10 modes"
    variant: tip
---

Quick access to essential car functions: toggle the pit speed limiter, headlights, Push To Pass, DRS, starter, ignition, or tear off your visor — plus exit the car with Escape or pause the sim — all from a single button.

## Modes

Select the mode from the **Control** dropdown in the Property Inspector.

### Pit Speed Limiter

Toggle the pit speed limiter.

#### Details

- **Dial:** No rotation support
- **Default binding:** `A`
- **Telemetry-aware icon:** Yes — the icon reflects the current pit limiter state from iRacing telemetry in real time

#### Settings

- No additional settings

---

### Push To Pass

Activate Push To Pass / Overtake for IndyCar, Super Formula, LMDh, and other cars with OTP.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding — Push To Pass has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** Yes — the icon reads `P2P_Status` (not the momentary button press) so it shows whether overtake power is currently active, not just whether you pressed the button

#### Settings

- No additional settings

---

### DRS

Toggle DRS on Formula cars.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding — DRS has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** Yes — the icon reads `DRS_Status` to show whether DRS is currently open

#### Settings

- No additional settings

---

### Headlight Flash

Flash the headlights while the button is held. Useful for multi-class racing communication.

#### Details

- **Dial:** No rotation support; press and hold the dial to flash, release to stop
- **Default binding:** No default key binding — Headlight Flash has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Tear Off Visor

Tear off a layer of visor film in open-wheel cars, clearing the view.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding — Tear Off Visor has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Ignition

Toggle the ignition on or off.

#### Details

- **Dial:** No rotation support
- **Default binding:** `I`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Starter

Engage the car starter. Hold the button to crank.

#### Details

- **Dial:** No rotation support; press and hold the dial to crank, release to stop
- **Default binding:** `S`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Enter/Exit/Tow

Context-aware car entry, exit, pit reset, or tow. The icon updates dynamically based on your current iRacing state, and the button uses a hold pattern — press and hold to confirm the action.

#### Details

- **Dial:** No rotation support; press and hold the dial to confirm, release to cancel
- **Default binding:** `Shift+R`
- **Telemetry-aware icon:** Yes — the icon switches between Enter Car, Exit Car, Reset to Pits, and Tow based on whether you are out of the car, in the pits, on track in a non-race session, or on track in a race

#### Setting: State icons

Enter/Exit/Tow automatically picks one of four display states based on live telemetry. There is no setting to override this — it is shown here only to document the mapping:

- **Enter Car** — Out of car (replay or spectator); the icon shows a car with an inward arrow
- **Exit Car** — In the pits; the icon shows a car with an outward arrow
- **Reset to Pits** — On track in a non-race session; the icon shows a car with a reset arrow
- **Tow** — On track in a race session; the icon shows a tow hook

---

### Escape

Send the `Escape` key to exit the car or dismiss dialogs. The `Escape` key is hardcoded and is not affected by any Property Inspector key binding.

#### Details

- **Dial:** No rotation support; manual hold holds `Escape` while the button is pressed, auto-hold releases after 1.5 seconds or when you press again
- **Default binding:** `Escape` (hardcoded — iRacing always uses `Escape` for this action, so the binding is not user-configurable)
- **Telemetry-aware icon:** No

#### Setting: Auto Hold

- **Off** (default) — Hold the button to hold `Escape`; release the button to release `Escape`
- **On** — A single tap holds `Escape` for 1.5 seconds automatically; tap again during those 1.5 seconds to cancel early

---

### Pause Sim

Pause the simulation.

#### Details

- **Dial:** No rotation support
- **Default binding:** `Shift+P`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
