---
title: Camera Controls
description: Cycle cameras, change camera groups, and focus on specific targets with a single button.
sidebar:
  badge:
    text: "14 modes"
    variant: tip
---

Camera Controls combines camera group selection, camera cycling, and focus targeting into one action. Every mode is driven by the iRacing SDK camera commands and needs no configuration — with one exception: **Cycle Sub-Camera** uses iRacing's own Next / Previous Sub Camera key bindings, because the sim's camera commands cannot step a sub-camera (see [that mode](#cycle-sub-camera)). It comes preconfigured with iRacing's default keys, so it works out of the box. Placed on a Stream Deck+ dial the action becomes a camera dial — turn to flip through cameras or cars with the live focus on the touch strip ([On a dial](#on-a-dial)).

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Change Camera

Switch the active camera group to a specific numeric group (1–20). Useful when you want a single button to always jump to the same camera.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Camera Group

The numeric camera group to select (1–20). Defaults to `9`. The mapping from number to group (Nose, Cockpit, TV1, etc.) depends on the car and track combination — hover over the group dropdown in the Property Inspector for the list of available groups.

---

### Cycle Camera

Cycle through camera groups. The **Direction** setting picks whether pressing the button advances to the next group or goes back. When a subset is configured, only the selected groups are cycled.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** Rotation supported ([On a dial](#on-a-dial))
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

Cycle sub-cameras within the currently active camera group (e.g., left / right / front nose variants) — the same step iRacing's own `B` / `Shift+B` keys make. The camera focus stays exactly where it is; only the shot changes, so it works the same whether a car, the pace car, or a scenic view is focused.

#### Details

- **Method:** Key binding — this is the one Camera Controls mode that is not an SDK command
- **Dial:** Rotation supported ([On a dial](#on-a-dial))
- **Default binding:** `B` (next) / `Shift+B` (previous) — iRacing's own defaults
- **Telemetry-aware icon:** No

#### Why this mode uses a key binding

iRacing's camera commands can change **which car** is focused and **which camera group** is active, but they have no working control over the individual camera within a group — the sim ignores that part of the command. Sub-camera stepping is only reachable through iRacing's own **Next Sub Camera** / **Previous Sub Camera** controls, so the button triggers those instead. iRacing decides which camera comes next and wraps around at the ends of the group, exactly as if you had pressed the key yourself.

Both keys are preconfigured to iRacing's defaults, so the mode works without setup — the bindings are stored the first time you open this action's Property Inspector. If you already had a Cycle Sub-Camera button before this update, open its Property Inspector once to store them (the key shows a warning icon until you do). If you have rebound these functions in iRacing, set the matching keys under **Related Key Bindings** in the Property Inspector.

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next sub-camera
- **Previous** — Pressing the button goes back to the previous sub-camera

#### Keyboard simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Next sub-camera | B | Next Sub Camera |
| Previous sub-camera | Shift+B | Previous Sub Camera |

---

### Cycle Car

Switch camera focus to the next / previous car in the field, walking the field by car number. To follow the cars around you on the road instead, use [Cycle by Track Order](#cycle-by-track-order).

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** Rotation supported ([On a dial](#on-a-dial))
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button focuses the next car
- **Previous** — Pressing the button focuses the previous car

---

### Cycle by Track Order

Switch camera focus to the car physically ahead of or behind the focused car **on the road** — the order you see out of the windscreen, not the running order. Lap count and standings play no part: a lapped car sitting right in front of the leader is the car ahead. That makes it the mode to reach for during an incident, where the timing screen says nothing about who is next to whom.

Only competitors are cycled, so the pace car and spectators are never focused, and cars that have left the sim world — towed, or gone after the finish — are stepped over rather than focused on a car the sim would ignore. The camera group and sub-camera you are on are kept, so a press changes the subject and nothing else.

Neighbours come from live car placement. While you scrub a replay *inside a live session* the mode therefore follows the live field rather than the replay cursor — in a replay you open outside a session, the replay is the live data, so it behaves as you would expect. With no other car on track, a press does nothing.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** Rotation supported — the dial's own Cycle by Track Order mode does the same thing ([On a dial](#on-a-dial))
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Ahead** (default) — Pressing the button focuses the car ahead on track
- **Behind** — Pressing the button focuses the car behind on track

---

### Cycle Driving Camera

Cycle through the driving-style cameras (cockpit, bumper, nose, chase, etc.).

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** Rotation supported ([On a dial](#on-a-dial))
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next driving camera
- **Previous** — Pressing the button goes back to the previous driving camera

---

### Focus Your Car

Center the camera on your own car.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Leader

Focus the camera on the current race leader.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Incident

Focus the camera on the latest incident reported by iRacing.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Focus on Most Exciting

Focus the camera on the car the iRacing director rates as most exciting in the moment. Replay only.

#### Details

- **Method:** iRacing API — no key binding needed
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

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Position

The race position to focus. Integer from `1` up. Defaults to `1` (race leader).

---

### Switch by Car Number

Switch camera focus to a car by its car number.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Car Number

The car number to focus. Integer. Defaults to `0`.

---

### Set Camera State

Apply a predefined iRacing camera state bit flag. Useful for scripting camera setups during replays.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Camera State

The numeric camera state value passed to the iRacing SDK. Integer. Defaults to `0`.

## On a dial

Placed on a Stream Deck+ dial, Camera Controls becomes a camera dial for spectating and broadcasting. Turn the dial to flip through cameras or cars — the dial's own **Mode** setting picks the target, and the turn direction replaces the keypad cycle modes' Next / Previous setting. One rule covers every car mode: **where the cycling order _is_ a number, clockwise makes that number go down** — `P4 → P3` in **Cycle by Race Position**, `#94 → #77` in **Cycle by Car #**. **Cycle by Track Order** is ordered by the road rather than by a number (it still shows the focused car's number, it just never sorts by it), and follows the same instinct: clockwise takes you to the car physically ahead on the road. The camera modes are plain lists, so there clockwise simply steps to the next one. A **Reverse rotation** checkbox flips the direction of whichever mode is selected. The touch strip's top line always names the current mode; below it the main content is whatever that mode acts on — the current camera, sub-camera, or car — flanked by what a turn in each direction would switch to, where it can be previewed. Every mode is an iRacing SDK camera command except **Cycle Sub-Camera**, which triggers iRacing's Next / Previous Sub Camera bindings (preconfigured to `B` / `Shift+B` — see the [keypad mode](#cycle-sub-camera)). The Property Inspector automatically shows the dial settings (instead of the keypad Mode) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** iRacing API for every mode except Cycle Sub-Camera, which uses a key binding — the dial reuses the same dispatch as the keypad cycle modes, so both surfaces behave identically
- **Dial:** Rotating cycles the selected target one step per detent — clockwise lowers the number it cycles by (Cycle by Car #, Cycle by Race Position), selects the car ahead on the road (Cycle by Track Order), or steps to the next camera (the camera modes); counter-clockwise does the opposite, and the **Reverse rotation** setting flips the selected mode's direction
- **Default binding:** `B` / `Shift+B` in Cycle Sub-Camera mode (iRacing's own defaults); none in the other modes
- **Telemetry-aware icon:** Yes — the touch strip is a live carousel of the current camera / focused car and its neighbours from telemetry, falling back to a mode label when out of a session

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen carousel that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch gesture.

Dials are currently Stream Deck+ only — the action can't be placed on Mirabox knobs or Ulanzi dials yet (see [Dials](/docs/features/dials/)).

#### Setting: Mode

Which target the dial cycles. Defaults to **Cycle by Car #** — the marquee flip-through-the-field control.

- **Cycle Camera** — steps through the camera groups (Nose, Cockpit, TV1, …). Only the groups you enable in the **Camera Groups** selector take part — the plugin-global camera set (keypad Cycle Camera buttons without their own per-button selection follow it too).
- **Cycle Sub-Camera** — steps through the sub-cameras within the active group, leaving the camera focus untouched. The one binding-driven dial mode (see the [keypad mode](#cycle-sub-camera)); if its bindings are cleared, the touch strip shows the missing-binding warning instead of the camera carousel
- **Cycle by Car #** (default) — moves camera focus between cars ordered by car number. Clockwise selects the next *lower* number and counter-clockwise the next higher, wrapping around at each end — the same "clockwise counts down" feel as Cycle by Race Position
- **Cycle by Race Position** — moves camera focus through the live running order (the plugin's canonical race order, with iRacing's official position as a fallback when no order is available). Clockwise selects the car ahead — the position number decreases. It works before the green flag too: on the grid and through the formation and parade laps the field holds its **starting grid order**, so you can set up shots from pole backwards while the pace car is still leading them round. A driver still sitting in the garage keeps their grid number in the standings but is skipped when cycling, because iRacing can't point a camera at a car that isn't in the world yet
- **Cycle by Track Order** — moves camera focus to the car physically ahead of or behind the focused car *on the road*, regardless of standings or lap count — the order you see in front of you during a race or replay. Clockwise selects the car ahead on track, counter-clockwise the car behind. Handy for jumping between the cars involved in an incident, where the running order says nothing about who is next to whom. Only competitors are cycled — the pace car and cars that have left the world are skipped, the same as the other car modes — and the neighbours come from live car placement, so while you scrub a replay *inside a live session* the mode follows the live field, not the replay cursor (in a replay you open outside a session, the replay is the live data). The same thing on a key is the [Cycle by Track Order](#cycle-by-track-order) keypad mode
- **Cycle Driving Camera** — steps through the driving-style cameras

The touch strip's small top line always names the current mode (`CAMERA`, `SUB-CAMERA`, `CAR #`, `POSITION`, `TRACK ORDER`, or `DRIVING CAM`). Below it, the main content is whatever that mode acts on:

- **Cycle Camera** — the current camera group's icon and name in the centre, flanked by the smaller dimmed neighbour groups from your enabled set — each side shows exactly what a turn that way would switch to.
- **Cycle Sub-Camera** — the current camera's name within the focused group, flanked by the adjacent cameras. iRacing owns the actual stepping order, so treat the side names as a guide to the group's camera list rather than a guarantee of where the next detent lands.
- **Cycle by Car #** — the focused car's number large in the centre (`#number`) flanked by the neighbouring car numbers, each on the side its turn direction lands on — so by default the lower number sits on the clockwise side.
- **Cycle by Race Position** — the focused car's race position large in the centre (`P4`), with its car number shown smaller beneath it, flanked by the smaller dimmed position previews (`P3` / `P5`) — each side the exact position a turn that way would focus. When the focused car has no classified position (the pace / safety car), the centre falls back to a number-only readout instead of a misleading position badge.
- **Cycle by Track Order** — the focused car's number large in the centre (`#number`) flanked by the numbers of the cars physically ahead of and behind it on the road, each on the side its turn direction lands on and captioned `AHEAD` / `BEHIND` beneath — so the strip reads correctly whichever way rotation is mapped. If the focused car has no track position of its own (it has towed or left the world), both directions re-enter the field at the same car; the strip then shows that car on both sides without the captions, rather than labelling one car both ahead and behind.
- **Cycle Driving Camera** — the current camera group's icon and name only. Driving cycling hands the next group to iRacing to resolve, so there is no neighbour to preview.

Everything is drawn in a per-mode accent colour you can override (border, label, value, background) in the **Dash Box Appearance** section of the dial settings. Out of a session the strip falls back to a plain mode label (`CAR #`, `TRACK ORDER`, `CAMERA`, …).

#### Setting: Reverse Rotation

Flips the turn direction of the selected mode. Off by default, which gives the standard mapping described above: clockwise lowers the number in **Cycle by Car #** and **Cycle by Race Position**, selects the car ahead on the road in **Cycle by Track Order**, and steps to the next camera in the list modes. Check it if you prefer the opposite on this dial — clockwise counting *up* through car numbers (the Cycle by Car # behavior before iRaceDeck 2.5), moving back through the running order (race position before 2.3), moving back down the road in Track Order, or reversing any other mode. The touch-strip previews always follow the effective direction.

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
