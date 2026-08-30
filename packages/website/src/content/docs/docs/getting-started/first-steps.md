---
title: First Steps
description: What to do first with iRaceDeck — put keys on your deck, start from a ready-made layout, meet the Race Engineer, and avoid the one setup mistake that silently breaks everything.
---

## Welcome to iRaceDeck

iRaceDeck turns your deck into an iRacing control panel: pit service, black boxes, cameras, chat macros, replay controls, and a voice on the radio that keeps you informed while you drive.

This is the short version — what to do first. Everything here is also on [iracedeck.com](https://iracedeck.com/), so you can read it away from the sim.

## Put your first keys on the deck

Find **iRaceDeck** in your deck software's action list and drag an action onto a key. That action's own settings appear beside it. Everything plugin-wide — key bindings, audio, appearance — lives behind the **iRaceDeck Settings** button directly under them.

Three worth starting with:

- **Black Box Selector** — puts iRacing's black boxes on their own keys instead of cycling through them.
- **Fuel Service** — sets the fuel for your next stop without reaching for the keyboard.
- **Look Direction** — hold to look left or right.

## Start from a ready-made layout

Rather than arranging every key yourself, you can switch to a layout iRaceDeck already ships. **iRaceDeck Default** is the everyday one: pit service, chat macros, black box selection, the Race Engineer, and folders leading to the rest. Three more sit alongside it — **Replay** for watching replays and broadcasts, **Car Selector** for picking a car out of a grid, and **Race Admin Per Car** for admin commands aimed at the car you picked.

There is nothing to import by hand. The first time you switch to one, the Stream Deck app offers to install it.

Ready-made layouts are a **Stream Deck** feature. Mirabox and Ulanzi have no profile system, so there is nothing to install there — everything else on this page applies to all three.

<!-- ird:action open-profiles-tab -->

## Meet your Race Engineer

A spoken race engineer in your ear. It calls flags and incidents, counts you into your pit box, reads your pit service back to you, keeps you posted on fuel and gaps, and warns you when a car is alongside.

**It is off by default, on purpose.** A voice that starts talking unannounced is a surprise rather than a feature, so nothing is said until you ask for it.

<!-- ird:action enable-race-engineer -->

The **Race Engineer** tab holds the rest: which voice, the name it calls you by, how loud, and which callouts you want to hear. Radar — proximity ticks when a car pulls alongside — is a separate switch on that same tab, off by default for the same reason.

Already using Crew Chief? Both will talk. Turn off individual callouts on the **Race Engineer** tab to keep them out of each other's way.

<!-- ird:action open-race-engineer-tab -->

## Some keys need a key binding

Most iRaceDeck actions talk to iRacing directly through its own API and work the moment you press them. A few cannot — iRacing exposes no API for black boxes or cameras — so those send a keystroke instead, and a handful send a chat command.

Every action says which of the three it uses, right under its Mode dropdown, and links you to the binding when it needs one. If a key looks like it is doing nothing, that is the first place to check.

## If something is not working

**Run your deck software and iRacing at the same level.** If iRacing runs as administrator and your deck software does not, Windows silently discards every command iRaceDeck sends — no error, no warning, and telemetry keeps arriving, so everything looks healthy while nothing works. Run both as administrator, or neither.

<!-- ird:action suggest-focus-iracing-window -->

For anything else, [Troubleshooting](/docs/getting-started/troubleshooting/) covers the common cases.

## How often you hear from us

When iRaceDeck updates, it can open its release notes for you. **It stays quiet by default, on purpose** — nothing opens itself unless you ask. Either way the notes are always waiting on the **What's New** tab.

<!-- ird:action enable-changelog-updates -->

You can also pick exactly how often — every update, feature updates only, once a month, or never. That setting sits on the **What's New** tab, and you can change it whenever you like.

<!-- ird:action changelog-frequency -->

## Where to go next

- [Documentation](/docs/) — every action and every setting, in detail.
- [What's New](/changelog/) — what changed in this release.
- [Discord](https://discord.gg/c6nRYywpah) — questions, bug reports, and other drivers.

This page stays on the **Getting Started** tab, so you can come back to it whenever you like.
