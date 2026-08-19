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

## Buttons do nothing in iRacing (but the plugin looks connected)

If iRaceDeck appears connected — telemetry-driven features like the Race Engineer still work — but **no button affects iRacing** (black box, camera, pit service, chat all do nothing), the most common cause is an **Administrator mismatch**:

- iRacing is running **as Administrator**, and
- the Stream Deck software (and therefore iRaceDeck) is **not**.

Windows blocks a non-elevated program from sending input or commands to an elevated one, so iRaceDeck's button presses are silently dropped even though it can still read iRacing's telemetry. When iRaceDeck detects this, it shows a ⚠️ warning banner at the top of every action's settings (Property Inspector). The check's result is also written to the plugin log on every connection — a mismatch as a warning, a pass as a confirmation — so a support log shows the outcome without any extra settings.

**Fix:** run both at the same level. Either:

- Run the **Stream Deck software as Administrator** (right-click → Run as administrator), or
- Run **iRacing without Administrator**.

Then restart the one you changed. The warning clears automatically once the levels match.

## Keyboard shortcuts not working

If an action uses keyboard shortcuts (like black box selection), make sure:

1. The key binding in the action's Property Inspector matches your iRacing key configuration
2. iRacing is the focused window when you press the button — [Focus iRacing Window](/docs/features/focus-iracing-window/) handles this for you and is on by default on new installations, but upgrades keep whatever setting you already had
3. You haven't changed the default iRacing key bindings without updating the action settings

## Known issues

### iRaceDeck replaces your clipboard when sending chat messages

Actions that send a chat message to iRacing (fuel service, tire service, chat, race admin, and anything else that uses the in-sim chat) copy the message text to the Windows clipboard and trigger a paste — it's much faster and more reliable than typing the message character by character, which matters during a race.

This means **whatever you had on your clipboard before pressing the button will be replaced** by the last chat message iRaceDeck sent. iRaceDeck does not try to save and restore the previous clipboard content: doing so used to add extra clipboard writes that woke up clipboard-manager apps (Windows clipboard history, Ditto, 1Password, Bitwarden, screenshot tools, etc.) in the narrow window between the copy and the paste, which could steal focus from iRacing and cause chat messages to fail to send or leave the chat window half-open.

If you need to keep something on your clipboard, copy it again **after** using an iRaceDeck chat action.

### Chat messages send empty, partial, or not at all

The chat-send pipeline opens the chat window, pastes the message, presses Enter, then closes the chat window — each step on a short timer. On slower machines, under load, or when a clipboard-manager app briefly steals focus, the default timing can be too tight: the paste lands before the chat input is focused (text lost), Enter fires before the paste registers (empty or partial send), the keypress is dropped entirely, or the window closes before iRacing processes the message and keeps focus afterward.

If you hit this, increase the three delays in the [Settings window](/docs/features/settings-window/#delays), on the **Delays** tab under **Chat**:

- **Open → Paste delay** (default 200 ms) — the wait after opening chat before pasting.
- **Paste → Enter delay** (default 200 ms) — the wait after pasting before pressing Enter.
- **Enter → Close delay** (default 200 ms) — the wait after pressing Enter before closing the chat window. Raise this if the chat window keeps focus after you send.

All accept 0–2000 ms. The Enter keypress is also held briefly so it registers reliably. Changes take effect immediately — no restart needed.

## Capturing logs for support

iRaceDeck logs at the **info** level by default, which keeps the log file focused on the events that matter and avoids bloating it with internal detail. When you're troubleshooting a problem — or a maintainer asks for a log — enable verbose debug logging to capture the detail needed to diagnose it:

1. Open the [Settings window](/docs/features/settings-window/#diagnostics) (**Open iRaceDeck Settings** at the bottom of any action's Property Inspector) and pick the **Diagnostics** tab.
2. Turn on **Enable debug logging**. It takes effect immediately — no restart needed.
3. Reproduce the issue, then attach the plugin's log file to your report.
4. Turn the setting back off afterward to keep your logs clean.

Where the log file lives:

- **Stream Deck (Elgato)**: in the plugin's `logs` folder under `%APPDATA%\Elgato\StreamDeck\Plugins\com.iracedeck.sd.core.sdPlugin\`.
- **Stream Dock (Mirabox)**: in the plugin's `log` folder under `%APPDATA%\HotSpot\StreamDock\plugins\com.iracedeck.sd.core.sdPlugin\`, named by date (e.g. `2026.5.31.log`).
- **Ulanzi Deck (UlanziStudio)**: in the plugin's `log` folder under `%APPDATA%\Ulanzi\UlanziDeck\Plugins\com.ulanzi.iracedeck.ulanziPlugin\`, named by date (e.g. `2026.5.31.log`).

## Need more help?

- **Discord**: [Join the community](https://discord.gg/c6nRYywpah) for real-time support
- **GitHub Issues**: [Open an issue](https://github.com/niklam/iracedeck/issues/new) for bug reports or feature requests
