---
title: Race Engineer Voices
description: How Race Engineer voice packs work, where they are stored, how to install one by hand, and why they survive plugin updates.
---

The Race Engineer speaks with a **voice pack** — a folder of recorded lines that iRaceDeck plays during a session. iRaceDeck comes with its own, and you can install more.

Voice packs live **outside the plugin folder**, in your own AppData directory:

```text
%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\
```

That location matters: because packs are not inside the plugin, **updating or reinstalling iRaceDeck never removes them**. Install a voice once and it stays until you delete it.

The folder is shared by all three iRaceDeck plugins. If you use a Stream Deck and a Mirabox on the same PC, they read the same voices — you never download or store the same pack twice.

## Choosing a Voice

Open **iRaceDeck Settings** from any action's Property Inspector, go to the **Race Engineer** section, and pick from the **Race Engineer Voice** dropdown. Every installed voice appears there, under the name its pack gave it. The change takes effect on the next callout — there is no need to restart anything.

**Installed Voices** just below the dropdown lists every pack iRaceDeck has loaded, with its version. Anything in the folder that iRaceDeck could not load is listed underneath, with the reason — so a pack that is present but silent tells you why without you going looking for it.

## Installing a Voice Pack by Hand

Voice packs are ordinary folders, so you can install one yourself:

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

## What Is Coming

Downloading voice packs from inside iRaceDeck — browsing available voices and installing them with one click — is being built and will arrive in a later release. Until then, installing by hand is the way to add a voice.
