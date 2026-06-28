---
title: Splits & Reference
description: Cycle splits delta modes, toggle reference car, mark custom sectors, and use active reset.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Switch between iRacing's split-time delta display modes, toggle the reference car display, target a specific reference car for future actions, mark custom sector start and end points, or use active reset to practice specific track sections without leaving the cockpit.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Cycle Splits Delta

Cycle through iRacing's splits delta display modes. When placed on a key, pressing the button sends the direction chosen in the **Direction** setting. When placed on a dial, rotating the dial cycles next / previous regardless of the Direction setting.

#### Details

- **Method:** Key binding
- **Dial:** Rotation cycles splits delta modes (clockwise = next, counter-clockwise = previous); pressing the dial does nothing in this mode
- **Default binding:** Depends on the selected direction — see the **Direction** setting below
- **Telemetry-aware icon:** No

#### Setting: Direction

Which splits delta hotkey the button press sends. Both directions are globally configurable.

- **Next** (default `Tab`) — Advance to the next splits delta mode
- **Previous** (default `Shift+Tab`) — Go back to the previous splits delta mode

---

### Toggle Reference Car

Toggle the reference car overlay on or off. Replaces the old "Display Reference Car" option from the Toggle UI Elements action.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Ctrl+C`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Select Reference Car

Assign this button to a fixed iRacing driver index (0–63). The button displays that car's number from session info. Pressing the button sets it as the **selected car target** — a shared slot read by Camera Controls (**Focus Selected Car**), Race Admin (**Use Selected Car**), and Replay Control (**Jump to Selected Car**). No camera switch happens on press; this mode is purely for targeting.

A **green border** appears on the button when its car index is the currently active target, so you can see at a glance which car is selected across a row of selector buttons.

#### Details

- **Method:** API (sets the shared selected car target)
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — displays the car number for the assigned driver index

#### Setting: Car Index

The iRacing driver index (0–63) this button is assigned to. Defaults to `0`. The button shows the car number for that index once session info is available.

:::tip
Place multiple **Select Reference Car** buttons side by side, each assigned to a different car index. The green border tells you which one is the active target. Press a different button to re-target instantly.
:::

---

### Custom Sector Start

Mark the start point for a custom sector on the current lap.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Custom Sector End

Mark the end point for a custom sector on the current lap. Together with **Custom Sector Start**, this defines a user-chosen section you can compare against.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Set Active Reset Point

Save the current car state — position, speed, temperatures — as a reset snapshot. Solo practice sessions only.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Reset to Start Point

Teleport the car back to the saved active reset snapshot. Solo practice sessions only.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
