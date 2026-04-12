---
title: Chat
description: Send chat messages, macros, replies, whispers, and manage the chat window.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Send chat messages and interact with iRacing's chat system. Includes sending custom messages, triggering built-in chat macros, replying to messages, whispering a specific driver, and managing the chat window.

:::note
Chat macros correspond to iRacing's built-in macro slots 1 through 15. Configure the macro text inside iRacing's chat macro settings.
:::

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Send Custom Message

Send a user-defined chat message. Supports [template variables](/docs/features/template-variables/) — for example, `Going {{Speed}} mph` resolves the current speed at send time. Multiline input is supported in the Property Inspector for easier editing, but newlines collapse into spaces when the message is sent (iRacing chat is single-line).

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** Yes — when the button text or message template references live variables (e.g., `{{Speed}}`), the button re-renders whenever those variables change

#### Setting: Message Text

The text to send. Accepts template variables. Defaults to empty — configure before using this mode.

#### Setting: Font Size

Font size (5–36 px) used to render Message Text on the button. Defaults to `11`. Only affects the on-button rendering, not the sent message length.

---

### Chat Macro

Send one of iRacing's 15 built-in chat macros.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Setting: Macro Number

Which macro slot to fire (1–15). Defaults to `1`. The macro's text is defined inside iRacing, not in the Property Inspector.

#### Setting: Font Size

Font size (5–36 px) used on the button. Defaults to `11`. For macro mode, this only applies when a custom **Key Text** is set — the default "Macro + number" layout uses fixed font sizes.

---

### Reply

Reply to the most recent chat message using iRacing's reply command.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Respond to Last PM

Respond to the most recent private message received.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Whisper

Send a private whisper to a specific driver. Whisper has no SDK command in iRacing, so this mode falls back to a keyboard binding.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding — Whisper has no default iRacing hotkey, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Open Chat

Open the chat input window without sending anything.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Cancel

Cancel or close the chat window.

#### Details

- **Dial:** No rotation support
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

## Shared settings

In addition to the mode-specific settings above, two Property Inspector settings apply to every Chat mode.

### Setting: Icon Color

The background color used for the chat button icon. Defaults to `#4a90d9` (blue).

### Setting: Key Text

Custom text displayed on the Stream Deck button, replacing the default icon labels. Supports two lines (use a line break to split) and [template variables](/docs/features/template-variables/) for live-updating button text.
