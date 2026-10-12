---
title: Replay Control
description: Full replay transport, speed, and navigation in a single configurable action.
sidebar:
  badge:
    text: "27 modes"
    variant: tip
---

Complete command over iRacing's replay system. Playback transport, progressive speed control, and session / lap / incident / car navigation are all available as selectable modes on a single action. Every mode uses the iRacing SDK replay and camera commands — no keyboard bindings.

:::note
Replay Control replaces the legacy Replay Transport, Replay Speed, and Replay Navigation actions. Existing button configurations using those actions continue to work.
:::

Fast Forward, Rewind, Slow Motion, Slow Motion Rewind, Frame Forward, Frame Backward, Increase Speed, and Decrease Speed support long-press: hold the button to repeat the command automatically after an initial 500 ms delay, then every 250 ms.

On a Stream Deck+ dial or a Mirabox knob, Replay Control becomes a replay dial: turn it to change the replay speed and press it to play or pause — see [On a dial](#on-a-dial).

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Play / Pause

Toggle forward playback. Remembers your last slow-motion speed across pause / resume so you can flip between paused and 1/2x without losing the rhythm.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon reflects whether the replay is currently playing or paused based on live replay state

#### Settings

- No additional settings

---

### Play / Pause Backward

Toggle reverse playback. Mirrors slow-motion speed when switching direction.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon reflects whether reverse playback is active based on live replay state

#### Settings

- No additional settings

---

### Stop

Pause playback and reset the remembered speed so the next Play / Pause starts at 1x.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Fast Forward

Progressive fast-forward. The first press jumps to 2x; each subsequent press adds **Step Rate** to the speed magnitude up to the iRacing maximum of 16x.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the speed magnitude increases per press after the initial 2x. `1` (default) gives the legacy 2x → 3x → 4x → … → 16x progression; `2` matches iRacing's own 2x → 4x → 6x → 8x → … → 16x stepping. Range 1–15.

---

### Rewind

Progressive rewind. The first press jumps to −2x; each subsequent press adds **Step Rate** to the reverse speed magnitude up to the iRacing maximum of −16x.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the reverse speed magnitude increases per press after the initial −2x. `1` (default) gives −2x → −3x → −4x → … → −16x; `2` gives −2x → −4x → −6x → −8x → … → −16x. Range 1–15.

---

### Slow Motion

Progressive slow-motion. The first press jumps to 1/2x; each subsequent press makes playback slower by **Step Rate**, walking down the slow-mo ladder down to 1/16x, the slowest speed iRaceDeck sets. Pressing while the replay is rewinding in slow motion resets to 1/2x forward.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the slow-mo denominator increases per press after the initial 1/2x. `1` (default) gives 1/2x → 1/3x → 1/4x → … → 1/16x; `2` gives 1/2x → 1/4x → 1/6x → … → 1/16x. Range 1–15.

---

### Slow Motion Rewind

Progressive slow-motion rewind. The first press jumps to −1/2x; each subsequent press makes the rewind slower by **Step Rate**, down to −1/16x, the slowest speed iRaceDeck sets. Pressing while the replay is in forward slow motion resets to −1/2x.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the slow-mo denominator increases per press after the initial −1/2x. `1` (default) gives −1/2x → −1/3x → −1/4x → … → −1/16x; `2` gives −1/2x → −1/4x → −1/6x → … → −1/16x. Range 1–15.

---

### Frame Forward

Advance exactly one frame.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Frame Backward

Step back exactly one frame.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Increase Speed

Traverse the full speed range upward: 1/16x → ... → 1/2x → 1x → 2x → ... → 16x. Direction-aware — works whether playback is forward or reverse.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Decrease Speed

Traverse the full speed range downward. Direction-aware — works whether playback is forward or reverse.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Set Speed

Set replay playback to a specific speed selected in the Property Inspector.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Speed

The target replay speed. 31 options ranging from `1/16x` slow motion through `1x` up to `16x` fast-forward. Defaults to `1x`.

---

### Speed Display

Read-only display of the current replay speed. Pressing the button does nothing — this is a display-only mode.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon shows the live replay speed pulled from telemetry

#### Settings

- No additional settings

---

### Next Session

Jump to the next session in the replay.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Session

Jump to the previous session in the replay.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Lap

Jump forward one lap.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Lap

Jump backward one lap.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Incident

Jump to the next incident.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Incident

Jump to the previous incident.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to Beginning

Jump to the start of the replay.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to Live

Jump to the live point in the session (end of the replay buffer).

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to My Car

Jump the replay camera to your own car.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to Fastest Lap

Jump the replay cursor to a driver's fastest lap in the current replay session. The default target is **Viewed Car** so the same button can be reused — focus the camera on a competitor and press, focus on yourself and press, etc. Switch the target to **Always my car** to make the button always navigate to your own fastest lap regardless of which car the camera is currently watching.

"Fastest" means the best lap time iRacing reports for that car. The lookup prefers the session's authoritative `ResultsPositions` table (available immediately when a replay is loaded, so the button works without first scrubbing through the replay) and falls back to live `CarIdxBestLapNum` for an in-progress session that hasn't published positions yet. There is no clean-lap filter — iRacing telemetry doesn't expose per-lap incident status, so a lap with a slide or off counts the same as a clean one. The search is also session-scoped: it jumps within whichever practice / qualifying / race session the replay cursor is currently in (matched by `SessionNum`) and does not cross session boundaries.

If the target car hasn't completed a lap yet, the press is a no-op (nothing moves, no error). If the camera target can't be resolved (e.g., transitioning between cars), the press is also a no-op.

The replay lands just **before** the car takes the line, so you see the crossing into the timed lap. What it does from there is set by **Replay jump playback** in the [Settings window](/docs/getting-started/settings/#delays), on the **Delays** tab. With the default, **Remember state**, it carries on exactly as it was before the press: a paused replay stays paused just before the line, and a replay that was playing, in slow motion, fast-forwarding or rewinding continues at the same speed from there. **Play** always plays the lap at 1x — pick it if you want every press to start the lap — and **Stopped** always pauses just before the line. The Play / Pause key shows whichever state the jump left the replay in.

How it gets there depends on whether iRaceDeck saw the lap happen. While the plugin runs during a live session it records the frame at which every car starts every lap into the session's replay record, so a press in the in-session replay — or in the saved replay opened days later — is a single jump straight to the recorded frame. iRacing covers a long jump in steps, so the button pauses the replay first if it was moving, waits until the replay has arrived, and only then switches the camera and leaves the replay as **Replay jump playback** says. It waits for as long as iRacing is still getting there, so a jump across hours of recording still lands. It gives up only when the replay has stopped short of the lap and stayed there for three seconds (or four times the **Fastest Lap Search Delay** below, if that is longer), and then leaves the replay paused where it stopped, whatever the setting says, rather than playing from the wrong spot. Without a record (the plugin wasn't running, someone else's replay, an offline session's replay opened later) the button searches the replay instead: it pauses, maps the sessions in the recording, bisects within the current one (≈ log₂ N jumps) and steps lap by lap to the line, then applies the setting the same way. Each search is followed by a settle gap before the next command, tunable in the [Settings window](/docs/getting-started/settings/#delays) on the **Delays** tab as **Fastest Lap Search Delay** (default 400 ms, range 50–1000 ms in 50 ms steps); slower computers and longer tracks may need a longer gap. The search remembers the frame it found, so the next press for that lap is a single jump. Pressing any other Replay Control key, or a Replay Markers jump, while the jump or the search is still running stops it: the replay is left where your command put it, and the setting is not applied on top of that.

The lap record lives in the same per-app file as [Replay Markers](/docs/actions/view-camera/replay-markers/#where-markers-are-kept), so a record made while one deck app was running is used only by that app; another deck app has no record of that session and falls back to searching the replay.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Target

Which driver's fastest lap the button jumps to. Defaults to **Viewed Car**.

- **Viewed Car** — the car the replay camera is currently focused on
- **Always my car** — your own car, regardless of where the camera is pointed (the camera also moves onto your car so the lap you jump to is what you actually see)

---

### Next Car

Switch the replay camera to the next car. Defers to iRacing's own car-ordering by sending the configured keystroke, so cycling stays correct in live and replay (including replay-while-towed, where telemetry-driven selection picks the wrong driver).

The key binding is shared with Camera Controls' [Cycle by Track Order](/docs/actions/view-camera/camera-focus/#cycle-by-track-order): iRaceDeck keeps one setting for iRacing's Next Car control, so rebinding it for either action changes it for both.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `V`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Car

Switch the replay camera to the previous car. Defers to iRacing's own car-ordering by sending the configured keystroke, so cycling stays correct in live and replay (including replay-while-towed).

The key binding is shared with Camera Controls' [Cycle by Track Order](/docs/actions/view-camera/camera-focus/#cycle-by-track-order): iRaceDeck keeps one setting for iRacing's Previous Car control, so rebinding it for either action changes it for both.

#### Details

- **Method:** Key binding
- **Dial:** No rotation support
- **Default binding:** `Shift+V`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Car (Number Order)

Switch the replay camera to the next car by car number order. Every car in the session is included — cars in the pits, and cars that have already finished and left, so a replay after the race can still focus them. The pace car and spectators are skipped.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Car (Number Order)

Switch the replay camera to the previous car by car number order. Every car in the session is included — cars in the pits, and cars that have already finished and left, so a replay after the race can still focus them. The pace car and spectators are skipped.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial or a Mirabox knob, Replay Control becomes a replay dial. The dial's own **Mode** setting picks what turning does — **Speed Control** steps the replay speed along a ladder of speeds you choose, from fast rewind through pause to fast forward — and the press and touch gestures are the same whatever the Mode: Play/Pause, Set 1x and play, Reverse direction or Jump to Live. Every input is an iRacing replay command, so the dial needs no key binding. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode and its settings) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

The dial works in the replay only. iRacing accepts replay commands only when you are out of the car, so from the car a turn or a press sends nothing and the display is dimmed — open the replay first. Any command the dial sends also stops a running [Jump to Fastest Lap](#jump-to-fastest-lap) search, so your command stands.

#### Details

- **Method:** iRacing API for the rotation and for every press and touch action
- **Dial:** Rotating steps the replay speed along the chosen ladder, one stop per detent — clockwise toward fast forward, counter-clockwise toward fast rewind — with no cap on a fast spin, stopping at the ends of the ladder; works in the replay only
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the display shows the live replay speed, the speed a press will resume while paused, and which way a turn can still change the speed

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen that shows the replay speed. Pushing and turning at the same time changes the speed like a plain turn, and the release then fires nothing. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.
- **Mirabox knob** — turn and push, with the same display drawn on the screen above the knob; the Push slot only, and every action can be put on it, so to reverse the replay from a knob set **Press Action** to **Reverse direction** (see [Dials](/docs/features/dials/#mirabox-knobs)).

#### Setting: Mode

What turning the dial does. Defaults to **Speed Control**. The press and touch settings further down belong to the dial rather than to a mode, so changing the Mode never changes what a press does.

- **Speed Control** (default) — steps the replay speed along your speed ladder — see [Speed Control](#speed-control)

#### Speed Control

Each detent moves the replay one stop along a speed ladder that runs from the fastest rewind speed, through pause, to the fastest forward speed. With the default **Speeds** the ladder is:

```text
−8x   −4x   −2x   −1x   −1/2x   −1/4x   PAUSED   1/4x   1/2x   1x   2x   4x   8x
```

- **Clockwise always moves toward fast forward**, and counter-clockwise toward fast rewind. From −8x a clockwise detent goes to −4x: slower in reverse, and one stop closer to forward.
- **A fast spin walks as many stops as the dial reports detents**, with no limit. However fast you spin, the replay gets a single speed change, to the last stop reached.
- **The ladder stops at its ends.** It never wraps around from the fastest forward speed to the fastest rewind, so a turn past either end does nothing.
- **Pause is a stop like any other.** Turning out of pause starts the replay at the stop next to it — 1/4x or −1/4x on the default ladder — and not at the speed it was playing before. A **Play/Pause** press is the way back to that speed.
- **A speed that is not on your ladder** — one set from a key, or from iRacing's own replay bar — is picked up where it is: the first detent goes to the nearest stop beyond it in the direction you turn (from 3x, clockwise is 4x and counter-clockwise is 2x), and further detents carry on from there.

The dial always starts from the speed the replay is actually playing at, so it stays in step with the Replay Control keys and with iRacing's replay bar.

#### Setting: Speeds (Speed Control)

Which speeds are stops on the ladder, shown while the Mode is **Speed Control**. It is a checkbox grid of every speed iRacing supports — the slow-motion speeds 1/16x … 1/2x and the speeds 1x … 16x, 31 in all. Ticked by default: **1/4x**, **1/2x**, **1x**, **2x**, **4x** and **8x**.

A speed is ticked once and counts in both directions: ticking 16x adds 16x and −16x, so the forward and rewind halves of the ladder always match. Pause is always on the ladder and has no checkbox, and the last ticked box cannot be cleared.

:::tip
The setting is per dial, so two dials can carry different ladders: one with only slow-motion speeds for going through an incident, and one with a few fast speeds for skimming a race.
:::

#### Touch strip

The touch strip (and the screen above a Mirabox knob) shows a "dash box" for the selected Mode:

| Mode | Label | Value | Caption | Arrows |
|---|---|---|---|---|
| Speed Control | `SPEED` | The live replay speed — `4x`, `-1/4x`, or `PAUSED` | While paused, the speed a **Play/Pause** press will resume — `▶ 4x` forward, `◀ 2x` in reverse | Each side lights up while a turn that way would change the speed, and stays dimmed at that end of the ladder |

From the car, or while iRacing is not running, the box is dimmed and shows only its label. You can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Play/Pause** (default for **Press Action**) — pauses a playing replay, and resumes a paused one at the last speed it actually played at, in the same direction — whoever set that speed: the dial, a Replay Control key, or iRacing's own replay bar. Until the replay has played at some speed, it resumes at 1x. While paused, the display's caption shows the speed a press will resume.
- **Set 1x and play** (default for **Long Press**) — plays forward at normal speed, whatever the replay was doing: the quick way out of a rewind, slow motion or pause.
- **Reverse direction** — flips the direction and keeps the speed: 4x becomes −4x, and 1/2x becomes −1/2x. While paused it flips the speed that **Play/Pause** will resume instead, and the replay stays paused — the caption changes direction at once.
- **Jump to Live** — jumps to the live point in the session, exactly like the [Jump to Live](#jump-to-live) key.
- **None** — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Hold past the threshold and the strip previews what letting go will do: `▶ 1x` for Set 1x and play; `PAUSE`, or the speed it will resume (such as `▶ 4x`), for Play/Pause; the reversed speed (such as `◀ 4x`) for Reverse direction; and `LIVE` for Jump to Live. From the car, where the release would do nothing, the strip stays as it is. See [Seeing the outcome before you let go](/docs/features/dials/#seeing-the-outcome-before-you-let-go). Long Press is Stream Deck+ only.

The remembered speed belongs to the dial: the Replay Control keys behave as before.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over the same set { Play/Pause, Set 1x and play, Reverse direction, Jump to Live, None }. Both default to **None** for VR safety.
