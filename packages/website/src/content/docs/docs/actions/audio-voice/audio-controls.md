---
title: Audio Controls
description: Adjust voice chat and master volume in iRacing, and hold push-to-talk.
sidebar:
  badge:
    text: "3 modes"
    variant: tip
---

Quick access to iRacing's audio settings: hold push-to-talk, raise / lower / mute voice chat volume, or raise / lower the master volume — all without navigating menus.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector. Voice Chat and Master modes also expose an **Action** setting for Volume Up / Volume Down (and Mute for Voice Chat).

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
