---
title: Audio Controls
description: Adjust iRacing voice chat and master volume, hold push-to-talk, and adjust iRaceDeck's own Race Engineer and Radar volume.
sidebar:
  badge:
    text: "5 modes"
    variant: tip
---

Quick access to audio levels: hold push-to-talk, raise / lower / mute iRacing voice chat volume, raise / lower the iRacing master volume, and adjust iRaceDeck's own **Race Engineer** voice and **Radar** tick levels — all without navigating menus. Placed on a Stream Deck+ dial or Mirabox knob, it becomes a volume dial: rotate to adjust the selected audio, press to talk or mute — see [On a dial](#on-a-dial).

The Mode dropdown is split into two groups:

- **iRacing audio** — Push to Talk, Voice Chat, Master. These send key presses to iRacing, so they follow your configured key bindings.
- **iRaceDeck audio** — Race Engineer Volume, Radar Volume. These adjust iRaceDeck's own audio buses directly, so they need no iRacing key binding. (These mirror the volume sliders in the Pit Crew settings.)

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Voice Chat and Master modes also expose an **Action** setting for Volume Up / Volume Down (and Mute for Voice Chat). Race Engineer Volume and Radar Volume expose an **Action** setting for Volume Up / Volume Down.

### Push to Talk

Hold voice chat push-to-talk for as long as the button is pressed. Release the button to stop transmitting.

#### Details

- **Method:** Key binding
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Voice Chat

Control voice chat volume and mute.

#### Details

- **Method:** Key binding
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** Depends on the selected action — see the **Action** setting below
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default, default key `Shift+Ctrl+Alt+numpad_add`) — Pressing the button raises voice chat volume
- **Volume Down** (default key `Shift+Ctrl+Alt+numpad_subtract`) — Pressing the button lowers voice chat volume
- **Mute** (default key `Shift+Ctrl+Alt+M`) — Pressing the button toggles voice chat mute

---

### Master

Control the iRacing master volume. The Master mode has no mute option — the Action dropdown only exposes Volume Up and Volume Down.

#### Details

- **Method:** Key binding
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** Depends on the selected action — see the **Action** setting below
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default, default key `Shift+Alt+numpad_add`) — Pressing the button raises master volume
- **Volume Down** (default key `Shift+Alt+numpad_subtract`) — Pressing the button lowers master volume

---

### Race Engineer Volume

Adjust iRaceDeck's own **Race Engineer voice** level — the same level as the Race Engineer Volume slider in the Pit Crew settings. This controls iRaceDeck audio, not iRacing, so it needs no iRacing key binding. While the Race Engineer is disabled the level still updates, but you won't hear it until the Race Engineer is enabled.

#### Details

- **Method:** iRaceDeck audio (no iRacing command)
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** None — controls iRaceDeck audio directly (no iRacing key binding)
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default) — Pressing the button raises the Race Engineer voice volume by 5% (max 100%)
- **Volume Down** — Pressing the button lowers the Race Engineer voice volume by 5% (min 0%)

---

### Radar Volume

Adjust iRaceDeck's own proximity **Radar** tick level — the same level as the Radar Volume slider in the Pit Crew settings. This controls iRaceDeck audio, not iRacing, so it needs no iRacing key binding. (This replaces the Radar Volume mode that previously lived in the Pit Crew action.)

#### Details

- **Method:** iRaceDeck audio (no iRacing command)
- **Dial:** See [On a dial](#on-a-dial)
- **Default binding:** None — controls iRaceDeck audio directly (no iRacing key binding)
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default) — Pressing the button raises the Radar volume by 5% (max 100%)
- **Volume Down** — Pressing the button lowers the Radar volume by 5% (min 0%)

---

## On a dial

Placed on a Stream Deck+ dial (or a Mirabox knob), Audio Controls becomes a volume dial: rotating adjusts the selected audio category, and the press is configurable as **Push to Talk** or **Mute / Unmute**. The Property Inspector automatically shows the dial settings below (instead of the keypad Mode settings) when the instance sits on a dial.

Rotate the dial to adjust the volume of the category selected in the **Volume** setting. For **Voice Chat** and **Master**, each detent taps the matching iRacing volume key binding — iRacing steps its volume a fixed amount per press, and it exposes no current volume state, so the touch strip shows the category name only (there is no level to display; this is an iRacing limitation, not a missing feature). For **Race Engineer** and **Radar**, each detent steps iRaceDeck's own level by 5% — and because these levels are iRaceDeck's, the touch strip shows a **live level bar** with the current value, updating immediately when the level changes anywhere (the dial itself, the keypad buttons, the Pit Crew sliders). When the Race Engineer or Radar feature is disabled, the bar dims and reads **OFF**.

While **Push to Talk** is held, the strip's top band turns red and reads **ON AIR** — transmit state is plugin-owned, so it can always be shown. If a key binding the dial needs is not configured, the strip dims and shows the standard warning triangle.

#### Details

- **Method:** Key binding for Voice Chat / Master rotation (both volume keys required), Push to Talk, and Voice Chat Mute / Unmute; iRaceDeck audio (no iRacing command) for Race Engineer / Radar rotation and their Mute / Unmute
- **Dial:** Rotation adjusts the selected category's volume, scaled by detents; press runs the configured Press Action
- **Default binding:** The shared Audio Controls bindings (`audioVoiceChatVolumeUp` / `Down`, `audioMasterVolumeUp` / `Down`, `audioControlsPushToTalk`, `audioVoiceChatMute`); none for Race Engineer / Radar
- **Telemetry-aware icon:** The touch strip shows the live Race Engineer / Radar level (iRaceDeck state, not telemetry); no level display is possible for the iRacing categories

#### Controls

- **Elgato Stream Deck+** — dial rotation, press, and the touchscreen level display.
- **Mirabox** — knob rotation and press. There is no touchscreen, so there is no level display; rotate and press work the same.

#### Setting: Volume

Which audio the rotation adjusts. Defaults to **Voice Chat**.

- **Voice Chat** (default) — Each detent taps the iRacing voice chat volume up / down binding
- **Master** — Each detent taps the iRacing master volume up / down binding
- **Race Engineer** — Each detent steps iRaceDeck's Race Engineer voice level by 5% (live bar on the touch strip)
- **Radar** — Each detent steps iRaceDeck's Radar tick level by 5% (live bar on the touch strip)

#### Setting: Press Action

What a dial press does. Defaults to **None**.

- **Push to Talk** — Holds the push-to-talk binding while the dial is pressed; release to stop transmitting. The strip shows **ON AIR** while held.
- **Mute / Unmute** — For **Voice Chat**, taps the voice chat mute binding. For **Race Engineer** / **Radar**, toggles the feature on or off — exactly like the Pit Crew toggle keys (the Race Engineer speaks its going-silent / resuming acknowledgment, and Pit Crew toggle buttons reflect the new state). Not available for **Master** — iRacing has no master-mute key binding.
- **None** (default) — The press does nothing.
