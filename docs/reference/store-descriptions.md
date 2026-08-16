# Store Listing Descriptions

Canonical copies of the iRaceDeck product descriptions published on the **Elgato Marketplace** and **Mirabox Space** store listings. The live texts exist only in the store dashboards — nothing in the repo or CI forces an update when the product changes, so these descriptions rot silently unless checked deliberately (the pre-2026-08 text predated the Race Engineer entirely).

**Last synced: 2026-08-12 (v2.4.0).** Update this file whenever a new text is published, and keep the "Last synced" line current.

## When to update

Check these descriptions for drift as part of **every release's** release-notes preparation (the `release-notes` skill points here), and any time one of the embedded facts changes:

| Embedded fact | Current value | Source of truth |
|---------------|---------------|-----------------|
| Action count (Elgato) | 32 | `packages/website/src/content/docs/index.mdx` stats row |
| Action count (Mirabox) | 31 (no Switch Profile) | Mirabox manifest `Actions` |
| Dial-capable actions (Elgato only) | 16 | `iracedeck-actions` skill / actions with `encoder: true` |
| Headline features | Race Engineer, live data on keys, template variables, dials, profiles | changelog / website |
| Supported Elgato devices | Stream Deck, Mini, XL, + | `packages/website/src/data/brands.ts` (`ECOSYSTEMS.elgato.devices`) |
| Supported Mirabox brands | Mirabox, Stream Dock, SOOMFON, VAPOURD, KILOGOGRAPH, HALCONTORNO, VSDinside, Nouvolo (list is open-ended) | `packages/website/src/data/brands.ts` (`BRANDS`) |
| Elgato requirements | Stream Deck software 7.1+, Windows 10+ | Elgato manifest `Software`/`OS` |
| Mirabox requirements | Stream Dock software 3.10.188+, Windows 10+ | Mirabox manifest `Software`/`OS` |

Wording traps:

- Only **one** Race Engineer voice ships. The driver names (Dean, Alex, Robbie, …) are what the engineer calls the *user* — say "the engineer addresses you by name", never "multiple engineer voices".
- The Mirabox description must claim **no dial support** (#786) and **no profiles** (no profile system on Stream Dock hosts).

## Format constraints

| Store | Formatting | Length |
|-------|------------|--------|
| Elgato Marketplace | **bold** labels, hyphen bullets; no headers, no backticks, no emoji | ≤ 4000 characters |
| Mirabox Space | plain text ONLY — no markdown of any kind, hyphen bullets are fine | keep comparable |

## Elgato Marketplace description

```text
**iRaceDeck — Stream Deck Plugin for iRacing**

Turn your Stream Deck into a fully-featured iRacing control panel — and your own pit wall. iRaceDeck gives you one-tap access to hundreds of controls — pit stops, cameras, replay, telemetry, chat, live car setup — plus a spoken Race Engineer who keeps you informed while you keep your eyes on the track.

**Why iRaceDeck?**

iRacing buries a lot of functionality behind keyboard shortcuts, chat commands, and nested menus. That's fine when you're browsing the UI, but mid-race or during a heated stint, fumbling for the right key combo costs time and focus. iRaceDeck moves all of that to your Stream Deck where you can see it, organize it, and hit it without thinking — 32 actions covering hundreds of individual controls.

**Your Own Race Engineer**

A built-in voice crew keeps you in the picture: spotter calls ("Car left!"), incident and penalty callouts, fuel strategy warnings, flags, live gap battles with the cars around you, opponent pit stops and penalty flags, even corner names in practice — and the engineer addresses you by name. Every callout can be toggled individually, and a directional proximity radar adds audio awareness of cars alongside.

**Pit Stop Controls**

Configure your pit strategy on the fly. Adjust fuel — including autofuel with lap margins — tires, compounds, and service options before you hit pit lane. No more memorizing black box navigation — just tap and go.

**Live Data on Your Keys**

Surface live telemetry right on your buttons: position, incidents, fuel and laps-to-empty, estimated iRating gain/loss, time gaps to your rivals, flags, track wetness, wind. Or build your own — any key title can show live iRacing data through template variables, and the Telemetry Display action renders fully custom readouts.

**Camera & Replay**

Switch cameras, follow different cars, and control replay playback directly from your deck. Ideal for broadcasters, league admins, and anyone who wants quick access to iRacing's camera system — including a full broadcast camera editor.

**Chat & Race Admin**

Send predefined chat messages with a single press — 15 configurable macros with live-data templating — plus reply, whisper, and quick chat toggles. League admins get a full race-control panel: black flags, penalties, wave-arounds, pace laps, session advance, and more.

**Made for Stream Deck +**

16 actions come with full dial support on Stream Deck+: spin a dial for fuel amounts, brake bias and other setup values, audio volumes, camera focus, FFB strength, black boxes, and more — with live readouts on the touch strip.

**Built for Every Stream Deck**

iRaceDeck supports Stream Deck, Stream Deck Mini, Stream Deck XL, and Stream Deck+ — and ships ready-made profiles so you can start from a full layout instead of an empty grid.

**Free & Open Source**

iRaceDeck is completely free. No subscriptions, no paywalls, no premium tiers. It's open source and community-driven — contributions, bug reports, and feature requests are always welcome.

**Requirements**

- Stream Deck software 7.1 or newer
- iRacing subscription
- Windows 10 or newer

Get iRaceDeck and stop reaching for your keyboard mid-race!

iRaceDeck — Control everything. See everything. Hear everything.
```

## Mirabox Space description

```text
iRaceDeck — iRacing Plugin for Stream Dock

Turn your Stream Dock into a fully-featured iRacing control panel — and your own pit wall. iRaceDeck gives you one-tap access to hundreds of controls — pit stops, cameras, replay, telemetry, chat, live car setup — plus a spoken Race Engineer who keeps you informed while you keep your eyes on the track.

Why iRaceDeck?

iRacing buries a lot of functionality behind keyboard shortcuts, chat commands, and nested menus. That's fine when you're browsing the UI, but mid-race or during a heated stint, fumbling for the right key combo costs time and focus. iRaceDeck moves all of that to your deck where you can see it, organize it, and hit it without thinking — 31 actions covering hundreds of individual controls.

Your Own Race Engineer

A built-in voice crew keeps you in the picture: spotter calls ("Car left!"), incident and penalty callouts, fuel strategy warnings, flags, live gap battles with the cars around you, opponent pit stops and penalty flags, even corner names in practice — and the engineer addresses you by name. Every callout can be toggled individually, and a directional proximity radar adds audio awareness of cars alongside.

Pit Stop Controls

Configure your pit strategy on the fly. Adjust fuel — including autofuel with lap margins — tires, compounds, and service options before you hit pit lane. No more memorizing black box navigation — just tap and go.

Live Data on Your Keys

Surface live telemetry right on your buttons: position, incidents, fuel and laps-to-empty, estimated iRating gain/loss, time gaps to your rivals, flags, track wetness, wind. Or build your own — any key title can show live iRacing data through template variables, and the Telemetry Display action renders fully custom readouts.

Camera & Replay

Switch cameras, follow different cars, and control replay playback directly from your deck. Ideal for broadcasters, league admins, and anyone who wants quick access to iRacing's camera system — including a full broadcast camera editor.

Chat & Race Admin

Send predefined chat messages with a single press — 15 configurable macros with live-data templating — plus reply, whisper, and quick chat toggles. League admins get a full race-control panel: black flags, penalties, wave-arounds, pace laps, session advance, and more.

Built for the Mirabox Ecosystem

iRaceDeck runs on Mirabox ecosystem devices — VSDinside Stream Dock, SOOMFON, VAPOURD, and more.

Free & Open Source

iRaceDeck is completely free. No subscriptions, no paywalls, no premium tiers. It's open source and community-driven — contributions, bug reports, and feature requests are always welcome.

Requirements

- Stream Dock software 3.10.188 or newer
- iRacing subscription
- Windows 10 or newer

Get iRaceDeck and stop reaching for your keyboard mid-race!

iRaceDeck — Control everything. See everything. Hear everything.
```
