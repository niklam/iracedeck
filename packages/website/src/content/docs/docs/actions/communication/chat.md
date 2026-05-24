---
title: Chat
description: Send chat messages, macros, replies, whispers, and manage the chat window.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Send chat messages and interact with iRacing's chat system. Includes sending custom messages, triggering built-in chat macros, replying to messages, whispering a specific driver, toggling the chat window, and managing the chat window.

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

#### Timing

Sending a message opens the chat window, pastes the text, presses Enter, then closes the chat window. Three waits in that pipeline are configurable under **Common Settings → Chat** (all default 200 ms):

- **Open → Paste delay** — wait after opening the chat window before pasting. Too short and the paste can land before iRacing has focused the chat input, dropping the text. (This delay is shared with Race Admin's "Type in Chat".)
- **Paste → Enter delay** — wait after pasting before pressing Enter. Too short and Enter can fire before the paste registers, sending an empty or partial message.
- **Enter → Close delay** — wait after pressing Enter before closing the chat window. Too short and the close can fire before iRacing has processed the message, leaving the chat window with focus after sending.

The Enter keypress is also held briefly so it isn't dropped under load. If messages send empty, partially, or not at all — or the chat window keeps focus after you send — especially on slower machines or when a clipboard-manager app is running — raise these delays.

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

### Whisper

Send a private whisper to a specific driver. Whisper has no SDK command in iRacing, so this mode falls back to a keyboard binding.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding — Whisper has no default iRacing hotkey, so you must configure it in both iRacing and the Property Inspector
- **Telemetry-aware icon:** No

#### Settings

- No additional settings

---

### Toggle Chat On/Off

Show or hide the chat window. iRacing's `Text Chat Toggle` control has no SDK command and ships with no default key, so this mode falls back to a keyboard binding.

#### Details

- **Dial:** No rotation support
- **Default binding:** No default key binding — `Text Chat Toggle` has no default iRacing hotkey, so you must bind a key in iRacing's *Options → Controls → Text Chat Toggle* and the matching key in the Property Inspector
- **Telemetry-aware icon:** No — iRacing does not expose chat-window state via telemetry, so the button cannot reflect whether chat is currently visible

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
