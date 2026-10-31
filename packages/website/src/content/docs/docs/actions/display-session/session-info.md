---
title: Session Info
description: Display live session information — incidents, time, laps, position, estimated iRating gain/loss, gaps to the cars ahead/behind (your class rivals in a race, the nearest cars on track in practice and qualifying), fuel, laps to empty, flags, track wetness, wind, track and air temperature, and the tire temperatures from your last pit stop — and have the Race Engineer read a value out when you press the key.
sidebar:
  badge:
    text: "14 modes"
    variant: tip
---

Display real-time session data on your Stream Deck button. Each mode shows different telemetry with a live-updating icon. Pressing the key has the Race Engineer read the value out, on the items that speak so far — see [Speak value on press](#speak-value-on-press).

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

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

### Time / Laps Remaining

Show how much of the session is left, in whichever form actually ends it. In a timed session that's the clock, counting down under the title `TIME LEFT`. In a session counted in laps it's the number of laps to go, under `LAPS LEFT` — in a race that's the count the checkered flag follows, so it steps down as the leader crosses the line and reads the same for you as for anyone else in the field, lapped cars included. A race can carry a lap limit and a time limit at once; the key then shows whichever of the two will end it first, and switches over if that changes as the race runs. A session with neither limit — an open practice, say — shows `UNLIM`.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the clock counts down every second, and the laps to go step down as they are completed

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

### Laps

Show the current lap number.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the lap number updates as you cross the start/finish line

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

### Position

Display your current race position — either within your own car class (the default) or overall across the whole field. Optionally shows the field size (e.g., `P3/24`) by enabling the **Show Total** setting. Through the grid, formation, and parade lap — and the run down to the green — it shows your qualifying grid position, then switches to the live running order once you cross the start/finish line to begin racing. Once you take the checkered flag it shows your official finishing position and holds it for the rest of the session, through the cool-down lap and the drive into the pits.

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

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

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

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

### Gaps

Show the live time gap to the car ahead of you and the car behind you. Which two cars those are follows the session: in a race, your rivals in the class standings; in practice, warmup, testing and open qualifying, the cars nearest to you on track.

**In a race** the rows show the car one position ahead and one position behind you in your **class** standings — the cars you're actually racing for position (e.g. P6 and P8 when you're P7). When the neighbor is a full lap or more away the row shows a lap count (e.g. `1L`) instead of a time. Before the green flag, and in the first seconds after the green (while the measurement warms up), the rows show `–`. If you lead your class or run last in it, the empty side shows `–` too.

**In practice, warmup, testing and open qualifying** the rows show the nearest car ahead of you and the nearest car behind you on the road, whatever its class or standings position — the traffic you're about to catch, or that's about to catch you, such as a faster-class car closing on your flying lap. The pace car and cars in the pits are skipped; a car that has gone off the track still counts, since it's traffic you need to know about. A row shows `–` until there's enough data to measure its gap, which takes about as long as the gap itself (a 3-second gap appears after about 3 seconds). With only one other car out, it's both the car ahead and the car behind, so both rows show it; with none, both rows show `–`. Both rows also show `–` while you're in the pits or the garage, and right after you leave the pits the gap behind stays `–` until that car has passed the pit exit. In Lone Qualify and Lone Practice the rows always show `–`: the other cars there are on their own runs, not on the road with you.

In every session the gap is measured as a true crossing-time difference: how long after the other car you reach the same point on track, accurate to about a tenth of a second. Each row is color coded by **trend**, from a smoothed live rate of the gap over roughly the last eighth of a lap: green when the gap is moving your way, meaning you're faster than that car (the car ahead coming closer, the car behind dropping back), red when it's moving against you, and the normal text color while it's steady (within about 0.15 s per lap). The color goes live within a couple of corners of a change and re-establishes just as quickly when a different car takes over a row — after an overtake or a pit stop in a race, or when traffic moves around you in practice.

When one car of a pair is stopped or crawling (under about 30 km/h) — you've spun, or the car ahead has wrecked or is coasting back to the pits, not merely braking for a slow corner — the gap switches to a live estimate of how long the chasing car needs to cover the distance at its current pace, so a stopped driver sees the pursuit counting down instead of a frozen number, and a slow car ahead counts down as you approach it.

An upward triangle marks the gap ahead and a downward triangle the gap behind.

The same measurement drives the Race Engineer's [gap callouts](/docs/actions/audio-voice/pit-crew/#gap-callouts-car-ahead--car-behind), which speak in races only.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — both gaps and their trend colors update continuously

#### Setting: Show

Which rows the key shows. Both default to **On**; with a single row enabled the value renders larger.

- **Gap ahead** — in a race, the car one class position up the standings; in practice, warmup, testing and open qualifying, the nearest car ahead on track
- **Gap behind** — in a race, the car one class position down the standings; in practice, warmup, testing and open qualifying, the nearest car behind on track

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

### Fuel

Show the fuel remaining in the tank, the fuel you used on your last lap, or a rolling average consumption per lap — the numbers you plan a stint around, without an external overlay.

The consumption values only count clean flying laps: laps with a pit stop, an out-lap or in-lap, a tow, or a lap run under a full-course caution are excluded automatically, so a stop never corrupts the average and the display keeps showing the last clean value instead of flickering. The icon shows `--` until the first clean lap has been completed. The data survives garage visits and replay watching — you can tweak the setup in the garage with your consumption numbers still on the key — and after a session change the previous session's values stay visible until you're back in the car and running (in a race, until the green flag), then reset and rebuild from the new session's laps. Values respect your iRacing display units (liters or gallons) and show two decimals.

#### Details

- **Method:** Spoken by the Race Engineer on **Used last lap** and **Average per lap** — no iRacing command
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

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. **Used last lap** and **Average per lap** speak; **Current level** doesn't yet, so a press there does nothing. See [Speak value on press](#speak-value-on-press).

---

### Laps to Empty

Show how many laps the fuel currently in the tank will last — the live tank level divided by your average consumption per lap, displayed with two decimals (e.g., `12.45`). Mid-stint it answers the one question that matters: how many laps until you must pit?

The average is the same mean the Fuel mode's **Average per lap** value shows, over the same **Lap Window** — the two keys always agree. Only clean flying laps feed it: laps with a pit stop, an out-lap or in-lap, a tow, or a lap run under a full-course caution are excluded automatically, so a stop never corrupts the estimate. The icon shows `--` until the first clean lap has been completed. Because the tank level is read live, the estimate shortens continuously as you burn fuel and jumps up the moment you refuel. Like the Fuel consumption values, the data survives garage visits and replays, and after a session change the previous session's average stays in use until you're back in the car and running (in a race, until the green flag).

The value is a lap count, so it's independent of your iRacing display units.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the estimate updates live as fuel burns down

#### Setting: Lap Window

How many recent clean laps the average covers (1–20). Defaults to `5`. Shared with the Fuel mode's **Average per lap** value.

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

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

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

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

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press). The Font Size setting doesn't apply here — the graphic carries its own label.

---

### Track Temperature

Show the track temperature as a whole number with its unit — `41°C`, or `106°F` when your iRacing display units are imperial. It is the same track temperature the Race Engineer quotes in the session-start briefing. The key shows `--` while iRacing gives no reading.

With [Speak value on press](#speak-value-on-press) on, pressing the key has the Race Engineer read it out: *"Track temperature is forty one degrees."*

#### Details

- **Method:** Spoken by the Race Engineer — no iRacing command
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the temperature updates live

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. See [Speak value on press](#speak-value-on-press).

---

### Air Temperature

Show the air temperature as a whole number with its unit — `23°C`, or `73°F` when your iRacing display units are imperial. It is the same air temperature the Race Engineer quotes in the session-start briefing. The key shows `--` while iRacing gives no reading.

With [Speak value on press](#speak-value-on-press) on, pressing the key has the Race Engineer read it out: *"Air temperature is twenty three degrees."*

#### Details

- **Method:** Spoken by the Race Engineer — no iRacing command
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the temperature updates live

#### Setting: Font Size

Size of the rendered value, in PI units (5–36, doubled for SVG render). Defaults to `14`.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. See [Speak value on press](#speak-value-on-press).

---

### Tire Temperatures

Show the tire temperatures from the last time the car came in from a run. By default the key shows all four tires at once under the title `PIT TEMPS`, one figure per tire, laid out as the car seen from above: left front top-left, right front top-right, and the rears below them. Each figure is a whole number with a degree sign, such as `85°`. Set **Tire** to a single corner and the key shows that tire's three zones side by side instead, under a title such as `LF PIT TEMPS`.

:::note
This is a **pit-stop reading, not a live gauge**. iRacing does not report tire temperatures while you drive: it refreshes them only when the car comes in, and then holds the same values through the whole next stint. So the key tells you how the tires came off the run you just finished, which is what you need for judging pressures and camber, and not how warm they are right now.
:::

A reading is taken when you come in from a run on the track: when you drive into your pit stall, when a tow or reset puts the car there, and when you leave the car for the garage. The figures change once, as you arrive, to the tires as they came in, and then hold until the next reading. Pressing **Drive** in the garage never replaces a reading, because the car has not been driven since.

After a tire change the figures still describe the set that **came off**, not the fresh set that went on. The same goes for a tow or reset that puts fresh tires on the car.

Until the first reading the key shows `--` in every slot. It does the same if iRaceDeck connects to iRacing part-way through a session, until the next reading, because nothing shows that the values iRacing is holding came from one. A reading carries over garage visits and into the next session, so a practice stop's temperatures are still on the key while you adjust the setup. It is cleared when iRaceDeck loses its connection to iRacing, for example when you exit the sim.

The figures follow your iRacing display units, Celsius or Fahrenheit, as whole degrees.

**Reading one corner.** The three figures are the tire's zones in the car's left-to-right order, each with a small letter under it: `O` for the outside shoulder, `M` for the middle and `I` for the inside. The outside zone is always on the outside of the car, so it is the left figure on a left-side tire and the right figure on a right-side tire. Put four single-corner keys on your deck in the shape of the car and they read the way the car sits. The spread across the tread is what a single corner adds: an inside zone hotter than the outside suggests camber, and a middle hotter than both edges suggests pressure.

For the raw values in a layout of your own, the same twelve temperatures are available as [template variables](/docs/features/template-variables/#tires--temperature--wear).

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the figures update while the car is in its pit stall and hold until the next reading

#### Setting: Tire

Which tire the key shows. Defaults to **All four**.

- **All four** (default) — one figure per tire in a 2×2 grid, as the car seen from above
- **Left Front**, **Right Front**, **Left Rear**, **Right Rear** — that tire's outside, middle and inside zones

#### Setting: Calculation

How a tire's three zones become its one figure. Only shown for **All four**. Defaults to **Weighted center**.

| Calculation | Figure shown |
|-------------|--------------|
| **Weighted center** (default) | The middle zone counted twice: (outside + 2 × middle + inside) / 4 |
| **Average** | The mean of the three zones |
| **Hottest zone** | The highest of the three zones |
| **Middle only** | The middle zone alone |

#### Setting: Color by temperature

Whether the figures are colored by how they compare with the temperature window you set below. Defaults to **On**. With it off, the figures use the key's text color.

| Color | Meaning | Default |
|-------|---------|---------|
| Blue | Below the window | Below 75 °C (165 °F) |
| Green | In the window | 75–90 °C (165–195 °F) |
| Yellow | Above the window | Above 90 °C (195 °F) |
| Red | Well above the window | Above 100 °C (210 °F) |

With **All four**, each tire's figure is colored by its calculated value. With a single corner, each zone is colored by its own temperature.

The colors describe the tires as the car arrived in its pit stall, after an in-lap and the run down pit lane, so a reading sits below what the tires ran at during the stint. The right window also depends on the car and the tire compound: treat the defaults as a starting point and set your own.

#### Setting: Threshold unit

The unit the three thresholds below are typed in: **°C** (default) or **°F**. Only shown while **Color by temperature** is on. Each unit keeps its own set of thresholds, so switching the unit shows that unit's numbers and never converts or discards what you typed in the other. It is independent of your iRacing display units: the figures on the key follow the display units, and the thresholds stay in the unit you chose here.

#### Setting: Below window / Above window / Well above

The three temperatures that separate the colors, shown with the selected unit in brackets, such as **Below window (°C)**. Only shown while **Color by temperature** is on.

- **Below window** — a figure below this is blue. Defaults to `75` °C, or `165` °F.
- **Above window** — a figure above this is yellow. Defaults to `90` °C, or `195` °F.
- **Well above** — a figure above this is red. Defaults to `100` °C, or `210` °F.

Anything in between is green. The key checks **Well above** first, then **Above window**, then **Below window**, so a set typed out of order still colors predictably, and your numbers are never rewritten. A figure is compared before it is rounded for display, so one shown as `90°` is yellow when the tire is a fraction above 90, and a tire at exactly 90 is still green.

#### Setting: Font Size

The largest size the figures are drawn at, in PI units (5–36, doubled for SVG render). Defaults to `14`. Figures that would not fit their slot at that size shrink until they do, and every figure on the key is drawn at the same size.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

### Wind

Show the wind as an arrow with the wind speed below it. The arrow points the way the wind is travelling, turning in fine 5° steps — 72 positions rather than a handful of fixed ones. What it is measured against depends on the **Direction** setting below; in the default **Relative to car** mode it points where the wind pushes your car.

**Relative to car** (the default) shows the wind against your car's current heading, which is what matters while you drive:

| Arrow | Meaning |
|-------|---------|
| Up | Tailwind — the wind is pushing you along |
| Down | Headwind — you're driving into it |
| Right | Crosswind blowing in from your left, pushing you right |
| Left | Crosswind blowing in from your right, pushing you left |

Because it's measured against your heading, the arrow turns as you go through a corner — useful for knowing which way the wind will push you on the way in. This mode needs you to be in the car and driving: in the garage, on the session screen, or while you are watching a replay, the key shows `--`. Running wide off the racing surface does not affect it — only leaving the car does.

**Compass** shows the wind in the world instead of relative to you, with **north up**. The label names the direction the wind blows *from* — matching how iRacing itself reports wind, so a wind labelled `N` is a northerly, with the arrow pointing down (south) to show where it is actually travelling. This mode works anywhere, including in the garage.

When the wind is calm enough to round to zero in your chosen unit, the key shows the speed with no arrow — a direction would be meaningless at that point.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the arrow and speed update live; in relative mode the arrow tracks your heading as you drive

#### Setting: Direction

How the arrow and label are measured. Defaults to **Relative to car**.

- **Relative to car** — the arrow points where the wind pushes you, measured against your car's heading. Requires being in the car and driving; blank in the garage, on the session screen, and during replay playback.
- **Compass** — the arrow points where the wind travels in the world with north up, and the label names the compass direction it blows from (e.g. `NE 11 km/h`).

#### Setting: Wind Speed

The unit the wind speed is shown in. Defaults to **km/h**.

- **m/s** — iRacing's native unit, shown with one decimal (e.g. `3.1 m/s`)
- **km/h** — whole units (e.g. `11 km/h`)
- **mph** — whole units (e.g. `7 mph`)

#### Setting: Font Size

Size of the label under the arrow, in PI units (5–36, doubled for SVG render). Defaults to `14`. A long compass label shrinks automatically so it still fits the key.

#### Setting: Speak value on press

Whether pressing the key has the Race Engineer read the value out. Defaults to **On**. This item doesn't speak yet, so a press does nothing. See [Speak value on press](#speak-value-on-press).

---

## Speak value on press

For when you can't glance at the deck — in VR, say. **Speak value on press** is on by default and appears on every item: pressing a Session Info key has the Race Engineer read out the value it shows. So far these items speak; on every other item a press does nothing:

- **Fuel** on **Used last lap** — *"Fuel used last lap, two point four liters."*
- **Fuel** on **Average per lap** — *"Average fuel over the last five laps, two point four liters."*
- **Track Temperature** — *"Track temperature is forty one degrees."*
- **Air Temperature** — *"Air temperature is twenty three degrees."*

The lines are the Default voice's; another voice pack may word them its own way.

Fuel is spoken to a tenth, in liters or gallons as your iRacing display units are set, and only clean laps count — the same laps the key shows: a lap with a pit stop, an out-lap or in-lap, a tow, or a lap run under a full-course caution doesn't count. Before your first clean lap a fuel key says *"No clean lap on the books yet."* — and early in a stint the average names the laps it actually covers, so a five-lap key after three clean laps says *"over the last three laps"*. Temperatures are spoken as whole degrees, in Celsius or Fahrenheit the same way; the engineer doesn't say the unit, though a voice pack can add it. With no temperature reading the key shows `--` and a press says nothing.

The figure is read at the moment you press. If the engineer is already talking, your readout waits and plays when that line finishes; press several keys meanwhile and only the last one is read out. The Race Engineer's own calls take priority over a readout — only background chatter such as the pit readback gives way to it. If one of those calls is already waiting its turn when you press, or one comes up while your readout is waiting, it plays first and your readout follows. A readout that still hasn't been spoken a few seconds after the press is skipped — press the key again. Readouts need the Race Engineer switched on and play at its volume — there is no separate switch for them beyond this setting. Nothing is said while iRacing isn't running.

Turn **Speak value on press** off on a key to keep it display-only.
