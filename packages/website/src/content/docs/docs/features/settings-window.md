---
title: Settings Window
description: One full-size window for every plugin-wide setting — key bindings, appearance, the Race Engineer, profiles, and more — instead of hunting through Property Inspectors.
---

Every iRaceDeck key has its own settings in the deck software's Property Inspector, but many settings apply to the **whole plugin**: your key bindings, the appearance defaults every key inherits, the Race Engineer's voice and callouts, timing tunables, SimHub, and so on. Those used to live inside each Property Inspector — repeated in every one, stacked in a narrow panel. The **Settings window** is their home now.

## Opening It

In any iRaceDeck action's Property Inspector, scroll to **Key Bindings** at the bottom and click **Open iRaceDeck Settings**. The window opens on top of the deck software.

It is a real window — its own entry in the taskbar, resizable, and it remembers its size and position for next time. It closes itself when the deck software shuts down or restarts.

## What's Inside

The sidebar has one tab per area:

- **General** — Focus iRacing window before sending keys, disable buttons when iRacing isn't connected, and the dual-press behaviour.
- **Key Bindings** — every binding for every action in one searchable table (search by action or category, or filter to one category). Each row saves as you change it, exactly like the Property Inspector's _Related Key Bindings_.
- **Appearance** — the plugin-wide title, colour, border, graphic-scale, and flag-flash defaults. Any key can still override these individually in its own Property Inspector.
- **Race Engineer** — voice, driver name, output device, volumes and their Test buttons, the radar, every per-callout opt-in, and the setup-warning patterns.
- **Profiles** _(Stream Deck only)_ — install or switch to a bundled iRaceDeck profile. Because the window isn't tied to one deck, pick which Stream Deck to switch first; with a single deck connected it's pre-selected.
- **Delays** — the chat and replay timing tunables.
- **SimHub** — the Control Mapper host and port.
- **What's New** — when the [What's New page](/docs/features/whats-new-page/) opens after an update, and the changelog itself.
- **Diagnostics** — debug logging, and where your settings file is stored.

## What Stays in the Property Inspector

A key's Property Inspector is now about that key. It has its own settings at the top, its per-key overrides — title, colours, border, graphic scale, flags overlay — in the middle, and one section at the bottom:

- **Key Bindings** — the bindings that particular action uses, and nothing else. They are plugin-wide settings, but they are the ones you actually want in front of you while setting a key up, so they stay. The same bindings appear in full on the window's Key Bindings tab.
- **Open iRaceDeck Settings** — the button to everything else.

Actions that use no key bindings at all say so, and just show the button.

Bindings edited in either place are the same settings: on Stream Deck and Mirabox, change one and the other updates live. On Ulanzi Deck that link is still pending confirmation — see [Where Your Settings Are Stored](#where-your-settings-are-stored) — so set bindings from the Settings window there.

## If the Window Doesn't Open

Clicking **Open iRaceDeck Settings** should always produce a window. If it doesn't, iRaceDeck now tells you why: a banner appears at the top of every iRaceDeck Property Inspector describing what failed. There are two, and they mean different things.

**"iRaceDeck could not start its settings service."** The more likely of the two, shown as an error. The window is a page iRaceDeck serves to itself on your own PC, so it needs a local connection — and something on this machine stopped it opening. A firewall or security suite blocking local connections is the usual cause; another program already occupying the port is the other.

This one has a consequence worth knowing about, which is why the banner spells it out: **while it lasts, settings changed in a Property Inspector do not take effect either** — key bindings included. That same local connection is how a Property Inspector reaches the plugin. Without it a panel still opens and still shows your settings, and a change you make there still looks saved, but it never arrives. Take the banner as "iRaceDeck is not accepting settings changes right now" rather than only "the window won't open". What you configured earlier is untouched and your keys keep working normally.

**"iRaceDeck could not open the Settings window."** Shown as a warning, and much less serious. The service is running fine — iRaceDeck simply could not get any browser on the PC to display the page. This one is rare: it means the chromeless app window in Edge or Chrome _and_ the fallback to your default browser both failed. Everything else is unaffected, Property Inspectors included, so settings you change there apply as usual.

To clear either one:

1. **Restart your deck software.** Both conditions are re-checked on every start and on every click of the button, so a banner whose cause has gone disappears on its own — it is a live status, not a dismissible message.
2. **Check your firewall or security software** for a rule blocking iRaceDeck, if it is the first banner.

Each banner also names the full path to your settings file. It is plain text, so you can back it up by copying it, or edit it by hand as a last resort — but **close your deck software first**: while iRaceDeck is running it holds its own copy of your settings and will overwrite hand edits when it next saves.

## Where Your Settings Are Stored

iRaceDeck keeps every setting on this page — and the key bindings shown in each key's Property Inspector — in a file of its own, in your user profile, rather than in the deck software's storage:

| Deck software | Settings file                                                        |
| ------------- | -------------------------------------------------------------------- |
| Stream Deck   | `%LOCALAPPDATA%\iRaceDeck\Settings\Stream Deck\global-settings.json` |
| Mirabox       | `%LOCALAPPDATA%\iRaceDeck\Settings\Mirabox\global-settings.json`     |
| Ulanzi Deck   | `%LOCALAPPDATA%\iRaceDeck\Settings\Ulanzi\global-settings.json`      |

The **Diagnostics** tab shows the exact path for your installation and has an **Open folder** button that reveals the file in Explorer.

The first time you start a version that stores settings this way, iRaceDeck copies your existing settings over from the deck software automatically — there is nothing to do. From then on your settings live with you rather than inside the deck software's own storage, so they survive plugin updates and reinstalls. The window and the Property Inspectors share that one file, which is why a binding changed in either shows up in the other straight away on Stream Deck and Mirabox; on Ulanzi Deck the Property Inspector side of that live sync is pending confirmation that UlanziStudio's in-session settings read works, so until then a Property Inspector there falls back to the deck software's own copy — it still displays fine, but a key binding changed in it does not reach the plugin; set bindings from the Settings window on Ulanzi Deck. The deck software keeps a copy too: iRaceDeck refreshes it once every time the plugin starts, so nothing is taken away from it and an older iRaceDeck version installed later still finds your settings where it expects them. The one exception is a start on which the deck software has not yet answered iRaceDeck's first read of your existing settings — that refresh waits until it does, so a copy iRaceDeck has not seen is never overwritten.

To back up your configuration, copy that one file somewhere safe; to restore it, put it back and restart the deck software. Each deck ecosystem gets its own folder, so a Stream Deck and an Ulanzi Deck installation on the same PC never share settings.

## How It Works

The plugin serves the window itself, on your own machine only (`127.0.0.1`), and opens it as a **chromeless app window** in Microsoft Edge or Google Chrome — whichever is installed — so it looks and behaves like a program window rather than a browser tab. If neither browser is found, it opens in your default browser as a normal tab instead; everything works the same, it just has a tab bar.

The window runs in its own private browser profile, separate from your everyday browsing, so nothing about it — cookies, extensions, sign-ins — is shared with your normal browser.

## Security

Because the window is a local web page, the plugin only answers requests carrying a secret it issued itself: it generates a fresh token when it starts serving (once per plugin run) and hands it to the window it opens and to iRaceDeck's own Property Inspectors so they can reach the plugin. Anything without it is refused, and nothing is reachable from outside your PC. Every setting written from the window goes through the plugin, the same way it would if a Property Inspector had written it — so the window can never store anything the plugin itself wouldn't.
