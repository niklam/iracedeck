---
title: Chat
description: Send chat messages, macros, replies, whispers, and manage the chat window in iRacing.
sidebar:
  badge:
    text: "7 modes"
    variant: tip
---

Send chat messages and interact with the iRacing chat system. Includes sending custom messages, triggering built-in chat macros, replying to messages, whispering to drivers, and managing the chat window.

## Modes

| Mode | Description |
|------|-------------|
| Send Custom Message | Send a user-defined chat message (supports [template variables](/docs/features/template-variables/)) |
| Chat Macro | Send one of iRacing's 15 built-in chat macros (select slot 1–15) |
| Reply | Reply to the last chat message |
| Respond to Last PM | Respond to the last private message |
| Whisper | Send a private message to a specific driver |
| Open Chat | Open the chat window |
| Cancel | Cancel or close the chat window |

:::note
Chat macros correspond to iRacing's built-in macro slots 1 through 15. Configure the macro text within iRacing's chat macro settings.
:::

## Settings

| Setting | Type | Default | Applies to |
|---------|------|---------|------------|
| Mode | Dropdown | Send Message | All |
| Message Text | Text area | *(empty)* | Send Message |
| Macro Number | Dropdown (1–15) | 1 | Macro |
| Icon Color | Color picker | `#4a90d9` | All |
| Key Text | Text area | *(empty, uses default labels)* | All |
| Font Size | Number (5–36) | 11 | Send Message, Macro |

### Message Text

The message to send when using **Send Message** mode. Supports [template variables](/docs/features/template-variables/) — for example, `Going {{Speed}} mph` will resolve the current speed at send time. Multiline input is supported for easier editing, but newlines are collapsed into spaces when the message is sent (iRacing chat is single-line).

### Key Text

Custom text displayed on the Stream Deck button. When set, it replaces the default icon labels. Supports [template variables](/docs/features/template-variables/) for live-updating button text. Supports two lines — use a line break to split.

### Font Size

Controls the text size (5–36px) rendered on the button for **Send Message** and **Macro** modes. For **Macro** mode, the font size only applies when custom Key Text is set; the default "Macro + number" layout uses fixed font sizes.

## Encoder Support

Yes — press the dial to trigger the configured chat action. Dial rotation is not used.

## Keyboard Bindings

The **Whisper** mode uses a configurable keyboard shortcut (global setting shared across all Chat action instances). All other modes use iRacing SDK commands and do not require keyboard bindings.
