---
title: Camera Controls
description: Cycle cameras, change camera groups, and focus on specific targets with a single button.
sidebar:
  badge:
    text: "15 modes"
    variant: tip
---

Camera Controls combines camera group selection, camera cycling, and focus targeting into one action. Most modes are driven by the iRacing SDK camera commands and need no configuration. Two use iRacing's own key bindings instead: **Cycle Sub-Camera** triggers Next / Previous Sub Camera, because the sim's camera commands cannot step a sub-camera (see [that mode](#cycle-sub-camera)), and **Cycle by Track Order** triggers Next / Previous Car, so iRacing itself picks the car ahead or behind, live and in a replay (see [that mode](#cycle-by-track-order)). Both come preconfigured with iRacing's default keys, so they work out of the box. Change Camera and Cycle Camera reach any camera group a custom camera file defines, not only iRacing's standard ones, and remember them for setting up keys away from the track ([Custom camera files](#custom-camera-files)). **Auto Group on Car Change** lets the cameras run by themselves, switching to a new camera group each time the camera moves to another car ([that mode](#auto-group-on-car-change)). Placed on a Stream Deck+ dial the action becomes a camera dial — turn to flip through cameras or cars with the live focus on the touch strip ([On a dial](#on-a-dial)).

In a replay, a camera switch made while the replay is jumping — a Replay Markers jump, a Replay Control Jump to Fastest Lap landing, a fast Frame Jog spin — goes out once the jump has landed, because iRacing ignores a camera change during a jump; a further camera press meanwhile, here or on Replay Control, key or dial, replaces it, so the camera moves once. A mode that changes the car, a car key on the [Car Selector](#focus-car-pick-from-grid) grid included, stops a Replay Control [Jump to Fastest Lap](/docs/actions/view-camera/replay-control/#jump-to-fastest-lap) or [Jump to Race Start](/docs/actions/view-camera/replay-control/#jump-to-race-start) search instead: the replay goes back to where it was when that search began, and then the camera switches. Cycle Camera, Cycle Driving Camera, Change Camera and Cycle Sub-Camera change only the angle, so they wait for a jump but leave a search running. [Auto Group on Car Change](#auto-group-on-car-change) changes only the angle too, and it also lets your own camera switch and a running search go first. Set Camera State always acts at once.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Change Camera

Switch to one specific camera group — Nose, Cockpit, TV1, TV Mixed and so on, or any group a custom camera file defines (see [Custom camera files](#custom-camera-files)). Useful when you want a single button to always jump to the same camera.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the button is drawn greyed while the session you are in has no camera group of its name

#### Setting: Camera Group

The camera group to switch to. Defaults to **Cockpit**. The dropdown lists, in this order:

- **On this track** — every camera group of the session you are in, in iRacing's order, standard and custom alike. When at least one of them is not one of the 25 standard groups, the heading reads **On this track (custom camera file)**, so you can see at a glance that your own camera file is the one loaded. Not shown while iRacing isn't running.
- **Car**, **Chase**, **Track** and **Aerial** — the 25 standard groups, less any already listed under On this track, each marked *(not on this track)* while a session is loaded:
  - **Car** — Nose, Gearbox, Cockpit, Roll Bar, Gyro, and the four suspension cameras
  - **Chase** — Chase, Far Chase, Rear Chase
  - **Track** — TV1, TV2, TV3, Scenic, Pit Lane, Pit Lane 2, TV Static, TV Mixed, TV4, Spotter, Spectator
  - **Aerial** — Chopper, Blimp
- **Other remembered groups** — every other group iRaceDeck remembers, alphabetically, with up to three tracks whose camera file has it: `Drone (not on this track: Spa, Monza +2)` while a session is loaded, `Drone (on Spa, Monza +2)` while none is, or *(seen before)* when no track's camera file has it any more.
- **Saved on this key** — the button's own group, when none of the lists above has it, so a button never looks unset.
- **Other…** — opens a text field where you type a group name yourself.

The button finds the group by its **name** in the session you are in, so it reaches the same camera on every car and track even though iRacing numbers its camera groups differently from one track to the next. A name is matched exactly first, then ignoring upper and lower case, so a typed `dynamictv` reaches `DynamicTV`. If a camera file has two groups whose names differ only in case, only the exact spelling reaches either of them.

Not every track has every group. TV Static and TV Mixed exist on most content, while TV4, Spotter and Spectator are only on some — so far they have turned up on oval and dirt tracks — and a custom group exists only where a camera file defines it. If the session you are in has no group of that name, the button is drawn greyed and pressing it does nothing (the plugin log notes it) rather than switching to an unrelated camera. It looks normal again as soon as a session that has the group is loaded.

Each standard group has an icon of its own. A custom group shows one shared camera-group icon with the group's name as its title, upper-cased like the standard ones — `CAMERA` over `DYNAMICTV` — and **Title Text** replaces it as on any other key.

#### Custom camera files

iRacing's standard cameras come in the 25 groups above, but a camera file — loaded through iRacing's Camera Tool, or loaded automatically for a track — can define any groups under any names. Broadcast camera packages often ship 20 or 30, such as `DynamicTV`, `Grid_Pole` or `SpeedCam`. Change Camera and [Cycle Camera](#cycle-camera) can use every one of them.

Whenever iRacing reports a session's camera groups, live or in a replay, iRaceDeck remembers them: every group name it has seen, and for each track the groups its camera file had the last time that track was loaded. The list is kept in `cameras.json`, next to your [settings file](/docs/getting-started/settings/#where-your-settings-are-stored), so it survives restarts and updates, and you can set up a deck with iRacing closed or at another track. A track's list is replaced each time the track is loaded, so a group dropped from its camera file stops showing as on that track; the name itself stays remembered until you remove it on the Settings window's [General](/docs/getting-started/settings/#general) tab. If you load a camera file after joining a session, its groups appear in the dropdown and the Cycle Camera grids once iRacing reports the new groups to iRaceDeck.

Each name is its own group. `Drone` on one track and `Dynamic TV` on another are two groups, even when you use them for the same kind of shot, and a button set to `Drone` does nothing on a track whose camera file has only `Dynamic TV`. Give the group the same name in both camera files, or put the two on two buttons.

If the contents of `cameras.json` are damaged, iRaceDeck moves the file aside as `cameras.corrupt-<date>.json` in the same folder, shows a banner saying so, and starts a fresh list from the next session. If the file cannot be opened at all (another program holding it, for example), or a newer iRaceDeck version wrote it, iRaceDeck leaves it untouched and keeps the camera groups it sees in memory until it restarts. Your buttons keep their camera groups either way.

If you go back to an older iRaceDeck version, a button set to a standard group keeps pressing that group. A button set to a custom group presses the standard group it was set to before, or Cockpit if it never had one, since an older version knows no custom groups.

---

### Cycle Camera

Cycle through camera groups. The **Direction** setting picks whether pressing the button advances to the next group or goes back. When a subset is configured, only the selected groups are cycled.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** Rotation supported ([On a dial](#on-a-dial))
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — by default the button shows the camera group the next press will switch to; with **Icon Shows** set to **Current camera** it shows the group iRacing is on right now

#### Setting: Direction

- **Next** (default) — Pressing the button advances to the next camera group
- **Previous** — Pressing the button goes back to the previous camera group

#### Setting: Camera Group Subset

A checkbox grid in the Property Inspector lets you pick exactly which groups should participate in the cycle. By default Nose, Cockpit, Chase, TV1, TV2, and TV3 are enabled; every other group starts unchecked, including TV Static, TV Mixed, TV4, Spotter, and Spectator. Use **Select All** / **Clear Selection** to manage the list quickly.

After the four standard sections, a **Remembered groups** section lists every custom camera group iRaceDeck remembers (see [Custom camera files](#custom-camera-files)). The custom groups of the track you are in come first, in iRacing's order; the rest follow alphabetically and dimmed, and hovering one shows the tracks it was seen on. A custom group always starts unchecked. **Select All** checks the standard groups and this track's custom groups and leaves the other remembered groups as they are; **Clear Selection** unchecks every group. A custom group you have checked stays in the list even after you remove it from the remembered groups, so you can still uncheck it.

Not every track has every group — TV4, Spotter and Spectator in particular are only on some content, such as oval and dirt tracks, and a custom group exists only where a camera file defines it. The cycle simply skips any enabled group the session you are in doesn't have, so enabling one costs nothing on a track without it. If none of the enabled groups is in the session, pressing the button does nothing (the plugin log notes it).

Each button stores its own subset, so different buttons can cycle different sets. A button that has never saved a selection follows the plugin-global camera set — the one the dial's Cycle Camera mode uses — until you change its grid, which then takes precedence for that button.

#### Setting: Icon Shows

What the button's icon shows while iRacing is running. Defaults to **Next camera**.

- **Next camera** (default) — the camera group the next press will switch to, following the **Direction** setting
- **Current camera** — the camera group iRacing is on right now, the way a pit-service key shows its current value. It follows the camera however it was changed — this button, another key, a dial, or iRacing itself — and shows the group even when it isn't one of the groups this button cycles through

A custom group is shown with the shared camera-group icon and its name, as on a [Change Camera](#change-camera) button. With **Current camera**, the button is drawn greyed while it has enabled groups but none of them is in the session you are in, since a press would do nothing.

While iRacing isn't connected the button shows a grid of its enabled groups, whichever option you pick. Each button has its own setting, so one key can show where the next press goes while another shows the live camera. The setting is for keys only — on a dial the touch strip already shows the current group in the centre with its neighbours at the sides.

---

### Cycle Sub-Camera

Cycle sub-cameras within the currently active camera group (e.g., left / right / front nose variants) — the same step iRacing's own `B` / `Shift+B` keys make. The camera focus stays exactly where it is; only the shot changes, so it works the same whether a car, the pace car, or a scenic view is focused.

#### Details

- **Method:** Key binding — one of the two Camera Controls modes that are not an SDK command, with [Cycle by Track Order](#cycle-by-track-order)
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

Switch camera focus to the next / previous car in the field, walking the field by car number. Every car in the session is reached — the pace car and spectators are left out — including cars that have already finished and left, so in a replay after the race you can still focus them. To follow the cars around you on the road instead, use [Cycle by Track Order](#cycle-by-track-order).

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

Switch camera focus to the car ahead of or behind the focused car **on track** — the order you see out of the windscreen, not the running order. Lap count and standings play no part: a lapped car sitting right in front of the leader is the car ahead. That makes it the mode to reach for during an incident, where the timing screen says nothing about who is next to whom.

A press triggers iRacing's own **Next Car** / **Previous Car** controls — the same step iRacing's `V` / `Shift+V` keys make — so the sim picks the car, exactly as if you had pressed the key yourself. Next Car is the car ahead on track and Previous Car the car behind. It behaves the same in a live session and in a replay, including a replay you scrub through while you are still in the session, and iRacing decides how cars that have left the session are handled. The pace car counts as a car: when it is on track ahead of or behind the focused car, Next Car / Previous Car lands on it, as iRacing's own keys do.

#### Details

- **Method:** Key binding
- **Dial:** Rotation supported — the dial's own Cycle by Track Order mode does the same thing ([On a dial](#on-a-dial))
- **Default binding:** `V` (ahead) / `Shift+V` (behind) — iRacing's own defaults
- **Telemetry-aware icon:** No

#### Why this mode uses a key binding

iRacing already knows which car is ahead of or behind the one you are watching, at any moment of a live session or a replay, and its Next Car / Previous Car controls step to exactly that car. Working the neighbour out from telemetry cannot match it everywhere — while you scrub a replay inside a live session, the telemetry describes the live field rather than the moment on screen — so the button hands the choice to the sim.

These are the same two bindings Replay Control's [Next Car](/docs/actions/view-camera/replay-control/#next-car) and [Previous Car](/docs/actions/view-camera/replay-control/#previous-car) modes use. iRaceDeck keeps one setting for each, because iRacing has one Next Car control: rebind it for one action and the other follows. Both keys are preconfigured to iRacing's defaults, so the mode works without setup — the plugin stores the default `V` / `Shift+V` bindings itself the first time it starts, if they were never set, so a Cycle by Track Order key or dial you already had keeps working after the update with nothing to open or reconfigure. If you clear the binding yourself, the key shows the missing-binding warning until you set it again. If you have rebound these functions in iRacing, set the matching keys under **Related Key Bindings** in the Property Inspector.

Because it sends a keystroke rather than talking to iRacing's API, this mode follows the [Focus iRacing Window](/docs/features/focus-iracing-window/) setting like every other key-binding mode on this page — unlike the iRacing API modes, which reach iRacing whatever window is in front.

#### Setting: Direction

- **Ahead** (default) — Pressing the button triggers Next Car, focusing the car ahead on track
- **Behind** — Pressing the button triggers Previous Car, focusing the car behind on track

#### Keyboard simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Car ahead | V | Next Car |
| Car behind | Shift+V | Previous Car |

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

The key shows the position it switches to, as `P1` or `P12`, so a row of these keys can be told apart at a glance. The number comes from the **Position** setting rather than from the race: it is there while iRacing isn't running, and it changes as soon as you change the setting. It is part of the key's artwork, so it stays when you set your own Title Text, and it goes away with the artwork if you turn **Show Graphics** off.

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

The key shows the car number it switches to inside its box, such as `7`, `42` or `199`, so a row of these keys can be told apart at a glance. The number comes from the **Car Number** setting rather than from the session: it is there while iRacing isn't running, and it changes as soon as you change the setting. A number longer than three digits is drawn smaller so it stays inside the box. It is part of the key's artwork, so it stays when you set your own Title Text, and it goes away with the artwork if you turn **Show Graphics** off.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Car Number

The car number to focus, typed as it appears on the car. Digits only. Defaults to `0`.

Leading zeros are part of the number: `07` and `7` are different cars, so type the zeros when the car has them, and the key shows them as typed (`07`, `007`). A key set to a number with a leading zero does nothing when no car in the session carries that number.

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

---

### Auto Group on Car Change

Let the cameras run by themselves. A press turns the automation on or off. While it is on, every time the camera moves to another car, the camera switches that car to the next camera group from the button's list, so each car you or iRacing cut to gets a fresh shot. It follows the car however it changed: a Camera Controls or Replay Control key, a dial, iRacing's own UI, iRacing's director, or a car change in a replay. The switch keeps the car and changes only the camera group.

The switch goes out once the camera has stayed on the new car for a quarter of a second, so a dial spun through the field, or a key held to repeat, ends in one group change on the car it lands on rather than one per car on the way. Turning the automation on never switches the camera by itself: it waits for the next car change.

One automation runs at a time, for the whole deck. Pressing another Auto Group button, or a dial's [Auto Group on/off](#on-a-dial) gesture, takes it over with that button's or dial's own list, and only the one running it shows as on; pressing the one that runs it turns it off. Each button keeps its own list, so two buttons can hold two styles, such as a TV set and an onboard set, and a press chooses between them. Changing the list or **Pick** on the button that runs it applies at once; changing them on any other button takes effect when you press that one. It stops if you change the running button's Mode to something else.

The automation is always off when the plugin starts, so the cameras never start moving by themselves in the middle of a stream. It keeps running when you switch to another Stream Deck profile and the button leaves the screen, and it carries on into the next session if iRacing closes while it is on.

In a replay, the group switch waits for a replay jump to land like any other camera switch, and it never pushes your own camera switch aside: if a switch you made is already waiting for a jump, the automation leaves that car's group to you and skips its switch, and while a Replay Control [Jump to Fastest Lap](/docs/actions/view-camera/replay-control/#jump-to-fastest-lap) or [Jump to Race Start](/docs/actions/view-camera/replay-control/#jump-to-race-start) is under way, it waits until that has finished.

The button shows whether the automation is on: the on icon is solid with a filled **A** badge, the off icon outlined. With a [border](/docs/features/border-indicator/) enabled, the border is green while it is on and grey while it is off.

#### Details

- **Method:** iRacing API — no key binding needed
- **Dial:** No rotation support — on a dial it is the Auto Group on/off gesture ([On a dial](#on-a-dial))
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — shows whether the automation is on, and is drawn greyed while the session you are in has none of the button's groups

#### Setting: Pick

How the next group is chosen from the list. Defaults to **In order**.

- **In order** (default) — steps through the list in iRacing's camera-group order, from where it left off, and starts over at the end. If the camera is already in the next group, it takes the one after, so with two or more groups every car change is a new shot
- **Random** — picks any group from the list other than the one the camera is in now

With only one group available, the automation switches to it when the camera is in another group and sends nothing when the camera is already there.

#### Setting: Camera Groups

A checkbox grid of the groups the automation picks from, the same grid as [Cycle Camera](#cycle-camera)'s, with its **Remembered groups** section of custom camera groups (see [Custom camera files](#custom-camera-files)). TV1, TV2 and TV3 are ticked by default, the three groups every track has, so a new button works straight away; every other group starts unticked. Use **Select All** / **Clear Selection** to manage the list quickly.

Groups the session you are in does not have are skipped. If none of the ticked groups is in the session, or none is ticked, nothing is switched and the button is drawn greyed until a session that has one of them is loaded.

## On a dial

Placed on a Stream Deck+ dial or a Mirabox knob, Camera Controls becomes a camera dial for spectating and broadcasting. Turn the dial to flip through cameras or cars — the dial's own **Mode** setting picks the target, and the turn direction replaces the keypad cycle modes' Next / Previous setting. One rule covers every car mode: **where the cycling order _is_ a number, clockwise makes that number go down** — `P4 → P3` in **Cycle by Race Position**, `#94 → #77` in **Cycle by Car #**. **Cycle by Track Order** is ordered by the road rather than by a number (it still shows the focused car's number, it just never sorts by it), and follows the same instinct: clockwise takes you to the car ahead on track. The camera modes are plain lists, so there clockwise simply steps to the next one. A **Reverse rotation** checkbox flips the direction of whichever mode is selected. The touch strip's top line always names the current mode; below it the main content is whatever that mode acts on — the current camera, sub-camera, or car — flanked by what a turn in each direction would switch to, where it can be previewed. Every mode is an iRacing SDK camera command except two: **Cycle Sub-Camera** triggers iRacing's Next / Previous Sub Camera bindings (preconfigured to `B` / `Shift+B` — see the [keypad mode](#cycle-sub-camera)), and **Cycle by Track Order** triggers iRacing's Next / Previous Car bindings (preconfigured to `V` / `Shift+V`, shared with Replay Control — see the [keypad mode](#cycle-by-track-order)). The Property Inspector automatically shows the dial settings (instead of the keypad Mode) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

#### Details

- **Method:** iRacing API for every mode except Cycle Sub-Camera and Cycle by Track Order, which use key bindings — the dial reuses the same dispatch as the keypad cycle modes, so both surfaces behave identically
- **Dial:** Rotating cycles the selected target one step per detent — clockwise lowers the number it cycles by (Cycle by Car #, Cycle by Race Position), triggers Next Car to reach the car ahead on track (Cycle by Track Order), or steps to the next camera (the camera modes); counter-clockwise does the opposite, and the **Reverse rotation** setting flips the selected mode's direction
- **Default binding:** `B` / `Shift+B` in Cycle Sub-Camera mode and `V` / `Shift+V` in Cycle by Track Order mode (iRacing's own defaults); none in the other modes
- **Telemetry-aware icon:** Yes — the touch strip is a live carousel of the current camera / focused car and, where they can be previewed, its neighbours from telemetry, falling back to a mode label when out of a session

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen carousel that always shows. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch gesture.
- **Mirabox knob** — turn and push, with the same carousel drawn on the screen above the knob; the Push slot only (see [Dials](/docs/features/dials/#mirabox-knobs)).

#### Setting: Mode

Which target the dial cycles. Defaults to **Cycle by Car #** — the marquee flip-through-the-field control.

- **Cycle Camera** — steps through the camera groups (Nose, Cockpit, TV1, …). Only the groups you enable in the **Camera Groups** selector take part — the plugin-global camera set (keypad Cycle Camera buttons without their own per-button selection follow it too).
- **Cycle Sub-Camera** — steps through the sub-cameras within the active group, leaving the camera focus untouched. A binding-driven dial mode (see the [keypad mode](#cycle-sub-camera)), like Cycle by Track Order; if its bindings are cleared, the touch strip shows the missing-binding warning instead of the camera carousel
- **Cycle by Car #** (default) — moves camera focus between cars ordered by car number. Clockwise selects the next *lower* number and counter-clockwise the next higher, wrapping around at each end — the same "clockwise counts down" feel as Cycle by Race Position. Every car in the session is reached, the pace car and spectators aside, including cars that have finished and left — so you can flip through the whole field in a replay after the race
- **Cycle by Race Position** — moves camera focus through the live running order (the plugin's canonical race order, with iRacing's official position as a fallback when no order is available). Clockwise selects the car ahead — the position number decreases. It works before the green flag too: on the grid and through the formation and parade laps the field holds its **starting grid order**, so you can set up shots from pole backwards while the pace car is still leading them round. Every car in the order is reached, including a driver still sitting in the garage, who keeps their grid position, and cars that have finished and left, which keep their final position — so after the race you can step through the result in a replay
- **Cycle by Track Order** — moves camera focus to the car ahead of or behind the focused car *on track*, regardless of standings or lap count — the order you see in front of you during a race or replay. Clockwise triggers iRacing's Next Car (the car ahead on track), counter-clockwise Previous Car (the car behind), so the sim picks the car — live and in a replay alike, including one you scrub through while still in the session. The pace car is included when it is on track next to the focused car. Handy for jumping between the cars involved in an incident, where the running order says nothing about who is next to whom. A binding-driven dial mode, like Cycle Sub-Camera, sharing its Next / Previous Car bindings with Replay Control (see the [keypad mode](#cycle-by-track-order)); if they are cleared, the touch strip shows the missing-binding warning instead of the focused car
- **Cycle Driving Camera** — steps through the driving-style cameras

The touch strip's small top line always names the current mode (`CAMERA`, `SUB-CAMERA`, `CAR #`, `POSITION`, `TRACK ORDER`, or `DRIVING CAM`). Below it, the main content is whatever that mode acts on:

- **Cycle Camera** — the current camera group's icon and name in the centre, flanked by the smaller dimmed neighbour groups from your enabled set — each side shows exactly what a turn that way would switch to.
- **Cycle Sub-Camera** — the current camera's name within the focused group, flanked by the adjacent cameras. iRacing owns the actual stepping order, so treat the side names as a guide to the group's camera list rather than a guarantee of where the next detent lands.
- **Cycle by Car #** — the focused car's number large in the centre (`#number`) flanked by the neighbouring car numbers, each on the side its turn direction lands on — so by default the lower number sits on the clockwise side. A car that has left the session still shows there, since a turn still lands on it.
- **Cycle by Race Position** — the focused car's race position large in the centre (`P4`), with its car number shown smaller beneath it, flanked by the smaller dimmed position previews (`P3` / `P5`) — each side the exact position a turn that way would focus. When the focused car has no classified position (the pace / safety car), the centre falls back to a number-only readout instead of a misleading position badge.
- **Cycle by Track Order** — the focused car's number large in the centre (`#number`) only. iRacing picks the car a turn lands on, so there is no neighbour to preview, and a guess that disagreed with where the turn lands would be worse than none.
- **Cycle Driving Camera** — the current camera group's icon and name only. Driving cycling hands the next group to iRacing to resolve, so there is no neighbour to preview.

Everything is drawn in a per-mode accent colour you can override (border, label, value, background) in the **Dash Box Appearance** section of the dial settings. Out of a session the strip falls back to a plain mode label (`CAR #`, `TRACK ORDER`, `CAMERA`, …).

#### Setting: Reverse Rotation

Flips the turn direction of the selected mode. Off by default, which gives the standard mapping described above: clockwise lowers the number in **Cycle by Car #** and **Cycle by Race Position**, triggers Next Car, the car ahead on track, in **Cycle by Track Order**, and steps to the next camera in the list modes. Check it if you prefer the opposite on this dial — clockwise counting *up* through car numbers (the Cycle by Car # behavior before iRaceDeck 2.5), moving back through the running order (race position before 2.3), triggering Previous Car (the car behind) in Track Order, or reversing any other mode. The touch-strip previews always follow the effective direction.

#### Setting: Camera Groups (Cycle Camera)

When the dial mode is **Cycle Camera**, a checkbox grid lets you pick which camera groups the dial cycles through and previews on the carousel. This is the **plugin-global camera set** — every dial shares it, and keypad Cycle Camera buttons follow it too until a button saves its own per-button selection. Use **Select All** / **Clear Selection** to manage it quickly. It lists the same groups as the keypad grid, its **Remembered groups** section of custom camera groups included (see [Custom camera files](#custom-camera-files)): TV Static, TV Mixed, TV4, Spotter, Spectator and every custom group start unchecked, and an enabled group the session doesn't have is skipped, both when turning and in the carousel. A custom group shows on the carousel with the shared camera-group icon and its name.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Focus My Car** — centers the camera on your own car (the keypad Focus Your Car mode)
- **Change Camera** — switches to the next camera angle
- **Focus on Leader** — focuses the current race leader
- **Focus on Incident** — focuses the latest incident reported by iRacing
- **Focus on Most Exciting** — focuses the car the iRacing director rates most exciting
- **Auto Group on/off** — turns [Auto Group on Car Change](#auto-group-on-car-change) on or off, with this dial's own list (see [Auto Group Camera Groups](#setting-auto-group-camera-groups--pick) below)
- **None** (default) — does nothing

Both default to **None** (blind-safe). A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Turning the dial while pressed cycles the target (a "push + turn") and never fires the press action. On a Mirabox knob, the same choices are offered on Push.

With Long Press set to **Focus My Car**, holding past the threshold shows the car number the release will jump to, so you can let go on the change — see [Seeing the outcome before you let go](/docs/features/dials/#seeing-the-outcome-before-you-let-go). With Long Press set to **Auto Group on/off**, it shows `AUTO ON` or `AUTO OFF`, whichever the release will do. The other gestures show nothing while held: iRacing picks the car for Focus on Leader, Focus on Incident and Focus on Most Exciting itself, so the plugin cannot say in advance which one you will get.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over the same set { Focus My Car, Change Camera, Focus on Leader, Focus on Incident, Focus on Most Exciting, Auto Group on/off, None }. Both default to **None** for VR safety. A Long Touch shows nothing while you hold it, since the Stream Deck app reports a touch only once it has ended.

#### Setting: Auto Group Camera Groups / Pick

Shown while any of the dial's gestures is set to **Auto Group on/off**. They are the dial's own list and pick order for [Auto Group on Car Change](#auto-group-on-car-change), apart from the dial's Camera Groups for Cycle Camera and from every button's, so a dial and a button can run different styles. **Pick** defaults to **In order**, and **Auto Group Camera Groups** has TV1, TV2 and TV3 ticked by default; both work as on the [button](#setting-pick).

The automation the dial starts is the same single one a button starts: pressing the gesture again turns it off, and an Auto Group button or another dial takes it over. While this dial runs it, its touch strip (or the screen above a Mirabox knob) shows a small **A** badge in the top-right corner. Changing the dial's list or Pick applies at once while it runs, and setting every gesture on the dial to something other than Auto Group on/off turns it off.
