---
title: Camera Controls
description: Cycle cameras, change camera groups, and focus on specific targets with a single button.
sidebar:
  badge:
    text: "13 modes"
    variant: tip
---

Camera Controls combines camera group selection, camera cycling, and focus targeting into one action. Everything is driven by the iRacing SDK camera commands — no keyboard shortcuts and no configurable bindings. Placed on a Stream Deck+ dial it becomes a camera dial — turn to flip through cameras or cars with the live focus on the touch strip ([On a dial](#on-a-dial)).

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Change Camera

Switch the active camera group to a specific numeric group (1–20). Useful when you want a single button to always jump to the same camera.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Camera Group

The numeric camera group to select (1–20). Defaults to `9`. The mapping from number to group (Nose, Cockpit, TV1, etc.) depends on the car and track combination — hover over the group dropdown in the Property Inspector for the list of available groups.

---

### Cycle Camera

Cycle through camera groups. The **Direction** setting picks whether pressing the button advances to the next group or goes back. When a subset is configured, only the selected groups are cycled.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the button shows a preview icon for the currently active camera group (Nose, Cockpit, TV1, etc.)

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next camera group
- **Previous** — Pressing the button goes back to the previous camera group

#### Setting: Camera Group Subset

A checkbox grid in the Property Inspector lets you pick exactly which groups should participate in the cycle. By default Nose, Cockpit, Chase, TV1, TV2, and TV3 are enabled. Use **Select All** / **Clear Selection** to manage the list quickly.

Each button stores its own subset, so different buttons can cycle different sets. A button that has never saved a selection follows the plugin-global camera set — the one the dial's Cycle Camera mode uses — until you change its grid, which then takes precedence for that button.

---

### Cycle Sub-Camera

Cycle sub-cameras within the currently active camera group (e.g., left / right / front nose variants).

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next sub-camera
- **Previous** — Pressing the button goes back to the previous sub-camera

---

### Cycle Car

Switch camera focus to the next / previous car in the field.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button focuses the next car
- **Previous** — Pressing the button focuses the previous car

---

### Cycle Driving Camera

Cycle through the driving-style cameras (cockpit, bumper, nose, chase, etc.).

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next driving camera
- **Previous** — Pressing the button goes back to the previous driving camera

---

### Focus Your Car

Center the camera on your own car.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Leader

Focus the camera on the current race leader.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Incident

Focus the camera on the latest incident reported by iRacing.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Most Exciting

Focus the camera on the car the iRacing director rates as most exciting in the moment. Replay only.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus Car (pick from grid)

**Elgato Stream Deck only.** Opens the [iRaceDeck Car Selector](/docs/features/stream-deck-profiles/) profile with one key per car in the session, then focuses the camera on whichever car you press. You stay on the grid so you can hop from car to car — the key of the car you're currently watching shows a highlight ring — and the grid's Back key returns you to the profile you came from. Pairs well with the Replay profile for directing camera focus during a replay or broadcast.

#### Details

- **Method:** iRacing API — the camera switch
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Selector Profile

Which bundled profile to open when the key is pressed. Defaults to **iRaceDeck Car Selector**. The dropdown lists the profiles available for this device.

---

### Switch by Position

Switch camera focus to the car currently running in a specific race position.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Position

The race position to focus. Integer from `1` up. Defaults to `1` (race leader).

---

### Switch by Car Number

Switch camera focus to a car by its car number.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Car Number

The car number to focus. Integer. Defaults to `0`.

---

### Set Camera State

Apply a predefined iRacing camera state bit flag. Useful for scripting camera setups during replays.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Camera State

The numeric camera state value passed to the iRacing SDK. Integer. Defaults to `0`.

## On a dial

Placed on a Stream Deck+ dial, Camera Controls becomes a camera dial for spectating and broadcasting. Turn the dial to flip through cameras or cars — the dial's own **Mode** setting picks the target, and the turn direction replaces the keypad cycle modes' Next / Previous setting (clockwise = next, counter-clockwise = previous). The touch strip's top line always names the current mode; below it the main content is whatever that mode acts on — the current camera, sub-camera, or car — with the neighbours either side where they can be previewed. Everything is an iRacing SDK camera command, so no bindings are needed. The Property Inspector automatically shows the dial settings (instead of the keypad Mode) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** iRacing API — the dial reuses the same SDK camera commands as the keypad cycle modes; no key bindings, nothing to configure
- **Dial:** Rotating cycles the selected target one step per detent (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the touch strip is a live carousel of the current camera / focused car and its neighbours from telemetry, falling back to a mode label when out of a session

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen carousel that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch gesture.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Mode

Which target the dial cycles. Defaults to **Cycle by Car #** — the marquee flip-through-the-field control.

- **Cycle Camera** — steps through the camera groups (Nose, Cockpit, TV1, …). Only the groups you enable in the **Camera Groups** selector take part — the plugin-global camera set (keypad Cycle Camera buttons without their own per-button selection follow it too).
- **Cycle Sub-Camera** — steps through the sub-cameras within the active group
- **Cycle by Car #** (default) — moves camera focus to the next / previous car ordered by car number
- **Cycle by Race Position** — moves camera focus up / down the live running order (the plugin's canonical race order, with iRacing's official position as a fallback when no live order is available)
- **Cycle Driving Camera** — steps through the driving-style cameras

The touch strip's small top line always names the current mode (`CAMERA`, `SUB-CAMERA`, `CAR #`, `POSITION`, or `DRIVING CAM`). Below it, the main content is whatever that mode acts on:

- **Cycle Camera** — the current camera group's icon and name in the centre, flanked by the smaller dimmed previous / next groups from your enabled set — exactly what one detent either way would switch to.
- **Cycle Sub-Camera** — the current camera's name within the focused group, flanked by the adjacent cameras (the same order a turn steps through).
- **Cycle by Car #** — the focused car's number large in the centre (`#number`) flanked by the previous / next car numbers.
- **Cycle by Race Position** — the focused car's race position large in the centre (`P4`), with its car number shown smaller beneath it, flanked by the smaller dimmed previous / next position previews (`P3` / `P5`) — the same targets a detent would actually focus. When the focused car has no classified position (the pace / safety car), the centre falls back to a number-only readout instead of a misleading position badge.
- **Cycle Driving Camera** — the current camera group's icon and name only. Driving cycling hands the next group to iRacing to resolve, so there is no neighbour to preview.

Everything is drawn in a per-mode accent colour you can override (border, label, value, background) in the **Dash Box Appearance** section of the dial settings. Out of a session the strip falls back to a plain mode label (`CAR #`, `CAMERA`, …).

#### Setting: Camera Groups (Cycle Camera)

When the dial mode is **Cycle Camera**, a checkbox grid lets you pick which camera groups the dial cycles through and previews on the carousel. This is the **plugin-global camera set** — every dial shares it, and keypad Cycle Camera buttons follow it too until a button saves its own per-button selection. Use **Select All** / **Clear Selection** to manage it quickly.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Focus My Car** — centers the camera on your own car (the keypad Focus Your Car mode)
- **Change Camera** — switches to the next camera angle
- **Focus on Leader** — focuses the current race leader
- **Focus on Incident** — focuses the latest incident reported by iRacing
- **Focus on Most Exciting** — focuses the car the iRacing director rates most exciting
- **None** (default) — does nothing

Both default to **None** (blind-safe). A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed cycles the target (a "push + turn") and never fires the press action.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over the same set { Focus My Car, Change Camera, Focus on Leader, Focus on Incident, Focus on Most Exciting, None }. Both default to **None** for VR safety.
