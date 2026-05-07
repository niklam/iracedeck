---
title: Replay Control
description: Full replay transport, speed, and navigation in a single configurable action.
sidebar:
  badge:
    text: "26 modes"
    variant: tip
---

Complete command over iRacing's replay system. Playback transport, progressive speed control, and session / lap / incident / car navigation are all available as selectable modes on a single action. Every mode uses the iRacing SDK replay and camera commands — no keyboard bindings.

:::note
Replay Control replaces the legacy Replay Transport, Replay Speed, and Replay Navigation actions. Existing button configurations using those actions continue to work.
:::

Fast Forward, Rewind, Slow Motion, Slow Motion Rewind, Frame Forward, Frame Backward, Increase Speed, and Decrease Speed support long-press: hold the button to repeat the command automatically after an initial 500 ms delay, then every 250 ms.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Play / Pause

Toggle forward playback. Remembers your last slow-motion speed across pause / resume so you can flip between paused and 1/2x without losing the rhythm.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon reflects whether the replay is currently playing or paused based on live replay state

#### Settings

- No additional settings

---

### Play / Pause Backward

Toggle reverse playback. Mirrors slow-motion speed when switching direction.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon reflects whether reverse playback is active based on live replay state

#### Settings

- No additional settings

---

### Stop

Pause playback and reset the remembered speed so the next Play / Pause starts at 1x.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Fast Forward

Progressive fast-forward. The first press jumps to 2x; each subsequent press adds **Step Rate** to the speed magnitude up to the iRacing maximum of 16x.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the speed magnitude increases per press after the initial 2x. `1` (default) gives the legacy 2x → 3x → 4x → … → 16x progression; `2` matches iRacing's own 2x → 4x → 6x → 8x → … → 16x stepping. Range 1–15.

---

### Rewind

Progressive rewind. The first press jumps to −2x; each subsequent press adds **Step Rate** to the reverse speed magnitude up to the iRacing maximum of −16x.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the reverse speed magnitude increases per press after the initial −2x. `1` (default) gives −2x → −3x → −4x → … → −16x; `2` gives −2x → −4x → −6x → −8x → … → −16x. Range 1–15.

---

### Slow Motion

Progressive slow-motion. The first press jumps to 1/2x; each subsequent press makes playback slower by **Step Rate**, walking down the slow-mo ladder up to the iRacing minimum of 1/16x. Pressing while the replay is rewinding in slow motion resets to 1/2x forward.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the slow-mo denominator increases per press after the initial 1/2x. `1` (default) gives 1/2x → 1/3x → 1/4x → … → 1/16x; `2` gives 1/2x → 1/4x → 1/6x → … → 1/16x. Range 1–15.

---

### Slow Motion Rewind

Progressive slow-motion rewind. The first press jumps to −1/2x; each subsequent press makes the rewind slower by **Step Rate**, up to the iRacing minimum of −1/16x. Pressing while the replay is in forward slow motion resets to −1/2x.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Step Rate

How much the slow-mo denominator increases per press after the initial −1/2x. `1` (default) gives −1/2x → −1/3x → −1/4x → … → −1/16x; `2` gives −1/2x → −1/4x → −1/6x → … → −1/16x. Range 1–15.

---

### Frame Forward

Advance exactly one frame.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Frame Backward

Step back exactly one frame.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Increase Speed

Traverse the full speed range upward: 1/16x → ... → 1/2x → 1x → 2x → ... → 16x. Direction-aware — works whether playback is forward or reverse.

#### Details

- **Dial:** Rotation progressively adjusts replay speed (clockwise = increase, counter-clockwise = decrease)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Decrease Speed

Traverse the full speed range downward. Direction-aware — works whether playback is forward or reverse.

#### Details

- **Dial:** Rotation progressively adjusts replay speed (clockwise = increase, counter-clockwise = decrease)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Set Speed

Set replay playback to a specific speed selected in the Property Inspector.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Speed

The target replay speed. 31 options ranging from `1/16x` slow motion through `1x` up to `16x` fast-forward. Defaults to `1x`.

---

### Speed Display

Read-only display of the current replay speed. Pressing the button does nothing — this is a display-only mode.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — the icon shows the live replay speed pulled from telemetry

#### Settings

- No additional settings

---

### Next Session

Jump to the next session in the replay.

#### Details

- **Dial:** Rotation cycles sessions (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Session

Jump to the previous session in the replay.

#### Details

- **Dial:** Rotation cycles sessions (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Lap

Jump forward one lap.

#### Details

- **Dial:** Rotation cycles laps (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Lap

Jump backward one lap.

#### Details

- **Dial:** Rotation cycles laps (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Incident

Jump to the next incident.

#### Details

- **Dial:** Rotation cycles incidents (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Incident

Jump to the previous incident.

#### Details

- **Dial:** Rotation cycles incidents (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to Beginning

Jump to the start of the replay.

#### Details

- **Dial:** Rotation cycles incidents (clockwise = next incident, counter-clockwise = previous incident)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to Live

Jump to the live point in the session (end of the replay buffer).

#### Details

- **Dial:** Rotation cycles incidents (clockwise = next incident, counter-clockwise = previous incident)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Jump to My Car

Jump the replay camera to your own car.

#### Details

- **Dial:** Rotation cycles to the next / previous car on track around your position (clockwise = ahead, counter-clockwise = behind)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Car

Switch the replay camera to the next car. Defers to iRacing's own car-ordering by sending the configured keystroke, so cycling stays correct in live and replay (including replay-while-towed, where telemetry-driven selection picks the wrong driver).

#### Details

- **Dial:** Clockwise sends Next Car, counter-clockwise sends Previous Car
- **Default binding:** `V`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Car

Switch the replay camera to the previous car. Defers to iRacing's own car-ordering by sending the configured keystroke, so cycling stays correct in live and replay (including replay-while-towed).

#### Details

- **Dial:** Clockwise sends Next Car, counter-clockwise sends Previous Car
- **Default binding:** `Shift+V`
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Car (Number Order)

Switch the replay camera to the next car by car number order. Includes all cars — even those in the pits — and skips the pace car.

#### Details

- **Dial:** Rotation cycles cars by number order (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Car (Number Order)

Switch the replay camera to the previous car by car number order. Includes all cars — even those in the pits — and skips the pace car.

#### Details

- **Dial:** Rotation cycles cars by number order (clockwise = next, counter-clockwise = previous)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
