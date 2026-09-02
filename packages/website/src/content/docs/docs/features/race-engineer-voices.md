---
title: Race Engineer Voices
description: How Race Engineer voice packs work, where they are stored, how to download or install one, and why they survive plugin updates.
---

The Race Engineer speaks with a **voice pack** — a folder of recorded lines that iRaceDeck plays during a session. iRaceDeck comes with its own, and you can add more — downloaded from iRaceDeck itself, or installed by hand.

Voice packs live **outside the plugin folder**, in your own AppData directory:

```text
%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\
```

That location matters: because packs are not inside the plugin, **updating or reinstalling iRaceDeck never removes them**. Install a voice once and it stays until you delete it.

The folder is shared by all three iRaceDeck plugins. If you use a Stream Deck and a Mirabox on the same PC, they read the same voices — you never download or store the same pack twice.

## Choosing a Voice

Open **iRaceDeck Settings** from any action's Property Inspector, go to the **Race Engineer** section, and pick from the **Race Engineer Voice** dropdown. Every installed voice appears there, under the name its pack gave it. The change takes effect on the next callout — there is no need to restart anything.

Some voices are listed with their pack's name in front, as **Pack: Voice**. That happens when the voice's name alone could be ambiguous — a pack providing more than one voice, or a pack whose own name differs from its voice's. A pack that provides a single voice with a matching name is listed by that name alone. The rule depends only on the pack itself, so installing another pack never renames a voice you have already chosen.

**Installed Voices** just below the dropdown lists every pack iRaceDeck has loaded, with its version and where it came from — downloaded from iRaceDeck's own catalog, or installed by hand. Anything in the folder that iRaceDeck could not load is listed underneath, with the reason — so a pack that is present but silent tells you why without you going looking for it.

## Downloading a Voice Pack

iRaceDeck publishes its own voice packs and can download and install one for you — no folder to find, no archive to extract.

Open **iRaceDeck Settings**, go to the **Race Engineer** section, and look under **Voices**. Alongside the packs you already have, iRaceDeck lists any pack from its own catalog that you don't, each with an **Install** button — or **Update**, once a newer version of a pack you already have has been published. Press it, and iRaceDeck downloads, verifies, and installs the pack for you.

The download can happen **while iRacing is running**, including mid-race — iRaceDeck never opens a window to ask about it or report on it. Progress shows up wherever you're already looking instead: the warning banner on an open action's Property Inspector, the Voices section if Settings happens to be open, and the Pit Crew key, which shows a "downloading" status in place of its usual one. If you're not looking anywhere, the pack is simply there next time you check — the Race Engineer keeps using whatever voice you already had until the new one is ready.

If iRaceDeck can't reach the catalog — no connection, or a bad one — nothing already installed is affected. Every voice you have keeps working exactly as before; iRaceDeck just has nothing new to offer until it can check again.

A downloaded pack is verified against a checksum before it replaces anything, so a corrupted or incomplete download is discarded rather than installed. A pack you no longer want can be removed from the same Voices section.

## Installing a Voice Pack by Hand

Not every voice pack comes from iRaceDeck's catalog — a pack someone shared with you directly, or one you built yourself, still installs the way voice packs always could. Voice packs are ordinary folders, so you can install one yourself:

1. Open `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\` — paste that path into the File Explorer address bar. Create the folders if they do not exist yet.
2. Put the pack's folder inside it. The folder must contain a `voice-pack.json` file and the pack's audio.
3. In iRaceDeck Settings, press **Rescan voices**.

The new voice appears in the dropdown immediately. You do not need to restart the deck software.

The folder name must match the pack's own name — if a pack calls itself `luca`, its folder has to be `luca`. A pack whose folder has been renamed is ignored, because iRaceDeck would then have two different names for the same thing.

## When a Pack Does Not Appear

If you rescan and the voice does not appear, iRaceDeck ignored the pack — and it says so: the pack is listed under **Installed Voices** with the reason beside it. The same reason is written to the plugin log, at the normal logging level, so you do not need to turn anything on to find it there either. The usual causes:

- **No `voice-pack.json`** — the folder is not a voice pack, or you copied the audio without the file that describes it.
- **`voice-pack.json` could not be read** — the file is there, but something is holding it open or blocking access: a cloud-sync client still uploading it, an antivirus scanner, or a folder your account cannot read. The error code is shown with the message. Wait for the sync to finish, or check the folder's permissions, then rescan.
- **The folder name does not match the pack's name** — rename the folder to match.
- **No audio in the pack** — the pack declares a voice but ships no clips for it.
- **Clips iRaceDeck cannot play** — the pack has audio under the voice, but not where iRaceDeck looks for it. Clips must sit at `voice/<voice>/<group>/<name>.mp3` — one folder per group inside the voice folder — and the extension must be lowercase `.mp3`. A pack whose files are one level too shallow, or exported as `.MP3`, is refused with this reason rather than installing and then saying nothing.
- **Another pack already provides that voice** — two packs cannot both supply the same voice. The one that comes first alphabetically wins and the other is ignored; rename or remove one of them.
- **iRaceDeck already includes that voice** — a pack cannot take over a voice that comes with the plugin. The included one always wins.

## Third-Party Voice Packs

Anyone can build a voice pack, and iRaceDeck will load one you install by hand.

**A third-party pack is its author's, not ours.** It is distributed by whoever made it, on their terms; iRaceDeck has nothing to do with it beyond being able to play it. We do not host it, endorse it, verify it, or support it, and installing one is between you and its author — trust it the way you would trust any other file you choose to download. If you make a pack, it stays yours, and it is on you to have the right to distribute the voice in it.

There is no submission process for iRaceDeck's own catalog — it lists only the packs we publish ourselves, and a third-party pack reaches you by sideload, never by appearing there.
