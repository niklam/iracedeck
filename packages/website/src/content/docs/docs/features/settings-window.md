---
title: Settings Window
description: One full-size window for every plugin-wide setting — key bindings, appearance, the Race Engineer, profiles, and more — instead of hunting through Property Inspectors.
---

Every iRaceDeck key has its own settings in the deck software's Property Inspector, but many settings apply to the **whole plugin**: your key bindings, the appearance defaults every key inherits, the Race Engineer's voice and callouts, timing tunables, SimHub, and so on. Those used to live only inside each Property Inspector too — repeated in every one, in a narrow panel. The **Settings window** gives them a proper home.

## Opening It

In any iRaceDeck action's Property Inspector, scroll to **Global Settings** and click **Open iRaceDeck Settings**. The window opens on top of the deck software.

It is a real window — its own entry in the taskbar, resizable, and it remembers its size and position for next time. It closes itself when the deck software shuts down or restarts.

## What's Inside

The sidebar has one tab per area:

- **General** — Focus iRacing window before sending keys, disable buttons when iRacing isn't connected, and the dual-press behaviour.
- **Key Bindings** — every binding for every action in one searchable table (search by action or category, or filter to one category). Each row saves as you change it, exactly like the Property Inspector's _Related Key Bindings_.
- **Appearance** — the plugin-wide title, colour, border, graphic-scale, and flag-flash defaults. Any key can still override these individually in its own Property Inspector.
- **Race Engineer** — voice, driver name, output device, volumes and their Test buttons, the radar, every per-callout opt-in, and the setup-warning patterns. The same settings the Pit Crew action's Property Inspector shows.
- **Profiles** _(Stream Deck only)_ — install or switch to a bundled iRaceDeck profile. Because the window isn't tied to one deck, pick which Stream Deck to switch first; with a single deck connected it's pre-selected.
- **Delays** — the chat and replay timing tunables.
- **SimHub** — the Control Mapper host and port.
- **What's New** — when the [What's New page](/docs/features/whats-new-page/) opens after an update, and the changelog itself.
- **Diagnostics** — debug logging, and where your settings file is stored.

Settings changed in the window and settings changed in a Property Inspector are the same settings: change something in one and the other updates live.

## Where Your Settings Are Stored

iRaceDeck keeps every setting on this page — and the same settings shown in each key's Property Inspector — in a file of its own, in your user profile, rather than in the deck software's storage:

| Deck software | Settings file                                                        |
| ------------- | -------------------------------------------------------------------- |
| Stream Deck   | `%LOCALAPPDATA%\iRaceDeck\Settings\Stream Deck\global-settings.json` |
| Mirabox       | `%LOCALAPPDATA%\iRaceDeck\Settings\Mirabox\global-settings.json`     |
| Ulanzi Deck   | `%LOCALAPPDATA%\iRaceDeck\Settings\Ulanzi\global-settings.json`      |

The **Diagnostics** tab shows the exact path for your installation and has an **Open folder** button that reveals the file in Explorer.

The first time you start a version that stores settings this way, iRaceDeck copies your existing settings over from the deck software automatically — there is nothing to do. From then on your settings live with you rather than inside the deck software's own storage, so they survive plugin updates and reinstalls. The window and the Property Inspectors share that one file, which is why a change in either shows up in the other straight away on Stream Deck and Mirabox; on Ulanzi Deck the Property Inspector side of that live sync is pending confirmation that UlanziStudio's in-session settings read works, so until then a Property Inspector there falls back to the deck software's own copy — it still displays fine, but a plugin-wide setting changed in it does not reach the plugin; use the Settings window for those on Ulanzi Deck. The deck software keeps a copy too: iRaceDeck refreshes it once every time the plugin starts, so nothing is taken away from it and an older iRaceDeck version installed later still finds your settings where it expects them. The one exception is a start on which the deck software has not yet answered iRaceDeck's first read of your existing settings — that refresh waits until it does, so a copy iRaceDeck has not seen is never overwritten.

To back up your configuration, copy that one file somewhere safe; to restore it, put it back and restart the deck software. Each deck ecosystem gets its own folder, so a Stream Deck and an Ulanzi Deck installation on the same PC never share settings.

## How It Works

The plugin serves the window itself, on your own machine only (`127.0.0.1`), and opens it as a **chromeless app window** in Microsoft Edge or Google Chrome — whichever is installed — so it looks and behaves like a program window rather than a browser tab. If neither browser is found, it opens in your default browser as a normal tab instead; everything works the same, it just has a tab bar.

The window runs in its own private browser profile, separate from your everyday browsing, so nothing about it — cookies, extensions, sign-ins — is shared with your normal browser.

## Security

Because the window is a local web page, the plugin only answers requests carrying a secret it issued itself: it generates a fresh token when it starts serving (once per plugin run) and hands it to the window it opens and to iRaceDeck's own Property Inspectors so they can reach the plugin. Anything without it is refused, and nothing is reachable from outside your PC. Every setting written from the window goes through the plugin, the same way it would if a Property Inspector had written it — so the window can never store anything the plugin itself wouldn't.
