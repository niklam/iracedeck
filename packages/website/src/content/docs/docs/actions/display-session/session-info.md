---
title: Session Info
description: Display live session information — incidents, time, laps, position, fuel, and flags.
sidebar:
  badge:
    text: "6 modes"
    variant: tip
---

Display real-time session data on your Stream Deck button. Each mode shows different telemetry with a live-updating icon. Session Info is purely a display action — pressing the button does nothing.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Incidents

Show the live incident count. The icon flashes red when a new incident is received so you notice it even if you weren't looking.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the incident count updates live and the icon flashes when a new incident is added

#### Settings

- No additional settings

---

### Time Remaining

Display the session time remaining. The icon flashes when less than 5 minutes remain so you can spot the cutoff at a glance.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the countdown updates every second and the icon flashes when under 5 minutes remain

#### Settings

- No additional settings

---

### Laps

Show the current lap number.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the lap number updates as you cross the start/finish line

#### Settings

- No additional settings

---

### Position

Display the current race position. Optionally shows total cars (e.g., `3/24`) by enabling the **Show Total** setting.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the position updates live as drivers pass or are overtaken

#### Setting: Show Total

- **Off** (default) — Show just your position (e.g., `3`)
- **On** — Show position out of field size (e.g., `3/24`)

---

### Fuel

Show fuel amount or fuel percentage remaining.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the fuel reading updates live

#### Setting: Fuel Format

- **Amount** (default) — Show the absolute fuel amount, respecting your iRacing display units (liters or gallons)
- **Percentage** — Show fuel as a percentage of tank capacity

---

### Flags

Display currently active flags with the corresponding colors and a pulsing animation when flags change.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon updates to reflect the active flag (green, yellow, white, checkered, etc.) and pulses when a new flag is raised

#### Settings

- No additional settings
