---
title: Your First Voice Pack
description: Build a working Race Engineer voice pack in an evening — three callouts, three recorded lines, a voice-pack.json and a three-entry callouts.json — then hear it in the scenario harness and in the sim.
---

By the end of this page you will have a voice pack that plays three callouts in your own voice, installed where iRaceDeck looks for it, auditioned in the scenario harness without launching iRacing, and checked by the pack linter. Everything else the Race Engineer says stays quiet in your voice until you add it — that is the [format's design](/docs/voice-packs/#absent-means-skipped), not a limitation of the tutorial.

You need a Windows PC with the iRaceDeck repository cloned and built — the [development setup](/docs/development/setup/) page covers that, and the harness and the linter both live in the repo — something to record with, and an audio editor that exports MP3.

## Pick three callouts

Start with callouts that fire on a plain event and say one line, so nothing about the script can get in the way of hearing your voice. These three do, and each has its own button in the harness:

| Callout                        | When it fires                                                                                          | Harness button                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------- |
| `pit-crew.flag-green`          | The green flag at the start of a practice or qualifying session, or at a race restart — the initial race start belongs to the start lights. | **Flags → Green**             |
| `pit-crew.pit-window-opened`   | Pit road switches from closed to open while you are in a race.                                        | **Pit Window → Pits opened**  |
| `pit-crew.damage-repair-needed`| Your car takes damage that keeps the repair indicator lit for three seconds, and again only after a repair has cleared it. | **Damage → Damage Detected**  |

Every callout has an entry like this in the [callout reference](/docs/voice-packs/reference/callouts/): what triggers it, how to hear it, and what the bundled voice's entry references. That reference is where you will pick the next three from.

## Record three lines

Record one take of each line, dry and clean — a quiet room, no effects, no compression, trimmed close at both ends — and export each as an MP3. Name them by group and base, with a two-digit take number:

```text
voice/my-voice/flags/green-01.mp3          "Green flag, green flag — push now."
voice/my-voice/pit-window/opened-01.mp3    "Pits are open."
voice/my-voice/damage/repair-needed-01.mp3 "We've picked up some damage — the crew can fix it."
```

The wording is yours. The path is what matters: `voice/<voice-id>/<group>/<base>-NN.mp3`, one folder per group, lowercase `.mp3`. A clip one folder too shallow, or exported as `.MP3`, is dropped — and only when a voice is left with no playable clip at all does **Installed Voices** say so; one bad file among good ones is dropped with no message, which is what the [lint step](#lint-the-pack) below is for. Every take of a line is one **pool** — record a second take later as `green-02.mp3` and the engine alternates between them; nothing in the script changes.

Two things about how your clips will sound. The clips iRaceDeck ships are radio-filtered when the plugin is built — a band-pass, some gain into a soft clip, a limiter — but a pack you install plays exactly what you recorded; if you want the walkie-talkie colour, apply an effect of your own in the editor before exporting. And the built-in radio frame — the open tick, the pit-lane ambience underneath, the close tick — is the plugin's, and plays around your clips because your script says so in the next step; leave it out if you prefer your lines bare.

## Write `voice-pack.json`

At the top of the pack folder:

```json
{
  "schema": 1,
  "id": "my-pack",
  "label": "My Pack",
  "version": "1.0.0",
  "author": "Your name",
  "voices": [{ "id": "my-voice", "label": "My Voice" }]
}
```

`id` is lowercase kebab-case and must match the folder name. The voice's `id` is the `<voice-id>` in every clip path; its `label` is what the voice dropdown shows.

## Write `callouts.json`

Beside the clips, at `voice/my-voice/callouts.json`:

```json
{
  "schema": 1,
  "scenarios": {
    "pit-crew.flag-green": {
      "comment": "The green flag, one line for every session type.",
      "test": "Harness → Flags → Green.",
      "sequence": ["pool:flags/green"]
    },
    "pit-crew.pit-window-opened": {
      "comment": "Pit road has opened.",
      "test": "Harness → Pit Window → Pits opened.",
      "sequence": ["pool:pit-window/opened"]
    },
    "pit-crew.damage-repair-needed": {
      "comment": "The car has repairable damage.",
      "test": "Harness → Damage → Damage Detected.",
      "sequence": ["pool:damage/repair-needed"]
    }
  },
  "frames": {
    "radio": {
      "comment": "The plugin's own walkie-talkie frame: open tick, pit-lane ambience, close tick.",
      "open": [{ "clip": "sfx/IRD-tick-open.mp3" }, { "ambient": "start" }, { "ambient": "seek" }],
      "close": [{ "ambient": "stop" }, { "clip": "sfx/IRD-tick-close.mp3" }]
    }
  },
  "pools": {}
}
```

Each entry names a callout by id and plays one pool: `pool:<group>/<base>`, the path of the clips you just recorded with the take number left off. `comment` and `test` are for you and whoever reads the file next; iRaceDeck does not act on them.

The `frames` block matters more than it looks. All three of these callouts are framed by default, so the script must say what `radio` means or every one of them is skipped with `unknown frame "radio"` in the log. The frame above is the bundled voice's, and `sfx/IRD-tick-open.mp3` and `sfx/IRD-tick-close.mp3` are the plugin's own sound effects, available to every pack. If you would rather hear your lines with no ticks and no ambience, add `"frame": "none"` to each entry instead, and `"frames": {}` is enough.

The [format page](/docs/voice-packs/format/) has every key and every step form.

## Install it

Put the folder in iRaceDeck's voices folder — `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\` — so the pack reads:

```text
%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\my-pack\
├── voice-pack.json
└── voice\my-voice\
    ├── callouts.json
    ├── flags\green-01.mp3
    ├── pit-window\opened-01.mp3
    └── damage\repair-needed-01.mp3
```

Then, in iRaceDeck Settings on the Race Engineer tab, press **Rescan voices** and choose **My Voice** from the **Race Engineer Voice** dropdown. [Race Engineer Voices](/docs/features/race-engineer-voices/#installing-a-voice-pack-by-hand) has the rest — the folder-name rule and the list of reasons a pack is refused — and **Installed Voices** on that same tab names the problem when yours does not appear. One thing to know before you press it: the **Test** button beside **Race Engineer Volume** plays `names/<driver>` and then `welcome/greeting-01`, neither of which this pack records, so it is silent for **My Voice** by design — a pack that wants the Test button voiced records that greeting line too (both are in the [recording script](/docs/voice-packs/reference/recording-script/)). From here on, the green flag that opens your next practice session is in your voice.

## Hear it in the harness

The scenario harness is how this repo hears a callout without iRacing, and it reads your packs folder when `IRACEDECK_VOICE_PACKS_PATH` names it. From the repo root, after `pnpm install` and `pnpm build`:

```powershell
# PowerShell
$env:IRACEDECK_VOICE_PACKS_PATH = "$env:LOCALAPPDATA\iRaceDeck\Race Engineer\Voices"
pnpm --filter @iracedeck/scenario-harness dev
```

```bash
# Git Bash
IRACEDECK_VOICE_PACKS_PATH="$LOCALAPPDATA/iRaceDeck/Race Engineer/Voices" pnpm --filter @iracedeck/scenario-harness dev
```

Open `http://127.0.0.1:5750/`. Under **Global Settings**, pick your voice in the **Voice** dropdown — the harness lists voices by id, so yours is `my-voice`, beside the bundled `default`. Then, under **Scenario Shortcuts**, press **Flags → Green**, **Pit Window → Pits opened** and **Damage → Damage Detected**. Each fires the real event through the real engine, so what you hear is exactly what the plugin plays.

The harness terminal logs at debug level, so among the boot lines you will find `Voice "my-voice": 3 of 149 callouts scripted` — the count of entries that compiled — and a warning for any entry that did not, naming what it could not resolve. After editing `callouts.json`, press **Reload audio** in the harness and the packs are rescanned without a restart; a script that no longer parses is reported in the terminal and that voice is left out until it parses again, exactly as the plugin would treat it.

## Lint the pack

From the repo root, after `pnpm build`, run `pnpm lint:pack <path to the pack folder>`:

```powershell
pnpm lint:pack "$env:LOCALAPPDATA\iRaceDeck\Race Engineer\Voices\my-pack"
```

It prints the problems it finds first, grouped by voice, then a summary line per voice — for this pack, `my-voice: 3 of 149 callouts scripted; skipped: 146` — followed by the 146 ids under it, and ends with `No problems` or the problem count. The list of ids is every callout your pack does not script: skip-by-default at work, not something to fix, and there will be a screenful of them until the pack grows. Only a problems section above the summary makes the exit code non-zero. With skip-by-default, quiet failure is the design, so this is the one place a pack is told anything loudly; run it every time you add lines.

## When a callout stays silent

Work through these in order.

1. **Read the callout's `test` line.** A callout is triggered by a code-owned gate, and a script entry is consulted only after that gate says yes — so a correct entry is silent whenever the sim state does not call for the callout, and in the harness a snapshot-driven callout fired with no matching state resolves its variables to nothing and aborts before a clip plays. The [callout reference](/docs/voice-packs/reference/callouts/) carries each callout's description and its `test` line; do what the `test` line says, in the harness or in the sim, before touching the script. This is the one confusion every pack author meets, and it is covered at the top of [Voice Packs](/docs/voice-packs/#a-correct-script-can-be-silent).
2. **Check Installed Voices.** If the whole voice is quiet, look under **Installed Voices** in iRaceDeck Settings. A pack that was refused is listed with the reason; a voice whose `callouts.json` failed to parse is listed with the first problem, path-prefixed, so you can go straight to the line. A voice that is listed with no problem but has no script file is a clips-only voice, and a banner names it while it is selected.
3. **Turn on debug logging and read the compile lines.** Enable debug logging on the [Diagnostics tab](/docs/getting-started/settings/#diagnostics), press **Rescan voices**, and read the plugin log: `Voice "my-voice": N of 149 callouts scripted` says how many entries compiled, and every entry that did not has a warning naming the reference it could not resolve — a misspelled variable, a frame the script never defined. At fire time a callout that aborts says why at debug level too: `Scenario "pit-crew.flag-green" skipped — pool "flags/green" resolved to nothing for the active voice` means the clip is not where the script says it is.
4. **Run the linter.** It prints what it finds in one go, without a rescan and without a log to read.

## Next steps

- **Add a family.** The [recording script](/docs/voice-packs/reference/recording-script/) lists every line of the bundled voice by group, with the text of each take and which callouts draw from it. Pick a group — `pit-window/` is two lines, `flags/` is thirty — record it, and copy the bundled entries for the callouts it serves from the [callout reference](/docs/voice-packs/reference/callouts/).
- **Word the green flag per session.** The bundled entry for `pit-crew.flag-green` branches on the case `session.type` with a line each for practice, qualifying and the race; the [callout reference](/docs/voice-packs/reference/callouts/) shows the three pools it draws from, and the [vocabulary](/docs/voice-packs/reference/vocabulary/) lists the case's keys. Record `flags/green-practice`, `flags/green-qualifying` and `flags/green-race` and swap the entry's sequence for the case.
- **Share it.** A pack is a folder; zip it and pass it on, and whoever receives it installs it the same way you did. It stays yours — see [Third-Party Voice Packs](/docs/features/race-engineer-voices/#third-party-voice-packs) for what that means and what it does not.
