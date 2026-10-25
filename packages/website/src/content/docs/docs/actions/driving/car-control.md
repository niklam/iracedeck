---
title: Car Control
description: Control car functions — starter, ignition, pit limiter, headlights, DRS, Push To Pass, wipers and visor, escape, and more.
sidebar:
  badge:
    text: "15 modes"
    variant: tip
---

Quick access to essential car functions: toggle the pit speed limiter, headlights, Push To Pass, DRS, starter, ignition, or tear off your visor, or clear your view with one key that works the visor or the wipers depending on the car you are in — plus exit the car with Escape, pause the sim, and use backup driver inputs (handbrake, second clutch, second shift) for when primary hardware fails — all from a single button.

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

### Wipers and Visor

One key that clears your view in whatever car you drive: it becomes **Tear Off Visor** in an open-cockpit car and the windshield wipers in a car with a windshield, so a driver who switches between car classes needs one key instead of three. It works out which kind of car you are in from iRacing's telemetry and follows you live when you switch cars or get into the car.

- **Car with a visor** — a press tears off the visor straight away, on the press itself, exactly like the **Tear Off Visor** mode. Holding the key does nothing more.
- **Car with a windshield** — a tap triggers the wipers (a single sweep) and a long press turns the wipers on or off. A press counts as long when you hold it past the plugin-wide [Long-press threshold](/docs/getting-started/settings/#general) on the Settings window's **General** tab (default 500 ms), the same threshold the setup keys use. The press is decided when you let go, so one press never does both. The **Wipers on tap** setting swaps the two. If a car offers only one of the two wiper controls, a tap and a long press both send that one.
- **No car to read** — in the menus, in the garage before you get in, while spectating or watching a replay, or with iRacing closed, the key shows a combined wipers-and-visor icon and a press does nothing. Sending a guess could tear off a visor in a car that turns out to have wipers, or the other way round.
- **Car with neither** — if you are in a car that has neither a visor nor wipers, the key shows the combined icon greyed out and a press does nothing.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding for the visor — Tear Off Visor has no default iRacing binding, so you must configure it in both iRacing and the Property Inspector. The wipers use `Ctrl+Alt+W` (Trigger Wipers) and `Shift+W` (Toggle Wipers)
- **Telemetry-aware icon:** Yes — the icon follows the car you are in: the Tear Off Visor art in a visor car, the art of whatever a tap does in a windshield car, and a combined wipers-and-visor icon when there is no car to read

#### Key bindings

The mode adds no new bindings. It reuses three that already exist, and they are the same settings as in the **Tear Off Visor** mode and in [Cockpit Misc](/docs/actions/cockpit/cockpit-misc/)'s **Toggle Wipers** and **Trigger Wipers** modes, so a binding set in either action is set for both. You only need the side you drive with: someone who only drives open-cockpit cars never has to bind the wipers.

| Car and press | Key binding | Default Key |
|---------------|-------------|-------------|
| Visor car, any press | Tear Off Visor | *(none)* |
| Windshield car, tap (long press with **Wipers on tap** set to Toggle) | Trigger Wipers | `Ctrl+Alt+W` |
| Windshield car, long press (tap with **Wipers on tap** set to Toggle) | Toggle Wipers | `Shift+W` |

The missing-binding warning on the key checks only the bindings the current car uses, so an unbound wiper binding never warns while you drive a visor car, and the other way round. The Property Inspector, which cannot know which car you will drive, warns only when none of the three is bound.

#### Icon states

| State | Icon |
|-------|------|
| Visor car | The Tear Off Visor icon, titled `VISOR` / `TEAR OFF` |
| Windshield car, **Wipers on tap** = Trigger | The Trigger Wipers icon, titled `TRIGGER` / `WIPERS` |
| Windshield car, **Wipers on tap** = Toggle | The Toggle Wipers icon, titled `TOGGLE` / `WIPERS` |
| Windshield car with only one of the two wiper controls | That control's icon, whatever **Wipers on tap** says, since both presses send it |
| No car to read (menus, garage, spectating, replays) | A combined icon split diagonally — wipers in the top-left half, a helmet in the bottom-right — titled `WIPERS` / `VISOR`; a press does nothing |
| Car with neither a visor nor wipers | The combined icon, greyed out; a press does nothing |

#### Setting: Wipers on tap

What a tap does in a car with a windshield. The long press always does the other one, and the Property Inspector says so beside the setting. Has no effect in a visor car. Default **Trigger**.

- **Trigger** (default) — a tap triggers a single wiper sweep; a long press turns the wipers on or off
- **Toggle** — a tap turns the wipers on or off; a long press triggers a single sweep

---

### Ignition

Toggle the ignition on or off.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `I`
- **Telemetry-aware icon:** Yes — the icon is tri-state and reflects the current ignition state from iRacing telemetry in real time:
  - **On** — green `ON` bar and green border — the ignition circuit is live
  - **Off** — red `OFF` bar and red border — the ignition is off
  - **Not available** — grey `N/A` bar and grey border when there's no live telemetry (disconnected, in a replay, or not in the car) — it does not mean the car has no ignition. The button stays usable — pressing it still sends the configured binding.

#### Settings

- No additional settings

---

### Starter

Engage the car starter. Hold the button to crank.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `S`
- **Telemetry-aware icon:** Yes — the icon is tri-state and reflects whether the engine is running, not whether the starter motor is currently turning:
  - **On** — green `ON` bar and green border — the engine is running
  - **Off** — red `OFF` bar and red border — the engine is not running; press to crank
  - **Not available** — grey `N/A` bar and grey border when there's no live telemetry (disconnected, in a replay, or not in the car) — it does not mean the car has no starter. The button stays usable — pressing it still sends the configured binding.
  - **Cranking** — while you hold the button, the START badge flashes between dimmed and full strength, slowly at first and then faster, over the real bar and border; it stops when you let go, or as soon as the engine catches and the key turns green
  - **Already running** — a press gives a single short blink, then the normal `ON` look
  - **No flash** — with no Starter key binding set

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
