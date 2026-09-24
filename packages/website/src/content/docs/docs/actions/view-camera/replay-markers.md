---
title: Replay Markers
description: Mark a moment while you drive or watch, and jump back to it in the replay.
sidebar:
  badge:
    text: "4 modes"
    variant: tip
---

Replay Markers lets you bookmark moments of a session and come back to them in the replay. Press **Add Marker** from the car the moment something happens — a close call, a pass, a mistake you want to review — and later press **Previous Marker** or **Next Marker** to jump the replay straight there. Markers work the same while driving and while watching a replay, including the replay of the session you are in right now.

A marker is a position in iRacing's replay recording. Jumping to one is a single iRacing replay command, so it is instant and needs no key binding.

## Where markers are kept

iRaceDeck saves each session's markers to its own file, so they are still there when you open the saved replay days later:

```text
%LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>\session_<SubSessionID>.json
```

`<ecosystem>` is `Stream Deck`, `Mirabox` or `Ulanzi`, depending on which app runs the plugin, and `<SubSessionID>` is iRacing's id for the session. A saved replay file reports the same id as the live session it was recorded from, which is how its markers are found again. Each file names the track, series and session start, so you can tell the files apart when browsing the folder.

A marker set live lands about one second earlier than its moment when you watch the saved replay file. That is deliberate: every jump arrives a little before the moment, never after it.

:::note
Offline sessions (test drives and AI races) have no session id, so their markers are kept in memory only. They work for that session and its in-session replay, but they are gone once you leave the session, and no file is written.
:::

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Add Marker

Adds a marker a few seconds before the current moment — by default 5 seconds back, so pressing it right after something happens still catches the lead-up. From the car the current moment is the live end of the recording; in a replay it is the frame on screen.

A marker within one second of an existing one is not added twice. When a marker is added, the key briefly shows **MARKER ADDED**; a press that adds nothing shows nothing.

#### Details

- **Method:** Stored by iRaceDeck — no iRacing command
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Seconds Back

How many seconds before the current moment the marker is placed. Defaults to **5**, range **0–60** whole seconds. The marker never goes before the start of the recording.

:::tip
The setting is per key, so one deck can carry both kinds: a key with a longer value (say 15 seconds) for marking a moment you just survived in a race, and a key set to 0 for marking exactly the frame on screen while reviewing a replay.
:::

---

### Delete Marker

Removes the marker nearest the current moment, if there is one within 10 seconds of it. From the car that reaches a marker you added moments ago; in a replay it reaches the marker you just jumped to while its moment is playing. There is no confirmation step — the 10-second window already limits what a press can reach.

When a marker is deleted, the key briefly shows **MARKER DELETED**; a press with no marker in reach shows nothing.

#### Details

- **Method:** Stored by iRaceDeck — no iRacing command
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Next Marker

Jumps the replay to the next marker after the current moment. A marker less than one second ahead is skipped, so pressing again moves on to the one after instead of landing on the marker you just reached. With no marker ahead, nothing happens — which is always the case from the car, since the live moment is the end of the recording.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Previous Marker

Jumps the replay to the previous marker before the current moment. A marker less than two seconds behind is skipped, so pressing it while a marker's moment is still playing goes to the one before, the way a media player's previous-track button does. Pressed from the car, it opens the replay at your most recent marker — the quickest way to review what just happened. With no marker behind, nothing happens.

#### Details

- **Method:** iRacing API
- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings
