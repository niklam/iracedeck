---
title: Session Info
description: Display live session information — incidents, time, laps, position, fuel, flags, and track wetness.
sidebar:
  badge:
    text: "7 modes"
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

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Time Remaining

Display the session time remaining. The icon flashes when less than 5 minutes remain so you can spot the cutoff at a glance.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the countdown updates every second and the icon flashes when under 5 minutes remain

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Laps

Show the current lap number.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the lap number updates as you cross the start/finish line

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Position

Display your current race position — either within your own car class (the default) or overall across the whole field. Optionally shows the field size (e.g., `P3/24`) by enabling the **Show Total** setting.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the position updates live as drivers pass or are overtaken

#### Setting: Position Type

Which position to display. Defaults to **Class**.

- **Class** (default) — Your position within your car class. In single-class races this matches your overall position.
- **Overall** — Your position across the entire field, regardless of class.

#### Setting: Show Total

Whether to append the field size after your position. Defaults to **Off**.

- **Off** (default) — Show just your position (e.g., `P3`)
- **On** — Show your position out of the field size (e.g., `P3/24`). The total is scoped to match Position Type — cars in your class for **Class**, the whole field for **Overall**.

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

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

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Flags

Display currently active flags with the corresponding colors and a pulsing animation when flags change.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon updates to reflect the active flag (green, yellow, white, checkered, etc.) and pulses when a new flag is raised

#### Setting: UI

- **Blank when no flag** — When enabled, the icon shows no value text while no flag is active, leaving the button visually empty (background color and title visibility are unaffected and remain configurable). When a flag becomes active, the flag label, color, and pulse/flash effects render as usual. Defaults to `Off` (the icon shows `--` when no flag is active).

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Track Wetness

Show the current track-wetness state with a centered vertical 6-segment bar that fills cumulatively as the track gets wetter using a cyan→deep-blue gradient. The current state name is rendered as the icon title. Maps to iRacing's `irsdk_TrackWetness` telemetry.

| State | Bar | Title |
|-------|-----|-------|
| Unknown | empty | `--` |
| Dry | empty | `DRY` |
| Mostly Dry | 1 segment | `MOSTLY DRY` |
| Very Lightly Wet | 2 segments | `V. LIGHT` |
| Lightly Wet | 3 segments | `LIGHT` |
| Moderately Wet | 4 segments | `MODERATE` |
| Very Wet | 5 segments | `VERY WET` |
| Extremely Wet | 6 segments | `EXTREME` |

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the bar and label update live as track conditions shift through the eight states

#### Settings

- No additional settings. The Font Size slider does not apply (the graphic carries its own label).
