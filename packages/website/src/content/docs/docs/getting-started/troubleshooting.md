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

Then restart the one you changed. The warning clears automatically once the levels match. The check is made fresh each time iRaceDeck connects to iRacing and is never carried over from a previous session, so the banner is always about the run you are in — and it stays away until iRacing is running again, since there is nothing to compare against until then.

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

If you hit this, increase the three delays in the [Settings window](/docs/getting-started/settings/#delays), on the **Delays** tab under **Chat**:

- **Open → Paste delay** (default 200 ms) — the wait after opening chat before pasting.
- **Paste → Enter delay** (default 200 ms) — the wait after pasting before pressing Enter.
- **Enter → Close delay** (default 200 ms) — the wait after pressing Enter before closing the chat window. Raise this if the chat window keeps focus after you send.

All accept 0–2000 ms. The Enter keypress is also held briefly so it registers reliably. Changes take effect immediately — no restart needed.

## Capturing logs for support

iRaceDeck logs at the **info** level by default, which keeps the log file focused on the events that matter and avoids bloating it with internal detail. When you're troubleshooting a problem — or a maintainer asks for a log — enable verbose debug logging to capture the detail needed to diagnose it:

1. Open the [Settings window](/docs/getting-started/settings/#diagnostics) (**iRaceDeck Settings**, directly under any action's own settings) and pick the **Diagnostics** tab.
2. Turn on **Enable debug logging**. It takes effect immediately — no restart needed.
3. Reproduce the issue, then attach the plugin's log file to your report.
4. Turn the setting back off afterward to keep your logs clean.

Where the log file lives:

- **Stream Deck (Elgato)**: in the plugin's `logs` folder under `%APPDATA%\Elgato\StreamDeck\Plugins\com.iracedeck.sd.core.sdPlugin\`.
- **Stream Dock (Mirabox)**: in the plugin's `log` folder under `%APPDATA%\HotSpot\StreamDock\plugins\com.iracedeck.sd.core.sdPlugin\`, named by date (e.g. `2026.5.31.log`).
- **Ulanzi Deck (UlanziStudio)**: in the plugin's `log` folder under `%APPDATA%\Ulanzi\UlanziDeck\Plugins\com.ulanzi.iracedeck.ulanziPlugin\`, named by date (e.g. `2026.5.31.log`).

When the problem is something iRaceDeck said, showed or did wrong while you were driving, a telemetry snapshot taken at that moment helps as much as the log: it records what iRacing was reporting and what iRaceDeck had made of it.

1. Add a [Telemetry Control](/docs/actions/cockpit/telemetry-control/#take-snapshot) key and set its **Mode** dropdown to **Take Snapshot**.
2. Press it the moment the problem happens. The key itself shows nothing; each press writes two files to the key's Output Folder (by default `iRaceDeck\telemetry-snapshots` in your user home folder).
3. Attach both files (`.json` and `.md`) to your report, together with the plugin log.

Before you send them, read **Before you share a snapshot** in the [Take Snapshot](/docs/actions/cockpit/telemetry-control/#take-snapshot) section, which says what the files contain.

## If iRaceDeck uses a lot of CPU

iRaceDeck keeps an eye on its own CPU use. It checks once a minute, and when three checks in a row find it busy — using half of one CPU core or more, or spending half the time or more working rather than waiting for something to do — the plugin log gets a warning with the figures, such as `Plugin CPU use is high: 62.4% of one core, event loop 71.0% busy, over 3 min (rss 340 MB, heap 64/172 MB)`, and a note once it is back to normal. You don't need debug logging on for these lines, so a log you already have may show when it started.

To show us what is using the CPU:

1. While the problem is happening, open the [Settings window](/docs/getting-started/settings/#diagnostics) and pick the **Diagnostics** tab.
2. Press **Capture CPU profile** and keep iRacing and your deck running as you were. The capture takes 30 seconds.
3. When the line under the button shows the saved file's name, press **Open folder** and attach both new files (`.cpuprofile` and `.txt`) to your report, together with the plugin log.

The capture only records iRaceDeck itself, never iRacing or anything else on your PC, and nothing is sent anywhere: the files stay in the `profiles` folder next to the log until you attach them.

## Need more help?

- **Discord**: [Join the community](https://discord.gg/c6nRYywpah) for real-time support
- **GitHub Issues**: [Open an issue](https://github.com/niklam/iracedeck/issues/new) for bug reports or feature requests
