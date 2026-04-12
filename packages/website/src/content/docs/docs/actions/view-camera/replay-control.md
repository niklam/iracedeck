---
title: Replay Control
description: Full replay transport, speed, and navigation in a single configurable action.
sidebar:
  badge:
    text: "25 modes"
    variant: tip
---

Complete command over iRacing's replay system. Playback transport, progressive speed control, and session / lap / incident / car navigation are all available as selectable modes on a single action. Every mode uses the iRacing SDK replay and camera commands — no keyboard bindings.

:::note
Replay Control replaces the legacy Replay Transport, Replay Speed, and Replay Navigation actions. Existing button configurations using those actions continue to work.
:::

Fast Forward, Rewind, Frame Forward, Frame Backward, Increase Speed, and Decrease Speed support long-press: hold the button to repeat the command automatically after an initial 500 ms delay, then every 250 ms.

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

Progressive fast-forward. Each press steps the forward speed up by one (2x → 3x → 4x → ... → 16x) up to the iRacing maximum.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Rewind

Progressive rewind. Each press steps the reverse speed up by one (−2x → −3x → −4x → ... → −16x) up to the iRacing maximum.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Slow Motion

Quick shortcut to 1/2x slow motion.

#### Details

- **Dial:** Rotation steps playback forward or backward by one frame
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

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

Switch the replay camera to the next car ahead on track. Skips cars currently on pit road.

#### Details

- **Dial:** Rotation cycles cars on track (clockwise = next ahead, counter-clockwise = previous behind)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Car

Switch the replay camera to the next car behind on track. Skips cars currently on pit road.

#### Details

- **Dial:** Rotation cycles cars on track (clockwise = next ahead, counter-clockwise = previous behind)
- **Default binding:** No keyboard binding
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
