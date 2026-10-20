---
title: Stream Deck Profiles
description: Ready-made iRaceDeck button layouts for Elgato Stream Deck devices — installed and switched with a single press, or automatically by session type.
---

iRaceDeck bundles ready-made Stream Deck profiles — complete button layouts built from iRaceDeck actions — so you get a full iRacing deck without arranging every key yourself. Switch to one and your Stream Deck shows a curated iRacing layout; your own profiles stay untouched, and you can return to them at any time.

Bundled profiles are an **Elgato Stream Deck feature**. Mirabox and Ulanzi hosts have no profile system, so nothing on this page applies to those devices.

## Supported devices

Profiles are built separately for each Stream Deck model, and not every model has them yet. Bundled profiles are currently provided for:

- **Stream Deck** — the classic 15-key model
- **Stream Deck XL** — the 32-key model
- **Stream Deck +** — the 8-key model with four dials and a touch strip
- **Stream Deck + XL** — the 36-key model with dials

Every bundled profile below is provided for all four. On other Stream Deck models (the Mini, the Neo and the Galleon 100 SD), iRaceDeck's other actions work normally — there are just no bundled profiles to switch to yet. The [Settings window](/docs/getting-started/settings/#profiles) says so when you pick one of those decks, and a [Switch Profile](/docs/actions/stream-deck/switch-profile/) key does nothing on them.

## The bundled profiles

- **iRaceDeck Default** — the everyday racing layout: pit service (fuel, tires, quick actions), chat macros, black box selection, the Race Engineer, and folders leading to more. It is the profile a fresh [Switch Profile](/docs/actions/stream-deck/switch-profile/) key targets, and the hub the other profiles come back to.
- **iRaceDeck Practice** — a layout for practice sessions, when you are working on the car and your laps rather than racing.
- **iRaceDeck Test** — a starting point for test drives, to shape to your own liking.
- **iRaceDeck Qualifying** — a starting point for qualifying sessions, to shape to your own liking.
- **iRaceDeck Race** — a starting point for races, to shape to your own liking.
- **iRaceDeck Replay** — built for watching replays and broadcasts: replay playback controls and camera-focus keys across multiple pages.
- **iRaceDeck Car Selector** — a generic pick-a-car grid with two uses: as the race-control car selector, pages of [Select Car](/docs/actions/communication/race-admin/#select-car-admin-target) keys that fill themselves with the cars in the current session; and, opened from the Replay profile by [Camera Controls'](/docs/actions/view-camera/camera-focus/) **Focus Car (pick from grid)** mode, a camera director — press a car to focus on it and stay on the grid to hop car to car.
- **iRaceDeck Race Admin Per Car** — the admin command page the car selector switches to: [Race Admin](/docs/actions/communication/race-admin/) commands set to the **Selected Car** target, so every key acts on the car you picked.

The Practice, Test, Qualifying and Race profiles are the ones [automatic switching](#switching-automatically-by-session-type) is built around. They are yours to edit: change them in the Stream Deck app like any other profile.

## Installing a profile

There is nothing to import by hand. The first time you switch to a bundled profile, the Stream Deck app asks to install it — confirm, and the profile is added to your device's profile list. Updates work the same way: after an iRaceDeck update, switching to a profile installs its latest version.

Installing a profile never moves you off the one you are on: only **iRaceDeck Default** is switched to when it is first installed.

## Switching from the Settings window

The [Settings window](/docs/getting-started/settings/#profiles) has a **Profiles** tab, so you can switch profiles without dedicating a key to it:

1. Open the [Settings window](/docs/getting-started/settings/#profiles) — every iRaceDeck key's Property Inspector has an **iRaceDeck Settings** button directly under the key's own settings.
2. Go to the **Profiles** tab. With more than one Stream Deck connected, pick which one you want to switch.
3. The tab lists every bundled profile the chosen Stream Deck has, with a **Switch** button next to each.
4. Press **Switch** — your Stream Deck changes to that profile immediately. If the profile isn't installed yet, the Stream Deck app asks to install it first.

## Switching with a key

The [Switch Profile](/docs/actions/stream-deck/switch-profile/) action puts a profile switch on any key — on your own layout to jump into an iRaceDeck profile, or inside the bundled profiles, where it powers the navigation between them. Its **Back to previous** option walks back through the iRaceDeck profiles you visited, ending at **iRaceDeck Default** when there's nowhere further back.

## Switching automatically by session type

iRaceDeck can switch your Stream Deck for you when the session changes — the Practice profile when you join a practice session, the Race profile when the race starts. It is off until you turn it on, in the **Automatically switch to profile** card on the [Settings window's Profiles tab](/docs/getting-started/settings/#profiles):

1. Turn on **Switch profiles by session type**.
2. Pick a profile for each session type you want switched. Every row starts as **Do not change the profile**, so nothing switches until you pick at least one.

| Row | When it applies |
|-----|-----------------|
| **Test** | A test drive |
| **Practice** | Practice, lone practice and warmup |
| **Qualifying** | Open and lone qualifying |
| **Race** | A race |
| **Replay** | A saved replay opened from iRacing — not watching the replay during a live session, so reviewing an incident mid-race leaves your deck alone |

How it behaves:

- **Every connected Stream Deck** that has a version of the chosen profile switches, landing on the profile's first page. A deck without one (see [supported devices](#supported-devices)) is left alone.
- **It switches when the session type changes**, not continuously. If you switch profiles yourself mid-session, iRaceDeck leaves your choice alone until the next session type begins.
- **Changes apply straight away.** Turning it on, or changing a row, during a session switches to the profile for the session you are in.
- **When iRacing closes**, each deck it switched goes back to the last iRaceDeck profile it knew the deck was on before the first automatic switch, or to **iRaceDeck Default** when it knew none. iRaceDeck can't see or switch to your own profiles, so if you were on one of yours, switch back to it in the Stream Deck app.

Only iRaceDeck's own bundled profiles can be chosen: the Stream Deck app doesn't let a plugin switch to profiles you made yourself. To make a session's layout your own, edit the bundled profile for it in the Stream Deck app.

## Returning to your own layout

iRaceDeck can only switch between the profiles it ships — it has no access to profiles you built yourself. To get back to one of your own layouts, switch profiles in the Stream Deck app as usual, by picking your profile from the device's profile list.
