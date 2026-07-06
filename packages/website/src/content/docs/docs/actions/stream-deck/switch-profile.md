---
title: Switch Profile
description: Put a Stream Deck profile switch on any key — jump to a bundled iRaceDeck profile or back to the previous one.
sidebar:
  badge:
    text: "Elgato only"
    variant: note
---

Puts a profile switch on any key. Pressing the key switches your Stream Deck to a bundled [iRaceDeck profile](/docs/features/stream-deck-profiles/) — **iRaceDeck Default** unless you pick another — or walks back to the profile you came from. This action is only available on Elgato Stream Deck devices, and only does something on models that ship bundled profiles (see [supported devices](/docs/features/stream-deck-profiles/#supported-devices)).

This action sends no iRacing command — it's pure Stream Deck navigation.

## Details

- **Method:** Navigation (switches the Stream Deck profile) — no iRacing command
- **Dial:** No rotation support (keypad only)
- **Default binding:** No keyboard binding
- **Telemetry-aware icon:** No — the icon reflects the selected profile

## Pressing the key

- With a profile selected, the key switches your Stream Deck to it, always landing on the profile's first page. If the profile isn't installed yet, the Stream Deck app asks to install it first.
- With **Back to previous** selected, the key returns to the profile you came from — restoring the page you left — walking back through the iRaceDeck profiles you visited and ending at **iRaceDeck Default** when there's nowhere further back.
- On devices with bundled profiles, a key with no profile selected behaves as **iRaceDeck Default**, so a Switch Profile key is never a dead key.

## Settings

### Profile

Which profile the key switches to. The dropdown lists the bundled profiles available for this device, plus **Back to previous**. Defaults to **iRaceDeck Default**.

### Placed in profile

Only needed when a Switch Profile key lives **inside** a bundled iRaceDeck profile: set it to the profile the key is placed in. It tells the plugin which profile is on screen so **Back to previous** can find its way back — the Stream Deck app offers the plugin no other way to tell. Leave it unset for keys in your own profiles. The keys inside the bundled profiles ship with this already configured.

## Key icon

- **iRaceDeck Default** shows a clean, title-less iRaceDeck logo.
- Other profiles show their own artwork with the profile name as the key label (the `iRaceDeck` prefix is dropped — e.g. `REPLAY`, `RACE ADMIN CARS`).
- **Back to previous** shows a back chevron with no label.
- Switch Profile keys stay border-less even when plugin-wide [borders](/docs/features/border-indicator/) are enabled; a per-key border override in this key's settings still applies.
