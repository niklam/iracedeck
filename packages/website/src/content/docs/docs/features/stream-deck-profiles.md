---
title: Stream Deck Profiles
description: Ready-made iRaceDeck button layouts for Elgato Stream Deck devices — installed and switched with a single press.
---

iRaceDeck bundles ready-made Stream Deck profiles — complete button layouts built from iRaceDeck actions — so you get a full iRacing deck without arranging every key yourself. Switch to one and your Stream Deck shows a curated iRacing layout; your own profiles stay untouched, and you can return to them at any time.

Bundled profiles are an **Elgato Stream Deck feature**. Mirabox and Ulanzi hosts have no profile system, so nothing on this page applies to those devices.

## Supported devices

Profiles are built separately for each Stream Deck model, and not every model has them yet. Bundled profiles are currently provided for:

- **Stream Deck** — the classic 15-key model
- **Stream Deck XL** — the 32-key model

On other Stream Deck models, iRaceDeck's other actions work normally — there are just no bundled profiles to switch to yet. A [Switch Profile](/docs/actions/stream-deck/switch-profile/) key or a **Switch** press in the settings does nothing on those devices.

## The bundled profiles

- **iRaceDeck Default** — the everyday racing layout: pit service (fuel, tires, quick actions), chat macros, black box selection, the Race Engineer, and folders leading to more. It is the profile a fresh [Switch Profile](/docs/actions/stream-deck/switch-profile/) key targets, and the hub the other profiles come back to.
- **iRaceDeck Replay** — built for watching replays and broadcasts: replay playback controls and camera-focus keys across multiple pages.
- **iRaceDeck Car Selector** — a generic pick-a-car grid with two uses: as the race-control car selector, pages of [Select Car](/docs/actions/communication/race-admin/#select-car-admin-target) keys that fill themselves with the cars in the current session; and, opened from the Replay profile by [Camera Controls'](/docs/actions/view-camera/camera-focus/) **Focus Car (pick from grid)** mode, a camera director — press a car to focus on it and stay on the grid to hop car to car.
- **iRaceDeck Race Admin Per Car** — the admin command page the car selector switches to: [Race Admin](/docs/actions/communication/race-admin/) commands set to the **Selected Car** target, so every key acts on the car you picked.

## Installing a profile

There is nothing to import by hand. The first time you switch to a bundled profile, the Stream Deck app asks to install it — confirm, and the profile is added to your device's profile list. Updates work the same way: after an iRaceDeck update, switching to a profile installs its latest version.

## Switching from any action's settings

Every iRaceDeck action's settings include a **Stream Deck Profiles** section, so you can switch profiles without dedicating a key to it:

1. Select any iRaceDeck key on your Stream Deck to open its settings (the Property Inspector).
2. Scroll down past the action's own settings to the **Global Settings** area and expand the **Stream Deck Profiles** section.
3. The section lists every bundled profile with a **Switch** button next to it.
4. Press **Switch** — your Stream Deck changes to that profile immediately. If the profile isn't installed yet, the Stream Deck app asks to install it first.

## Switching with a key

The [Switch Profile](/docs/actions/stream-deck/switch-profile/) action puts a profile switch on any key — on your own layout to jump into an iRaceDeck profile, or inside the bundled profiles, where it powers the navigation between them. Its **Back to previous** option walks back through the iRaceDeck profiles you visited, ending at **iRaceDeck Default** when there's nowhere further back.

## Returning to your own layout

iRaceDeck can only switch between the profiles it ships — it has no access to profiles you built yourself. To get back to one of your own layouts, switch profiles in the Stream Deck app as usual, by picking your profile from the device's profile list.
