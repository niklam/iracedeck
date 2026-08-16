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
- **Diagnostics** — debug logging.

Settings changed in the window and settings changed in a Property Inspector are the same settings: change something in one and the other updates live.

## How It Works

The plugin serves the window itself, on your own machine only (`127.0.0.1`), and opens it as a **chromeless app window** in Microsoft Edge or Google Chrome — whichever is installed — so it looks and behaves like a program window rather than a browser tab. If neither browser is found, it opens in your default browser as a normal tab instead; everything works the same, it just has a tab bar.

The window runs in its own private browser profile, separate from your everyday browsing, so nothing about it — cookies, extensions, sign-ins — is shared with your normal browser.

## Security

Because the window is a local web page, the plugin only serves it to the window it just opened: each launch uses a fresh secret token, requests from any other website are refused, and nothing is reachable from outside your PC. Every setting written from the window goes through the plugin, the same way it would if a Property Inspector had written it — so the window can never store anything the plugin itself wouldn't.
