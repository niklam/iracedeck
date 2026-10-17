---
title: Replay Control
description: Full replay transport, speed, and navigation in a single configurable action.
sidebar:
  badge:
    text: "28 modes"
    variant: tip
---

Complete command over iRacing's replay system. Playback transport, progressive speed control, and session / lap / incident / car navigation are all available as selectable modes on a single action. Every mode uses the iRacing SDK replay and camera commands — no keyboard bindings.

:::note
Replay Control replaces the legacy Replay Transport, Replay Speed, and Replay Navigation actions. Existing button configurations using those actions continue to work.
:::

Fast Forward, Rewind, Slow Motion, Slow Motion Rewind, Frame Forward, Frame Backward, Increase Speed, and Decrease Speed support long-press: hold the button to repeat the command automatically after an initial 500 ms delay, then every 250 ms.

A press or a dial input made while the replay is still jumping, such as a marker jump, a Jump to Fastest Lap or a fast Frame Jog spin, acts when the jump lands, from the frame the jump was going to: Frame Forward and Frame Backward move one frame from it, and Pause leaves the replay paused there. Jump to Beginning and Jump to Live do not wait; they go at once and win. A press made while a Next / Previous Lap, Session or Incident search is still running waits for the search to land, and pressing again acts at once, from where the replay stands, ending a search that is still running. On a paused replay, a search that finds nothing holds a single press until it could no longer be running, so pressing again is the quick way out there too. If a jump does not land on its frame, the press that waited for it does nothing. Quick inputs ride on iRacing's own replay seeking, so they take longer on a slower PC or in a long replay.

On a Stream Deck+ dial or a Mirabox knob, Replay Control becomes a replay dial: turn it to change the replay speed or to step through the replay frame by frame, and press it to play or pause — see [On a dial](#on-a-dial).

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

Jump to the start of the next session in the replay, such as from qualifying to the race.

While a session runs live, iRaceDeck records the frame at which each session starts, in the same per-session replay record that [Jump to Fastest Lap](#jump-to-fastest-lap) uses, whether you are in the car or watching from the garage. With that record the press is a single jump to just inside the next session, in the in-session replay and in a saved replay opened later alike, and the replay then does what **Replay jump playback** in the [Settings window](/docs/getting-started/settings/#delays) says, exactly as for Jump to Fastest Lap. Without a record — iRaceDeck was not running when the session started, the replay file is someone else's, or the replay was recorded before iRaceDeck 3.6, or the record is missing the session in between — the key uses iRacing's own session search, as it always has.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Session

Jump back to the start of the session on screen, or, pressed just after arriving at a session's start, to the start of the session before. It uses the session record the same way as [Next Session](#next-session), and iRacing's own search without one.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Lap

Jump forward one lap of the car the camera is on, to a second before it takes the line.

While the plugin runs during a live session it records the frame at which every car starts every lap, the record [Jump to Fastest Lap](#jump-to-fastest-lap) uses. With it the press is a single jump to the next lap start, in the in-session replay and in a saved replay opened later (which lands about a second earlier), and the replay then does what **Replay jump playback** in the [Settings window](/docs/getting-started/settings/#delays) says, exactly as for Jump to Fastest Lap. Laps are recorded only while you are in the car, so the record can have gaps. Wherever it cannot vouch for the very next lap — a replay recorded without iRaceDeck, laps run while you sat in the garage or after you left the car, a car with nothing recorded, or the step from one session's last lap into the next session — the key uses iRacing's own lap search, as it always has. A second press while the jump is still on its way steps on from where the replay is going, so two quick presses go two laps.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Lap

Jump back to a second before the line on the lap the car the camera is on is running, or, pressed just after arriving there, to the lap before. It uses the lap record the same way as [Next Lap](#next-lap), and iRacing's own search where the record has nothing that way.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Incident

Jump to the next incident, using iRacing's own incident search.

Since iRaceDeck 3.6 the plugin also records each incident while a session runs live: your own whenever you are in the car, and other cars' where iRacing shows their incident counts, which an official race does only once it is over. The key does not use that record to choose where to go yet. With **Enable debug logging** on (the [Settings window](/docs/getting-started/settings/)'s Diagnostics tab), each press logs where iRacing's search landed and the nearest recorded incident, or why the two could not be compared (the search did not land, another command interrupted it, or nothing is recorded). A later version will rest on those comparisons before it switches over.

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

How it gets there depends on whether iRaceDeck saw the lap happen. While the plugin runs during a live session it records the frame at which every car starts every lap into the session's replay record, so a press in the in-session replay — or in the saved replay opened days later — is a single jump straight to the recorded frame. iRacing covers a long jump in steps, so the button pauses the replay first if it was moving, waits until the replay has arrived, and only then switches the camera and leaves the replay as **Replay jump playback** says. It waits for as long as iRacing is still getting there, so a jump across hours of recording still lands. It gives up only when the replay has stopped short of the lap and stayed there for three seconds (or four times the **Fastest Lap Search Delay** below, if that is longer), and then leaves the replay paused where it stopped, whatever the setting says, rather than playing from the wrong spot. Without a record (the plugin wasn't running, someone else's replay, an offline session's replay opened later) the button searches the replay instead: it pauses, maps the sessions in the recording, bisects within the current one (≈ log₂ N jumps) and steps lap by lap to the line, then applies the setting the same way. Each search is followed by a settle gap before the next command, tunable in the [Settings window](/docs/getting-started/settings/#delays) on the **Delays** tab as **Fastest Lap Search Delay** (default 400 ms, range 50–1000 ms in 50 ms steps); slower computers and longer tracks may need a longer gap. The search remembers the frame it found, so the next press for that lap is a single jump. A car is not on the track for the whole recording: it joins late, retires, or sits in the garage between runs. Where the search looks and finds the car gone it learns nothing, so it looks elsewhere in the session until it finds the car. Each jump, and each step from one session of the recording to the next, is waited for in proportion to its length, so one across hours of recording is not given up on while iRacing is still getting there. iRacing moves through a recording at about half an hour of it per second, and a search crosses the session about once. In a six-hour session that makes a search some fifteen seconds, about twenty-five when a session that long has to be crossed first to reach the one you are in, and up to a minute before it gives up on a car it cannot find. The key shows nothing while it works; pressing any other replay key stops it. If the search cannot find the lap, it puts the replay back as it was: on the frame and at the speed it had when you pressed, with the camera on the car you were watching. Pressing any other Replay Control key, or a Replay Markers jump, while the jump or the search is still running stops it. A key's command then goes out once the replay has landed from the step under way, so it acts from the frame the replay reached: a speed or a pause is yours, and the setting is not applied on top of it, while a Next or Previous Lap, Session or Incident press moves on from there and is then followed by the setting, as when the two are pressed slowly.

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

### Jump to Race Start

Jump a race replay to five seconds before the green flag of the race start. On a standing start that shows the grid under the lights; on a rolling start, the field coming to the line. The camera is not changed, so you keep watching the car you chose.

What the replay does once it has arrived is set by **Replay jump playback** in the [Settings window](/docs/getting-started/settings/#delays), on the **Delays** tab, exactly as for [Jump to Fastest Lap](#jump-to-fastest-lap). With the default, **Remember state**, it carries on as it was before the press: a paused replay stays paused five seconds before the green, and a replay that was playing continues at the same speed from there. **Play** always plays the start at 1x, and **Stopped** always pauses there.

While a session runs live, iRaceDeck records the frame at which the race goes green, in the same per-session replay record that [Jump to Fastest Lap](#jump-to-fastest-lap) uses. With that record the press is a single jump, in the in-session replay and in a saved replay opened later alike. A saved replay lands about a second earlier, so roughly six seconds before the green. An offline session (an AI race or a test drive) keeps its record in memory only, for as long as the sim session lasts. Like the lap record, it is kept per deck app, so another deck app has no record of that session and uses the fallback below.

Without a record — iRaceDeck was not running at the green, the replay file is someone else's, or the replay was recorded before iRaceDeck 3.6 — the press falls back to an approximation: five seconds before the pole car starts lap 1. When the lap record has that lap, which replays recorded by iRaceDeck 3.4 and 3.5 do, it is still a single jump. Otherwise the button searches the replay for it. That is the same search Jump to Fastest Lap falls back to, paced by the **Fastest Lap Search Delay** on the **Delays** tab of the [Settings window](/docs/getting-started/settings/#delays). The search briefly switches the camera to the pole car, and puts it back on the car you were watching once the replay has arrived. If the search cannot find that lap, it puts the replay back as it was, on the frame and at the speed it had when you pressed, with the camera back on your car. When the replay has no qualifying grid, or the pole sitter took no part in that race, the car the camera is on stands in for the pole car.

The fallback lands close because the pole car takes the line first: its lap 1 starts a second or two after the green at most, and the five-second lead-in absorbs that. When the lap has to be searched for, iRacing's own lap search decides where lap 1 starts, and on a rolling start it puts that about a second before the green, so the replay lands about six seconds before it. Two cases are known to miss. A pole sitter who started from the pit lane crosses the line late, so the replay lands after the green. On a track whose standing-start grid sits well behind the timing line, it lands correspondingly early.

In a replay with several sessions the button goes to the race. When the replay cursor is in a race session it uses that one, so inside a heat it goes to that heat's green. From practice, qualifying or a warmup it goes to the last race in the replay. If that race has not been run yet, as in the replay of a live event that is still in qualifying, the press looks through the recording, finds no race, and puts the replay back as it was: on the same frame, at the speed it had.

The key turns grey only when the replay holds no race session at all, such as a practice-only or test-drive replay: grey colours and faded artwork, the same look [Replay Markers](/docs/actions/view-camera/replay-markers/#next-marker) keys have when a press would do nothing. A missing record does not grey the key, because the fallback can still land. From the car, with no replay open, a press does nothing, like every other Replay Control jump, and the key does not turn grey.

A second press while a jump or a search is still running is ignored. Pressing any other Replay Control key, or a Replay Markers jump, stops it, and a key's command goes out once the replay has landed from the step under way; a search stopped this way leaves the camera on the pole car.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — greyed out while the replay holds no race session

#### Settings

- No additional settings

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

Placed on a Stream Deck+ dial or a Mirabox knob, Replay Control becomes a replay dial. The dial's own **Mode** setting picks what turning does — **Speed Control** steps the replay speed along a ladder of speeds you choose, from fast rewind through pause to fast forward; **Frame Jog** steps the replay one frame at a time; **Lap**, **Session** and **Incident** step through the replay's laps, sessions and incidents; and **Car** moves the camera from car to car — and the press and touch gestures are the same whatever the Mode: Play / Pause, Set 1x and Play, Reverse Direction, Jump to Live or Jump to Race Start. Everything the dial sends is an iRacing replay command, so it needs no key binding, except in **Car**, which uses iRacing's Next Car / Previous Car binding. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode and its settings) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

The dial works in the replay only. iRacing accepts replay commands only when you are out of the car, so from the car a turn or a press sends nothing and the display is dimmed — open the replay first. Every command the dial sends — a new speed, a pause, a frame step, a jump to live — also stops a running [Jump to Fastest Lap](#jump-to-fastest-lap) search, so your command stands. A turn or press that sends nothing leaves the search running: a turn past an end of the speed ladder, and Reverse Direction while the replay is paused.

#### Details

- **Method:** iRacing API for the rotation in every mode but Car, and for every press and touch action; Car uses the Next Car / Previous Car key binding
- **Dial:** In Speed Control, rotating steps the replay speed along the chosen ladder, one stop per detent — clockwise toward fast forward, counter-clockwise toward fast rewind — with no cap on a fast spin, stopping at the ends of the ladder. In Frame Jog, rotating steps the replay one frame per detent — clockwise to the next frame, counter-clockwise to the previous one. In Lap, Session and Incident, each detent is one lap of the car the camera is on, one session or one incident, clockwise forward. In Car, each turn moves the camera one car, clockwise to the car ahead. All of them work in the replay only
- **Default binding:** No keyboard binding, except Car, which uses iRacing's Next Car / Previous Car binding (V / Shift+V by default)
- **Telemetry-aware icon:** Yes — in Speed Control the display shows the live replay speed, the speed a press will resume while paused, and which way a turn can still change the speed; in Frame Jog it shows the session time of the frame on screen and whether the replay is paused; in Lap, Session, Incident and Car it shows the lap, session, replay time or car on screen and the steps a paced search still has to go — see [Touch strip](#touch-strip)

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen that shows the replay speed or the replay time, depending on the Mode. Pushing and turning at the same time acts like a plain turn, and the release then fires nothing. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.
- **Mirabox knob** — turn and push, with the same display drawn on the screen above the knob; the Push slot only, and every action can be put on it, so to reverse the replay from a knob set **Press Action** to **Reverse Direction** (see [Dials](/docs/features/dials/#mirabox-knobs)).

#### Setting: Mode

What turning the dial does. Defaults to **Speed Control**. The press and touch settings further down belong to the dial rather than to a mode, so changing the Mode never changes what a press does.

- **Speed Control** (default) — steps the replay speed along your speed ladder — see [Speed Control](#speed-control)
- **Frame Jog** — steps the replay one frame per detent — see [Frame Jog](#frame-jog)
- **Lap** — steps the laps of the car the camera is on — see [Lap and Session](#lap-and-session)
- **Session** — steps the sessions of the replay — see [Lap and Session](#lap-and-session)
- **Incident** — steps iRacing's incidents — see [Incident](#incident)
- **Car** — moves the camera to the car ahead or behind — see [Car](#car)

#### Speed Control

Each detent moves the replay one stop along a speed ladder that runs from the fastest rewind speed, through pause, to the fastest forward speed. With the default **Speeds** the ladder is:

```text
−8x   −4x   −2x   −1x   −1/2x   −1/4x   PAUSED   1/4x   1/2x   1x   2x   4x   8x
```

- **Clockwise always moves toward fast forward**, and counter-clockwise toward fast rewind. From −8x a clockwise detent goes to −4x: slower in reverse, and one stop closer to forward.
- **A fast spin walks as many stops as the dial reports detents**, with no limit. However fast you spin, the replay gets a single speed change, to the last stop reached.
- **The ladder stops at its ends.** It never wraps around from the fastest forward speed to the fastest rewind, so a turn past either end does nothing.
- **Pause is a stop like any other.** Turning out of pause starts the replay at the stop next to it — 1/4x or −1/4x on the default ladder — and not at the speed it was playing before. A **Play / Pause** press is the way back to that speed.
- **A speed that is not on your ladder** — one set from a key, or from iRacing's own replay bar — is picked up where it is: the first detent goes to the nearest stop beyond it in the direction you turn (from 3x, clockwise is 4x and counter-clockwise is 2x), and further detents carry on from there.

The dial always starts from the speed the replay is actually playing at, so it stays in step with the Replay Control keys and with iRacing's replay bar.

#### Setting: Speeds (Speed Control)

Which speeds are stops on the ladder, shown only while the Mode is **Speed Control**. It is a checkbox grid of every speed iRacing supports, 31 in all, in two groups: **Slow Motion**, 1/16x … 1/2x, and **Normal and Fast**, 1x … 16x. Ticked by default: **1/4x**, **1/2x**, **1x**, **2x**, **4x** and **8x**.

A speed is ticked once and counts in both directions: ticking 16x adds 16x and −16x, so the forward and rewind halves of the ladder always match. Pause is always on the ladder and has no checkbox, and the last ticked box cannot be cleared.

:::tip
The setting is per dial, so two dials can carry different ladders: one with only slow-motion speeds for going through an incident, and one with a few fast speeds for skimming a race.
:::

#### Frame Jog

Each detent moves the replay one frame: clockwise to the next frame, counter-clockwise to the previous one. It is the mode for finding the exact frame of a contact.

- **Turn slowly for exact steps.** One detent at a time is one frame, every time.
- **A fast spin gets you close.** iRaceDeck adds up the detents and sends the replay to that frame. While you keep spinning, the picture catches up a few times a second and the dial shows the time you are heading for; the replay lands a moment after you stop.
- **The jog always lands on a still frame.** If the replay is playing when you turn, the first detent pauses it and then steps.
- **A Play / Pause press carries on from there.** It resumes at the speed the replay was playing before the jog paused it, and Play / Pause is what **Press Action** is set to by default.

:::caution[Frame Jog depends on how fast iRacing can move its replay]
Every step is a request to iRacing, which takes a moment to move the replay, and longer on a slower PC. iRaceDeck keeps track of the frame you are heading for and waits until iRacing reports it, so a turn made while the replay is still moving is added to where you are heading. Even so, a fast spin can land a few frames from where you expected. If the picture or the time is not where it should be, stop turning, give it a second to settle, and step again. A turn made while another replay jump is still landing, such as a marker jump, steps from the frame that jump is going to and leaves the replay paused there. Slow turns are the exact ones.
:::

Frame Jog has no settings of its own: the **Speeds** grid belongs to Speed Control and is hidden in this mode.

#### Lap and Session

Each detent moves the replay one lap of the car the camera is on, or one session: clockwise forward, counter-clockwise back. The replay lands a second before the car takes the line, or just inside the session, exactly as the [Next Lap](#next-lap) and [Next Session](#next-session) keys do.

- **From iRaceDeck's record, a whole turn is one jump.** Where iRaceDeck recorded the laps or the sessions while the session ran live (see [Next Lap](#next-lap)), a spin of five detents is a single jump five laps on, however fast you spin, and the replay then does what **Replay jump playback** in the [Settings window](/docs/getting-started/settings/#delays) says. A turn while that jump is still landing steps on from where it is going.
- **Without a record, the dial steps through iRacing's own search.** iRacing's lap and session searches cannot be sent one straight after another, so the dial sends one at a time and waits for each to land. The touch strip counts the steps still to go (`+3`, `-2`), a turn the other way takes steps off and can reverse, and a spin queues at most ten steps. The replay is paused while it steps, and once the last step lands it does what **Replay jump playback** says.
- **The record and the search join up.** Where the record runs out part-way through a turn, the dial jumps as far as the record reaches, and the next detent carries on with the search.

#### Incident

Each detent is one step of iRacing's own incident search, paced the same way as a lap or session search without a record. iRaceDeck records incidents too, but the dial does not use that record yet.

#### Car

Each turn moves the camera one car: clockwise to the car ahead on track, counter-clockwise to the car behind. It presses iRacing's **Next Car** / **Previous Car** key binding (V / Shift+V by default, set on the **Key Bindings** tab of the [Settings window](/docs/getting-started/settings/)), the same binding [Camera Controls](/docs/actions/view-camera/camera-controls/)' dial uses, so one turn is one car however fast you spin. Turned while a replay jump is still landing, the camera moves once the jump has landed, because iRacing ignores a camera change during a jump; a further turn in that time replaces the first, so the camera still moves by one car. Car is the one mode that needs a key binding: the Property Inspector shows the binding while the Mode is Car, and the touch strip shows a warning while it is unset.

:::caution[Lap, Session and Incident depend on how fast iRacing can move its replay]
Fast turns ride on iRacing's replay seeking: they are less exact than slow ones, and they vary with your PC and the length of the replay. Two limits come from stepping through iRacing's own search:

- **A turn past the end** — no further lap, session or incident that way — does nothing on a replay playing at normal speed or slower. On a paused replay, or after the first step of a spin, the dial waits a few seconds before it gives up, and leaves the replay paused a frame or two from where it was.
- **A step to something far away**, more than about an hour and a half of recording, is given up the same way, unless it is the first step of a turn made while the replay plays at normal speed or slower. The [Next Session](#next-session) and [Next Incident](#next-incident) keys reach it in every case, and a Lap or Session turn from iRaceDeck's record is one jump however far.
:::

#### Touch strip

The touch strip (and the screen above a Mirabox knob) shows a "dash box" for the selected Mode:

| Mode | Label | Value | Caption | Arrows |
|---|---|---|---|---|
| Speed Control | `SPEED` | The live replay speed — `4x`, `-1/4x`, or `PAUSED` | While paused, the speed a **Play / Pause** press will resume — `► 4x` forward, `◄ 2x` in reverse | Each side lights up while a turn that way would change the speed, and stays dimmed at that end of the ladder |
| Frame Jog | `FRAME` | The session time of the frame on screen, as minutes, seconds and hundredths — `12:34.56` — or, while a turn is still landing, of the frame it is heading for. A frame is 1/60 of a second, so every step changes the hundredths | `PAUSED`, or the speed the replay is playing at — `4x`, `-1/4x` | Both sides are lit: a turn either way steps a frame |
| Lap | `LAP` | The lap of the car the camera is on, from iRaceDeck's record — `L12` — or the replay time, `m:ss`, where the record has none | While the dial steps through iRacing's search, the steps still to go — `+3`; otherwise `PAUSED` or the playing speed | A side is dimmed only when the record has laps and none lies that way |
| Session | `SESSION` | The session on screen — `RACE`, `QUALIFY` | As for Lap | As for Lap, with sessions |
| Incident | `INCIDENT` | The replay time, `m:ss` | As for Lap | Both sides are lit |
| Car | `CAR` | The car the camera is on — `#12` | `PAUSED` or the playing speed | Both sides are lit; a warning shows while the Next Car / Previous Car binding is unset |

From the car, or while iRacing is not running, the box is dimmed and shows only its label. You can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, in either Mode, chosen from:

- **Play / Pause** (default for **Press Action**) — pauses a playing replay, and resumes a paused one at the last speed it actually played at, in the same direction — whoever set that speed: the dial, a Replay Control key, or iRacing's own replay bar. The speed is picked up while a Replay Control dial or key is on the page you have open, so one set while neither was showing is not remembered. Until the replay has played at some speed, it resumes at 1x. In Speed Control the display's caption shows that speed while the replay is paused.
- **Set 1x and Play** (default for **Long Press**) — plays forward at normal speed, whatever the replay was doing: the quick way out of a rewind, slow motion or pause.
- **Reverse Direction** — flips the direction and keeps the speed: 4x becomes −4x, and 1/2x becomes −1/2x. While paused it flips the speed that **Play / Pause** will resume instead, and the replay stays paused — in Speed Control the caption changes direction at once.
- **Jump to Live** — jumps to the live point in the session, exactly like the [Jump to Live](#jump-to-live) key.
- **Jump to Race Start** — jumps to five seconds before the race start, exactly like the [Jump to Race Start](#jump-to-race-start) key, record, fallback and all. On a Mirabox knob, set **Press Action** to it to have the jump a race review starts from on the knob itself.
- **None** — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Hold past the threshold and the strip previews what letting go will do: `► 1x` for Set 1x and Play; `PAUSE`, or the speed it will resume (such as `► 4x`), for Play / Pause; the reversed speed (such as `◄ 4x`) for Reverse Direction; `LIVE` for Jump to Live; and `START` for Jump to Race Start. From the car, where the release would do nothing, the strip stays as it is, and so it does for Jump to Race Start in a replay with no race session. See [Seeing the outcome before you let go](/docs/features/dials/#seeing-the-outcome-before-you-let-go). Long Press is Stream Deck+ only.

The remembered speed belongs to the dial: the Replay Control keys behave as before.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over the same set { Play / Pause, Set 1x and Play, Reverse Direction, Jump to Live, Jump to Race Start, None }. Both default to **None** for VR safety.
