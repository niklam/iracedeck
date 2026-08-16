---
title: Car Control
description: Control car functions — starter, ignition, pit limiter, headlights, DRS, Push To Pass, escape, and more.
sidebar:
  badge:
    text: "14 modes"
    variant: tip
---

Quick access to essential car functions: toggle the pit speed limiter, headlights, Push To Pass, DRS, starter, ignition, or tear off your visor — plus exit the car with Escape, pause the sim, and use backup driver inputs (handbrake, second clutch, second shift) for when primary hardware fails — all from a single button.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Pit Speed Limiter

Toggle the pit speed limiter.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `A`
- **Telemetry-aware icon:** Yes — the icon is tri-state and reflects the current pit limiter state from iRacing telemetry in real time. Every state keeps the pit-speed-limit number (a track value, so it stays meaningful even on cars with no limiter) and shows the state on a status bar at the bottom, matching the other tri-state buttons (Fast Repair, Windshield Tear-off, Auto-Fuel):
  - **On** — green `ON` bar and green border
  - **Off** — red `OFF` bar and red border
  - **Not available** — on cars without a pit limiter, a grey `N/A` bar and grey border, so you can tell at a glance the car has no limiter while still seeing the pit-speed limit. The button stays usable — pressing it still sends the configured binding.

The `PIT LIMITER` title is hidden by default so the speed number can be shown larger; enable it from the Title Overrides section if you want the label (the number then shrinks to make room).

#### Settings

- No additional settings

---

### Push To Pass

Activate Push To Pass / Overtake for IndyCar, Super Formula, LMDh, and other cars with OTP.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Push To Pass has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** Yes — the icon reads `P2P_Status` (not the momentary button press) so it shows whether overtake power is currently active, not just whether you pressed the button

#### Settings

- No additional settings

---

### DRS

Toggle DRS on Formula cars.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — DRS has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** Yes — the icon reads `DRS_Status` to show whether DRS is currently open

#### Settings

- No additional settings

---

### Headlight Flash

Flash the headlights while the button is held. Useful for multi-class racing communication.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Headlight Flash has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Tear Off Visor

Tear off a layer of visor film in open-wheel cars, clearing the view.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Tear Off Visor has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Ignition

Toggle the ignition on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `I`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Starter

Engage the car starter. Hold the button to crank.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `S`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Enter/Exit/Tow

Context-aware car entry, exit, pit reset, or tow. The icon updates dynamically based on your current iRacing state, and the button uses a hold pattern — press and hold to confirm the action. Enter Car is instant; Exit, Reset to Pits, and Tow each have an optional auto-hold checkbox that taps the button for you.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Shift+R`
- **Telemetry-aware icon:** Yes — out of the car the icon shows the session context (Test / Practice / Qualify / Grid / Race); in the car it switches between Exit Car, Reset to Pits, and Tow on a red background

#### Setting: State icons

Enter/Exit/Tow automatically picks its display state based on live telemetry. There is no setting to override this — it is shown here only to document the mapping:

- **Enter Car** — Out of the car. The button mirrors iRacing's own session button: a green **Test** button (steering wheel) in test sessions, a blue **Practice** button (steering wheel) in practice, a purple **Qualify** button (stopwatch with a lightning bolt) in qualifying, a green **Grid** button (cars lined up on the grid) before a race starts, and a green **Race** button (flag) once the race is underway. When no session information is available the neutral steering-wheel **Drive** icon is shown.
- **Exit Car** — In the pits; the icon shows a car with an outward arrow on a red background
- **Reset to Pits** — On track in a non-race session; the icon shows a reset arrow on a red background
- **Tow** — On track in a race session; the icon shows a tow hook on a red background

The session-state colors and the red in-car background are state-driven and intentionally not affected by color overrides or global color presets.

#### Setting: Auto-hold

Three independent checkboxes pick which hold-based states use auto-hold. Each one applies only when the matching telemetry state is active, so you can mix manual and auto-hold per state (for example, auto-hold for tow but manual for exit). Enter Car is instant and has no checkbox.

- **Off** (default) — Hold the button to hold `Shift+R`; release the button to release it
- **On** — A single tap holds `Shift+R` for 1.5 seconds automatically; tap again during those 1.5 seconds to cancel early

---

### Escape

Send the `Escape` key to exit the car or dismiss dialogs. The `Escape` key is hardcoded and is not affected by any Property Inspector key binding.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Escape` (hardcoded — iRacing always uses `Escape` for this action, so the binding is not user-configurable)
- **Telemetry-aware icon:** No

#### Setting: Auto Hold

- **Off** (default) — Hold the button to hold `Escape`; release the button to release `Escape`
- **On** — A single tap holds `Escape` for 1.5 seconds automatically; tap again during those 1.5 seconds to cancel early

---

### Pause Sim

Pause the simulation.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Shift+P`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Handbrake

Apply the handbrake while the button is held — a backup control for when your handbrake hardware fails mid-session.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support; press and hold the dial to apply the handbrake, release to let go
- **Default binding:** No default key binding — Handbrake has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Second Clutch

Engage iRacing's Second Clutch while the button is held — a backup for a failed clutch pedal.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support; press and hold the dial to engage the clutch, release to let go
- **Default binding:** No default key binding — Second Clutch has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Second Up Shift

Shift up a gear via iRacing's Second Up Shift control — a backup for a broken upshift paddle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Second Up Shift has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Second Down Shift

Shift down a gear via iRacing's Second Down Shift control — a backup for a broken downshift paddle.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding — Second Down Shift has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
