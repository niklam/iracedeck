---
title: Race Engineer Voices
description: How Race Engineer voice packs work, where they are stored, how to install one by hand, and why they survive plugin updates.
---

The Race Engineer speaks with a **voice pack** — a folder of recorded lines that iRaceDeck plays during a session. iRaceDeck ships with one, and you can install more.

Voice packs live **outside the plugin folder**, in your own AppData directory:

```text
%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\
```

That location matters: because packs are not inside the plugin, **updating or reinstalling iRaceDeck never removes them**. Install a voice once and it stays until you delete it.

The folder is shared by all three iRaceDeck plugins. If you use a Stream Deck and a Mirabox on the same PC, they read the same voices — you never download or store the same pack twice.

## Choosing a Voice

Open **iRaceDeck Settings** from any action's Property Inspector, go to the **Race Engineer** section, and pick from the **Race Engineer Voice** dropdown. Every installed voice appears there. The change takes effect on the next callout — there is no need to restart anything.

**Installed Voices** just below the dropdown lists every pack iRaceDeck has loaded, with its version.

## Installing a Voice Pack by Hand

Voice packs are ordinary folders, so you can install one yourself:

1. Open `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\` — paste that path into the File Explorer address bar. Create the folders if they do not exist yet.
2. Put the pack's folder inside it. The folder must contain a `voice-pack.json` file and the pack's audio.
3. In iRaceDeck Settings, press **Rescan voices**.

The new voice appears in the dropdown immediately. You do not need to restart the deck software.

The folder name must match the pack's own name — if a pack calls itself `luca`, its folder has to be `luca`. A pack whose folder has been renamed is ignored, because iRaceDeck would then have two different names for the same thing.

## When a Pack Does Not Appear

If you rescan and nothing changes, the pack was rejected. Every rejection is written to the plugin log with the reason, so turn on **Enable debug logging** on the Diagnostics tab and rescan to see it. The usual causes:

- **No `voice-pack.json`** — the folder is not a voice pack, or you copied the audio without the file that describes it.
- **The folder name does not match the pack's name** — rename the folder to match.
- **No audio in the pack** — the pack declares a voice but ships no clips for it.
- **Another pack already provides that voice** — two packs cannot both supply the same voice. The one that comes first alphabetically wins and the other is ignored; rename or remove one of them.

## Third-Party Voice Packs

Anyone can build a voice pack, and iRaceDeck will load one you install by hand. Two things are worth knowing:

- A hand-installed pack is **not verified by iRaceDeck**. It is audio from whoever made it, and you are trusting that person the same way you would trust any other file you download.
- A voice belongs to whoever recorded it. If you publish a pack, make sure you have the right to distribute the voice in it.

## What Is Coming

Downloading voice packs from inside iRaceDeck — browsing available voices and installing them with one click — is being built and will arrive in a later release. Until then, installing by hand is the way to add a voice.
