---
title: Audio Controls
description: Adjust iRacing voice chat and master volume, hold push-to-talk, and adjust iRaceDeck's own Race Engineer and Radar volume.
sidebar:
  badge:
    text: "5 modes"
    variant: tip
---

Quick access to audio levels: hold push-to-talk, raise / lower / mute iRacing voice chat volume, raise / lower the iRacing master volume, and adjust iRaceDeck's own **Race Engineer** voice and **Radar** tick levels — all without navigating menus.

The Mode dropdown is split into two groups:

- **iRacing audio** — Push to Talk, Voice Chat, Master. These send key presses to iRacing, so they follow your configured key bindings.
- **iRaceDeck audio** — Race Engineer Volume, Radar Volume. These adjust iRaceDeck's own audio buses directly, so they need no iRacing key binding. (These mirror the volume sliders in the Pit Crew settings.)

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Voice Chat and Master modes also expose an **Action** setting for Volume Up / Volume Down (and Mute for Voice Chat). Race Engineer Volume and Radar Volume expose an **Action** setting for Volume Up / Volume Down.

### Push to Talk

Hold voice chat push-to-talk for as long as the button is pressed. Release the button to stop transmitting. Works the same on a key and on a dial — pressing the dial holds, releasing the dial stops transmitting.

#### Details

- **Dial:** No rotation support; press and hold the dial to transmit, release to stop
- **Default binding:** No default key binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Voice Chat

Control voice chat volume and mute.

#### Details

- **Dial:** Rotation adjusts voice chat volume (clockwise = up, counter-clockwise = down) regardless of the Action setting; pressing the dial **always** toggles mute, even if the Action setting is Volume Up or Volume Down
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

- **Dial:** Rotation adjusts master volume (clockwise = up, counter-clockwise = down) regardless of the Action setting; pressing the dial triggers the configured action
- **Default binding:** Depends on the selected action — see the **Action** setting below
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default, default key `Shift+Alt+numpad_add`) — Pressing the button raises master volume
- **Volume Down** (default key `Shift+Alt+numpad_subtract`) — Pressing the button lowers master volume

---

### Race Engineer Volume

Adjust iRaceDeck's own **Race Engineer voice** level — the same level as the Race Engineer Volume slider in the Pit Crew settings. This controls iRaceDeck audio, not iRacing, so it needs no iRacing key binding. While the Race Engineer is disabled the level still updates, but you won't hear it until the Race Engineer is enabled.

#### Details

- **Dial:** Not supported yet — only key presses adjust the volume
- **Default binding:** None — controls iRaceDeck audio directly (no iRacing key binding)
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default) — Pressing the button raises the Race Engineer voice volume by 5% (max 100%)
- **Volume Down** — Pressing the button lowers the Race Engineer voice volume by 5% (min 0%)

---

### Radar Volume

Adjust iRaceDeck's own proximity **Radar** tick level — the same level as the Radar Volume slider in the Pit Crew settings. This controls iRaceDeck audio, not iRacing, so it needs no iRacing key binding. (This replaces the Radar Volume mode that previously lived in the Pit Crew action.)

#### Details

- **Dial:** Not supported yet — only key presses adjust the volume
- **Default binding:** None — controls iRaceDeck audio directly (no iRacing key binding)
- **Telemetry-aware icon:** No

#### Setting: Action

- **Volume Up** (default) — Pressing the button raises the Radar volume by 5% (max 100%)
- **Volume Down** — Pressing the button lowers the Radar volume by 5% (min 0%)
