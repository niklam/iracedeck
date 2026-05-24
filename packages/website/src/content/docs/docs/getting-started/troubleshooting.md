---
title: Troubleshooting
description: Common issues and solutions for iRaceDeck.
---

## Installation not working?

If the Elgato Marketplace install doesn't work, try these steps:

1. Make sure you have **Stream Deck software 7.1 or newer** installed
2. Restart the Stream Deck software after installation
3. If the plugin still doesn't appear, try uninstalling and reinstalling from the [Elgato Marketplace](https://marketplace.elgato.com/product/iracedeck-042a0efb-58aa-428c-b1de-8b6169edd21d)

## Buttons show "disabled" or don't respond

iRaceDeck actions require iRacing to be running and connected. When iRacing is not running, buttons may appear disabled or grayed out. Start iRacing and the buttons will activate automatically.

## Keyboard shortcuts not working

If an action uses keyboard shortcuts (like black box selection), make sure:

1. The key binding in the action's Property Inspector matches your iRacing key configuration
2. iRacing is the focused window when you press the button
3. You haven't changed the default iRacing key bindings without updating the action settings

## Known issues

### iRaceDeck replaces your clipboard when sending chat messages

Actions that send a chat message to iRacing (fuel service, tire service, chat, race admin, and anything else that uses the in-sim chat) copy the message text to the Windows clipboard and trigger a paste — it's much faster and more reliable than typing the message character by character, which matters during a race.

This means **whatever you had on your clipboard before pressing the button will be replaced** by the last chat message iRaceDeck sent. iRaceDeck does not try to save and restore the previous clipboard content: doing so used to add extra clipboard writes that woke up clipboard-manager apps (Windows clipboard history, Ditto, 1Password, Bitwarden, screenshot tools, etc.) in the narrow window between the copy and the paste, which could steal focus from iRacing and cause chat messages to fail to send or leave the chat window half-open.

If you need to keep something on your clipboard, copy it again **after** using an iRaceDeck chat action.

### Chat messages send empty, partial, or not at all

The chat-send pipeline opens the chat window, pastes the message, presses Enter, then closes the chat window — each step on a short timer. On slower machines, under load, or when a clipboard-manager app briefly steals focus, the default timing can be too tight: the paste lands before the chat input is focused (text lost), Enter fires before the paste registers (empty or partial send), the keypress is dropped entirely, or the window closes before iRacing processes the message and keeps focus afterward.

If you hit this, increase the three delays under **Common Settings → Chat** in any action's Property Inspector:

- **Open → Paste delay** (default 200 ms) — the wait after opening chat before pasting.
- **Paste → Enter delay** (default 200 ms) — the wait after pasting before pressing Enter.
- **Enter → Close delay** (default 200 ms) — the wait after pressing Enter before closing the chat window. Raise this if the chat window keeps focus after you send.

All accept 0–2000 ms. The Enter keypress is also held briefly so it registers reliably. Changes take effect immediately — no restart needed.

## Need more help?

- **Discord**: [Join the community](https://discord.gg/c6nRYywpah) for real-time support
- **GitHub Issues**: [Open an issue](https://github.com/niklam/iracedeck/issues/new) for bug reports or feature requests
