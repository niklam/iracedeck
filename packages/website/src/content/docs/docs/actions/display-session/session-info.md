---
title: Session Info
description: Display live session information — incidents, time, laps, position, estimated iRating gain/loss, gaps to the cars ahead/behind, fuel, laps to empty, flags, and track wetness.
sidebar:
  badge:
    text: "10 modes"
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

Display your current race position — either within your own car class (the default) or overall across the whole field. Optionally shows the field size (e.g., `P3/24`) by enabling the **Show Total** setting. Through the grid, formation, and parade lap — and the run down to the green — it shows your qualifying grid position, then switches to the live running order once you cross the start/finish line to begin racing.

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

### iRating Gain/Loss

Show your estimated iRating change if the race ended now — e.g. `+31` in green when you're gaining, `-15` in red when you're losing. The estimate uses the community-documented formula over your class's field (each car class is scored separately, exactly like iRacing does). In a running race it follows the live running order; during qualifying it treats the current qualifying standings as the finishing order, and on the race grid and pace lap it starts from the qualifying grid — so a value is shown from the moment positions exist and updates as they change. Early in qualifying, while only part of the field has set a time, the value is scored over the cars that have — expect it to swing as more laps are posted. The key shows `--` in practice and test sessions, and whenever no estimate is possible yet.

:::note
This is an **estimate**, not the official post-race value — iRacing does not expose the official iRating change in real time. Retired and towed cars stay frozen at their last position, mirroring how iRacing scores a retirement.
:::

The same estimate is available as [template variables](/docs/features/template-variables/) — `irating_change` and `irating_new` on every driver prefix, plus `session.sof` for your class's Strength of Field.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the value updates live as positions change, green for a gain and red for a loss

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Gaps

Show the live time gap to the car one position ahead and one position behind you in your **class** standings — the cars you're actually racing for position (e.g. P6 and P8 when you're P7). The gap is measured as a true crossing-time difference: how long after the other car you reach the same point on track, accurate to about a tenth of a second. Each row is color coded by **trend**, from a smoothed live rate of the gap over roughly the last third of a lap: green when the gap is moving your way (the car ahead coming closer, the car behind dropping back), red when it's moving against you, and the normal text color while it's steady (within about 0.15 s per lap). The color goes live within a couple of corners of a change and re-establishes just as quickly after an overtake or a pit stop swaps who you're racing.

An upward triangle marks the gap ahead and a downward triangle the gap behind. When the neighbor is a full lap or more away the row shows a lap count (e.g. `1L`) instead of a time. Race sessions only — in practice and qualifying, before the green flag, and in the first seconds after the green (while the measurement warms up) the rows show `–`. If you lead your class or run last in it, the empty side shows `–` too.

The same measurement drives the Race Engineer's [gap callouts](/docs/actions/audio-voice/pit-crew/#gap-callouts-car-ahead--car-behind).

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — both gaps and their trend colors update continuously

#### Setting: Show

Which rows the key shows. Both default to **On**; with a single row enabled the value renders larger.

- **Gap ahead** — the car one class position up the standings
- **Gap behind** — the car one class position down the standings

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Fuel

Show the fuel remaining in the tank, the fuel you used on your last lap, or a rolling average consumption per lap — the numbers you plan a stint around, without an external overlay.

The consumption values only count clean flying laps: laps with a pit stop, an out-lap or in-lap, or a tow are excluded automatically, so a stop never corrupts the average and the display keeps showing the last clean value instead of flickering. The icon shows `--` until the first clean lap has been completed. The data survives garage visits and replay watching — you can tweak the setup in the garage with your consumption numbers still on the key — and after a session change the previous session's values stay visible until you're back in the car and running (in a race, until the green flag), then reset and rebuild from the new session's laps. Values respect your iRacing display units (liters or gallons) and show two decimals.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the fuel reading updates live

#### Setting: Fuel Value

Which fuel number to display. Defaults to **Current level**.

- **Current level** (default) — The fuel remaining in the tank
- **Used last lap** — Fuel consumed over the most recent clean lap
- **Average per lap** — Mean consumption over the last few clean laps (see **Lap Window**). If fewer clean laps exist than the window asks for, the average covers what's there.

#### Setting: Fuel Format

Only applies to **Current level**.

- **Amount** (default) — Show the absolute fuel amount, respecting your iRacing display units (liters or gallons)
- **Percentage** — Show fuel as a percentage of tank capacity

#### Setting: Lap Window

How many recent clean laps the **Average per lap** value covers (1–20). Defaults to `5`. Only shown for **Average per lap**.

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

---

### Laps to Empty

Show how many laps the fuel currently in the tank will last — the live tank level divided by your average consumption per lap, displayed with two decimals (e.g., `12.45`). Mid-stint it answers the one question that matters: how many laps until you must pit?

The average is the same mean the Fuel mode's **Average per lap** value shows, over the same **Lap Window** — the two keys always agree. Only clean flying laps feed it: laps with a pit stop, out-laps and in-laps, and towed laps are excluded automatically, so a stop never corrupts the estimate. The icon shows `--` until the first clean lap has been completed. Because the tank level is read live, the estimate shortens continuously as you burn fuel and jumps up the moment you refuel. Like the Fuel consumption values, the data survives garage visits and replays, and after a session change the previous session's average stays in use until you're back in the car and running (in a race, until the green flag).

The value is a lap count, so it's independent of your iRacing display units.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the estimate updates live as fuel burns down

#### Setting: Lap Window

How many recent clean laps the average covers (1–20). Defaults to `5`. Shared with the Fuel mode's **Average per lap** value.

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
