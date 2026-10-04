---
title: Replay Markers
description: Mark a moment while you drive or watch, and jump back to it in the replay.
sidebar:
  badge:
    text: "4 modes"
    variant: tip
---

Replay Markers lets you bookmark moments of a session and come back to them in the replay. Press **Add Marker** from the car the moment something happens — a close call, a pass, a mistake you want to review — and later, in the replay, press **Previous Marker** or **Next Marker** to jump straight there. Adding and deleting work the same while driving and while watching a replay, including the replay of the session you are in right now; the jumps work in the replay only, because iRacing accepts replay commands only when you are out of the car.

A marker is a position in iRacing's replay recording. Jumping to one is a single iRacing replay command, so it is instant and needs no key binding.

On a Stream Deck+ dial or a Mirabox knob, Replay Markers becomes a marker dial: turn it to step through the markers and press it to add one — see [On a dial](#on-a-dial).

## Where markers are kept

iRaceDeck saves each session's markers to its own file, so they are still there when you open the saved replay days later:

```text
%LOCALAPPDATA%\iRaceDeck\Replay\<ecosystem>\session_<SubSessionID>.json
```

`<ecosystem>` is `Stream Deck`, `Mirabox` or `Ulanzi`, depending on which app runs the plugin, and `<SubSessionID>` is iRacing's id for the session. A saved replay file reports the same id as the live session it was recorded from, which is how its markers are found again. Each file names the track, series and session start, so you can tell the files apart when browsing the folder.

Each deck app keeps its own file, so markers set from one app are not seen by another: a marker added from the Stream Deck app does not show up in Ulanzi Studio, and the other way round. That is deliberate — with two deck apps running at the same time, a shared file would have each overwrite the other's markers.

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

Removes the marker nearest the current moment, if there is one within 10 seconds of it — or within 10 seconds of where you pressed **Add Marker** for it. From the car that reaches a marker you added moments ago, however far back it was set; in a replay it reaches the marker you just jumped to while its moment is playing. There is no confirmation step — the 10-second window already limits what a press can reach.

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

Jumps the replay to the next marker after the current moment. A marker less than one second ahead is skipped, so pressing again moves on to the one after instead of landing on the marker you just reached. With no marker ahead, nothing happens. It works in the replay: from the car, open the replay first.

The key turns grey whenever a press would do nothing — no marker ahead, not in a replay, or iRacing not running — and comes back as the replay plays or a marker is added. The grey look keeps your colour and title overrides, only faded.

#### Details

- **Method:** iRacing API
- **Dial:** Turning the dial clockwise jumps to the next marker — see [On a dial](#on-a-dial) below
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — greyed out while there is no marker to jump to

#### Settings

- No additional settings

---

### Previous Marker

Jumps the replay to the previous marker before the current moment. Pressed within two seconds of reaching a marker, while its moment is still playing, it goes to the marker before that one, the way a media player's previous-track button does, so markers set close together are each reached in turn. With no marker behind, nothing happens. It works in the replay: from the car, open the replay first — iRacing accepts replay commands only when you are out of the car, so a press from the car sends nothing.

Like **Next Marker**, the key turns grey whenever a press would do nothing: no marker behind, not in a replay, or iRacing not running.

#### Details

- **Method:** iRacing API
- **Dial:** Turning the dial counter-clockwise jumps to the previous marker — see [On a dial](#on-a-dial) below
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — greyed out while there is no marker to jump to

#### Settings

- No additional settings

## On a dial

Placed on a Stream Deck+ dial or a Mirabox knob, Replay Markers becomes a marker dial. Turning the dial steps through the session's markers in the replay — clockwise to the next marker, counter-clockwise to the previous one — and a press adds a marker, from the car or in the replay. It needs no key binding. Rotation always steps through the markers, so there is no dial **Mode** dropdown; the Property Inspector automatically shows the dial settings below (instead of the keypad Mode and Seconds Back) when the instance sits on a dial. See [Dials](/docs/features/dials/) for how the shared dial gestures work.

Each detent is one marker. A turn lands on the same marker the **Next Marker** and **Previous Marker** keys would from the same moment: a marker less than one second ahead is skipped, and turning back within two seconds of reaching a marker goes to the one before it. A fast spin walks as many markers as the dial reports detents, with no limit, and stops at the first or last marker rather than wrapping around to the other end of the list. However fast you spin, the replay gets a single jump, to the last marker reached, and a quick second turn carries on from the marker you just jumped to even before the replay has caught up there. Turning the dial also stops a running [Jump to Fastest Lap](/docs/actions/view-camera/replay-control/#jump-to-fastest-lap) search, so your jump stands.

Turning only works in the replay. iRacing accepts replay commands only when you are out of the car, so from the car a turn sends nothing — open the replay first. With no marker in the direction you turn, nothing happens either.

#### Details

- **Method:** iRacing API for the jumps; Add Marker and Delete Marker are stored by iRaceDeck — no iRacing command
- **Dial:** Rotating jumps to the next marker (clockwise) or the previous marker (counter-clockwise), one marker per detent with no cap on a fast spin, stopping at the ends of the list; works in the replay only
- **Default binding:** No keyboard binding
- **Telemetry-aware:** Yes — the display shows the marker count, which marker is playing, and which way a turn can jump

#### Controls

- **Elgato Stream Deck+** — dial rotation, a press (short or long), and a touchscreen that shows the marker count. Pushing and turning at the same time steps through the markers like a plain turn, and the release then fires nothing. A touchscreen tap or long tap runs its own configured Tap Display / Long Touch action.
- **Mirabox knob** — turn and push, with the same display drawn on the screen above the knob; the Push slot only, so to delete markers from a knob set **Press Action** to **Delete Marker** (see [Dials](/docs/features/dials/#mirabox-knobs)).

#### Touch strip

The touch strip (and the screen above a Mirabox knob) shows a "dash box" labelled `MARKERS`:

- **`k / N`** — in the replay, while the moment of marker *k* of *N* is playing: at the marker or up to two seconds past it.
- **`N`** — the number of markers in the session, anywhere else.
- **`NONE`** — the session has no markers yet.
- **Arrows** — the left and right arrows beside the label light up when a counter-clockwise or clockwise turn would jump, and stay dimmed when it would do nothing. From the car both stay dimmed, because no turn can jump from there.
- **Caption** — from the car, when **Press Action** is **Add Marker**, a small line under the count reads `ADD −5 s` (with your **Seconds Back**), so you can see what a press will do while driving.

After a press, the value briefly shows `ADDED k / N` or `DELETED` for one second; a press that adds or deletes nothing shows nothing. The whole box dims while iRacing is not running or reports no replay position. You can override the border, label, value, and background colors in the **Dash Box Appearance** section of the dial settings.

#### Setting: Seconds Back

How many seconds before the current moment a marker added from the dial is placed. Defaults to **5**, range **0–60** whole seconds — the dial's own value, separate from any key's. From the car the current moment is the live end of the recording; in a replay it is the frame on screen.

#### Setting: Press Action / Long Press

What a short or long press of the dial button does, chosen from:

- **Add Marker** (default for **Press Action**) — adds a marker **Seconds Back** before the current moment, exactly like the [Add Marker](#add-marker) key. It works from the car as well as in the replay, which is why it is the press default.
- **Delete Marker** (default for **Long Press**) — removes the marker within 10 seconds of the current moment, exactly like the [Delete Marker](#delete-marker) key.
- **None** — does nothing.

A press is classified when you release the dial — a hold past the [Long-press threshold](/docs/features/dials/#the-long-press-threshold) fires the Long Press action. Hold past the threshold and the strip previews what letting go will do: `DELETE k / N` for the marker that would go, or `ADD −5 s` when Long Press is set to Add Marker. When the release would do nothing — no marker within reach, a marker that would duplicate one already there, or no data from iRacing — the strip stays as it is. See [Seeing the outcome before you let go](/docs/features/dials/#seeing-the-outcome-before-you-let-go). Long Press is Stream Deck+ only.

#### Setting: Tap Display / Long Touch

Optional touch-strip gestures (Stream Deck+ only), each over { Add Marker, Delete Marker, None }. Both default to **None** for VR safety.
