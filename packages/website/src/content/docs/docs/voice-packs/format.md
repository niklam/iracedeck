---
title: The callouts.json Format
description: The grammar of a voice pack's callout script — where the file lives, its four maps, every step form, the reserved words, the rules the schema enforces, what a problem looks like, and what happens when the script is compiled.
---

A voice's callout script is one JSON file, `voice/<voice-id>/callouts.json`, inside the pack folder. This page is the grammar: every key the file may carry, every step form a sequence may use, and the rules iRaceDeck checks it against. For what a script can and cannot change, read [Voice Packs](/docs/voice-packs/) first; for the names a script may reference, the [vocabulary](/docs/voice-packs/reference/vocabulary/) and [callout](/docs/voice-packs/reference/callouts/) references are generated from the code.

## Where the file lives

A pack is a folder whose name is its id, holding `voice-pack.json`, the clips of each voice, and each voice's script beside its clips:

```text
my-pack/
├── voice-pack.json
└── voice/
    └── my-voice/
        ├── callouts.json
        ├── flags/
        │   ├── green-race-01.mp3
        │   └── green-race-02.mp3
        └── pit-window/
            └── opened-01.mp3
```

`voice-pack.json` names the pack and its voices. `id` values are lowercase kebab-case (`a-z`, `0-9`, dashes), the pack's `id` must equal its folder name, `version` is a semver string, `author` is optional, and every voice has an `id` — the `<voice-id>` in the paths above — and a display `label` of up to 60 characters:

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

Clips sit at `voice/<voice-id>/<group>/<name>.mp3` — one folder per group inside the voice folder, lowercase `.mp3`. A file one level too shallow (`voice/my-voice/sample.mp3`) or with an uppercase extension is dropped. The reason is listed under Installed Voices only when that leaves a voice with no playable clip at all; one stray `blue-01.MP3` among thirty good clips is dropped without a message anywhere, and `pnpm lint:pack` is what names it. Where the packs folder is and how a pack is installed by hand is on [Race Engineer Voices](/docs/features/race-engineer-voices/#installing-a-voice-pack-by-hand).

A voice with no `callouts.json` still loads: it is a clips-only voice, and every callout is skipped in it. When the file is there, it is read as UTF-8 — a leading byte-order mark, which some Windows editors write, is tolerated — and refused before it is parsed if it is larger than 1 MB, many times the size of the bundled script. A voice whose script exists but cannot be read, is too large, or fails the rules below is left out of the pack, with the reason listed; the pack's other voices still load.

## The file at a glance

```json
{
  "schema": 1,
  "scenarios": {
    "pit-crew.flag-green": {
      "comment": "The green flag, worded per session type.",
      "test": "Harness → Flags → Green, after choosing a session preset.",
      "sequence": [
        {
          "case": "session.type",
          "of": {
            "practice": ["pool:flags/green-practice"],
            "qualifying": ["pool:flags/green-qualifying"],
            "race": ["pool:flags/green-race"],
            "default": ["pool:flags/green-race"]
          }
        }
      ]
    },
    "pit-crew.pit-window-opened": { "sequence": ["pool:pit-window/opened"] },
    "pit-crew.flag-blue": { "skip": true }
  },
  "frames": {
    "radio": {
      "comment": "An open tick, the pit-lane ambience bed, a close tick.",
      "open": [{ "clip": "sfx/IRD-tick-open.mp3" }, { "ambient": "start" }, { "ambient": "seek" }],
      "close": [{ "ambient": "stop" }, { "clip": "sfx/IRD-tick-close.mp3" }]
    }
  },
  "pools": {},
  "fragments": {}
}
```

Four maps under a version number. `schema` must be the literal `1`; a higher number is reported as a script written for a newer version of iRaceDeck, so the format can evolve without an old plugin guessing at a file it does not understand. `scenarios` is required, as are `frames` and `pools` (an empty `{}` is fine for both); `fragments` may be left out entirely.

## `scenarios` — one entry per callout

The key is a callout id, exactly as the [callout reference](/docs/voice-packs/reference/callouts/) lists it (`pit-crew.flag-green`). An id has no whitespace. The entry:

| Key        | Required                      | What it is                                                                                                   |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sequence` | unless `skip` is `true`       | The steps spoken when the callout fires, in order.                                                          |
| `skip`     | no                            | `true` means say nothing for this callout, on purpose. Identical to leaving the entry out; `false` is not a skip. |
| `frame`    | no                            | Overrides the contract's default frame by name; `"none"` plays the body unframed.                           |
| `comment`  | no                            | What the entry says, for whoever reads the file next.                                                       |
| `test`     | no                            | How to hear it — the harness button, the in-sim situation.                                                  |

An entry for an id this version of iRaceDeck has no callout for is skipped with a warning in the log, unless it is a `skip: true` entry, which is honoured without comment whatever the id — so a pack may declare silence for a callout a later release adds.

## Steps

A `sequence` is an array of steps. A step is a string, or an object with exactly one of ten keys. The string forms are shorthands for the commonest object forms:

| String step                | Meaning                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `"pool:flags/green-race"`  | Play one take of the line `green-race` in the group `flags` — the normal way to play a line.   |
| `"pool:pit-ack"`           | Play one take of the pool the script defines under `pools` as `pit-ack`.                       |
| `"{{lapTime.second}}"`     | Play what the variable `lapTime.second` resolves to.                                           |
| `"pause:300"`              | Wait 300 milliseconds.                                                                         |
| `"@readback-body"`         | Include the fragment `readback-body` from this script's `fragments`.                           |
| `"flags/green-race-01.mp3"`| Anything else is a clip path, played as written (see [Clip paths](#clip-paths)).               |

The object forms, one example each:

| Object step                                                                   | Meaning                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ "clip": "flags/green-race-01.mp3" }`                                       | Play exactly this clip.                                                                                                                                                                   |
| `{ "var": "lapTime.second" }`                                                 | Play what the variable resolves to — a clip, or a pool it picks from. A variable that resolves to nothing aborts the callout, unless the step sits inside an `optional`, which is then dropped and the steps after it still play.                                                |
| `{ "pool": "flags/green-race", "noRepeat": false }`                           | Play one take of a pool. `noRepeat` defaults to `true`: the take played last time is avoided when there is more than one.                                                                |
| `{ "connector": true }`                                                       | Play one take of the pool named `connector` — a filler word between two phrases. The script must define that alias under `pools`; the bundled script uses no connectors.                  |
| `{ "pause": 300 }`                                                            | Wait that many milliseconds. Zero or more, finite.                                                                                                                                       |
| `{ "include": "readback-body" }`                                              | Include a fragment of this script. The name never starts with `@` here; the string form is where the `@` goes.                                                                           |
| `{ "optional": ["{{lapTime.minute}}"] }`                                      | Play the steps inside; if any of them resolves to nothing, drop the whole group and carry on with the rest of the callout.                                                                |
| `{ "ambient": "start" }`                                                      | Start, stop or seek the pit-lane ambience bed: `"start"`, `"stop"` or `"seek"`. Meaningful inside a frame; a body of ambience alone plays no callout.                                     |
| `{ "if": "readback.fuelQueued", "then": [ … ], "else": [ … ] }`               | Branch on a condition. `else` is optional. A leading `!` negates: `"if": "!readback.hasAnyService"`.                                                                                     |
| `{ "case": "session.type", "of": { "race": [ … ], "default": [ … ] } }`       | Branch on a case: the code resolves it to a key, and `of` maps keys to steps. `of` needs at least one branch; a key not in `of` takes `default`, or nothing when there is no `default`.  |

**The only operator is `!`**, once, in front of a condition name. There is no `and`, no `or`, no comparison, no field access and no arithmetic; a script that needs a compound condition gets a named one registered in the vocabulary. `"!!x"` and a bare `"!"` are refused.

Use `if` for a two-way choice and `case` for a many-way one. A variable answers "which clip"; a condition answers "whether"; a case answers "which of these branches".

### Clip paths

How a literal clip path is resolved depends on the callout's contract, and the [callout reference](/docs/voice-packs/reference/callouts/) says which under each callout's **Base**. Most contracts carry the base `voice/{voice}` and prefix the path with the active voice's folder, so `"flags/green-race-01.mp3"` plays `voice/<voice-id>/flags/green-race-01.mp3`; a few have no base and resolve it from the audio root as written, where no voice clip lives (the two spotter callouts and the qualifying invalidation today); and six carry `base: "pit-crew"` (the pit-limiter and no-limiter callouts), which prefixes `pit-crew/` from the root, a folder no shipped clip lives under either. A leading slash forces the root from anywhere — `"/sfx/IRD-tick-open.mp3"` is the plugin's own open tick whatever the callout. So use `pool:<group>/<base>` for anything you recorded — it means the same thing in every callout, and the pool grows when you add a take — and keep literal paths for the frame, which is expanded with no prefix at all: that is why the bundled frame writes `sfx/IRD-tick-open.mp3` plainly, and it is about the only place a script needs a literal path.

## `frames` — what a frame name means

A frame is `{ "open": [ … ], "close": [ … ] }` with an optional `comment`, and the engine plays `open` before a callout's body and `close` after it. The contract of every callout names a frame — `radio` for most, `none` for a handful whose cadence would not survive the beeps — and an entry may override it with `"frame": "<name>"`. Your script must define every frame name that any of its entries, or any contract it scripts, ends up using; the bundled frame above is the one to start from. `none` is reserved: it means unframed, it is never looked up, and a script may not define a frame by that name.

Every clip a frame plays goes on the sound-effects channel under the user's **Background** volume, whatever it is — a pack's own beep rides beside the built-in tick. The two user switches act on the frame's steps before any of them plays: with **Radio beeps** off every non-`ambient` step is dropped, with **Pit ambience** off every `ambient` step is. A frame that fails to compile takes every callout that uses it down with it, with the frame's own reason in the log, and a frame is only ever applied around a body that produced at least one clip.

## `pools` — aliases, and usually empty

A defined pool is `{ "group": "<group>", "base": "<base>" }` with an optional `comment`, keyed by a name without a slash: `"pit-ack": { "group": "pit-actions", "base": "acknowledgment", "comment": "its own no-repeat tracker, apart from acknowledgment/acknowledgment" }`. A step then plays it as `"pool:pit-ack"`. A defined name never carries a slash and a slashed reference always means `group/base`, so the two cannot collide.

Define a name only when it carries a decision — an alias onto a different group than the name suggests, or a second line that must not share a no-repeat tracker with the first — and say why in the comment. Otherwise address the line directly as `pool:<group>/<base>`; the bundled script defines no pools at all.

## `fragments` — sub-sequences shared between entries

A fragment is `{ "sequence": [ … ] }` with an optional `comment`, keyed by a name with no whitespace that does not start with `@`. Any entry or frame in the same script includes it as `"@<name>"` or `{ "include": "<name>" }`, and the engine splices its steps in place when the script is compiled — nothing is looked up at fire time. A fragment's `sequence` may not be empty; deliberate silence is `skip: true` on an entry, and a fragment has no such word. An include resolves only within the same script, never another voice's and never anything in code.

## Reserved words

- `none` — the frame name that means unframed. May be used in an entry's `frame`; may never be defined under `frames`.
- `default` — the branch a `case` falls back to when the resolver's key is not in `of`. An ordinary key to the schema; the reference pages do not list it among a case's declared keys.
- `connector` — the pool a `{ "connector": true }` step draws from. A script that uses the step defines it under `pools`.

## Rules the schema enforces

The whole file is validated before a voice loads, and a script that fails costs that voice only.

- Every object is strict: a key the grammar does not know is a problem, at the key's own path. A typo'd `sequnce` is reported as an unrecognized key beside a missing `sequence`.
- `schema` is the literal `1`.
- Every entry has a `sequence` unless its `skip` is exactly `true`.
- A pool reference is lowercase kebab-case with at most one slash (`flags/green-race` or `pit-ack`); a pool definition name is the same without the slash.
- Scenario ids, variable, condition and case names, frame names and fragment names are non-empty with no whitespace.
- A frame may not be defined as `none`. A fragment may not be defined with a name starting with `@`, and `{ "include": "@x" }` and `"@@x"` are refused with the same message.
- A `case`'s `of` has at least one branch, and no branch key is empty.
- `pause` is a non-negative finite number in both spellings; `"pause:"` with nothing after it is a problem, not a zero pause.
- `ambient` is `start`, `stop` or `seek`. `connector` is exactly `true`.
- An `if` reference is an optional single `!` followed by a name.
- A fragment's `sequence` has at least one step.
- A step object names exactly one of the ten forms; an object naming none is reported with the list of the ten.
- The document is a JSON object, nested no deeper than 64 levels of arrays and objects — a guard the parser applies before the schema runs, so a runaway nesting is refused before the validator sees it rather than crashing it.

## What a problem looks like

Problems are one line each, in the form `<path>: <message>`, with the path written the way you would find it in the file — keys joined by dots, array positions in brackets:

```text
scenarios.pit-crew.flag-green.sequence[1].then[0].pause: must be a non-negative number of milliseconds
scenarios.pit-crew.flag-blue.sequence: required unless "skip" is true
frames.none: "none" is reserved — it means unframed and can never be defined
extra: unrecognized key
(document): not valid JSON: Expected double-quoted property name in JSON at position 15 (line 1 column 16)
```

A problem at the document's root — the file is not JSON, or not an object — is reported under `(document)` rather than under a key that might be fine. In iRaceDeck Settings, under **Installed Voices**, the pack is listed with a line naming the voice and its first problem, prefixed by the file name: `voice "my-voice": callouts.json scenarios.pit-crew.flag-green.sequence[1].then[0].pause: must be a non-negative number of milliseconds`. That voice is left out until the file is fixed; the pack's other voices load. Fix it and press **Rescan voices**. `pnpm lint:pack` (see the [tutorial](/docs/voice-packs/first-pack/#lint-the-pack)) prints every problem at once.

## What happens when the script is compiled

A script that passes the schema is compiled against the callouts, variables, conditions, cases and frames this version of iRaceDeck knows, once per voice, whenever packs are scanned. The compiler never throws and never half-plays anything; a mistake costs exactly the entry that made it.

- An entry that names something the engine does not know — an unknown variable, condition, case, case key, pool alias, fragment or frame — is skipped, with one warning in the log naming the reference: `Voice "my-voice": scenario "pit-crew.flag-green" skipped — unknown var "lapTime.minutes"`. The callout is silent in that voice until the entry is fixed.
- An entry for an id this version has no callout for is skipped with the reason `no contract`; a `skip: true` entry is never warned about, whatever its id.
- A frame that fails to compile fails every entry that uses it, each with the frame's reason.
- A fragment that reaches itself through any chain of includes is refused with the chain named: `fragment cycle: a → b → a`. A fragment nothing includes is still compiled on its own, so a mistake inside it is reported by name rather than waiting for the first include.
- Expansion is budgeted: an entry or frame whose included fragments unfold to more than 2,000 steps is refused with `fragment expansion exceeds 2000 steps`. The largest body in the bundled script is about thirty.
- With debug logging on, the log also carries one line per voice — `Voice "my-voice": 3 of 149 callouts scripted` — and the list of ids that are not.

At fire time, a required step that resolves to nothing — a variable with no value for this moment, a pool the voice has no takes of, a clip that is not in the pack — aborts the whole callout rather than playing half a sentence, and says so at debug level: `Scenario "pit-crew.lap-time-best" skipped — var {{lapTime.minute}} resolved to nothing`. A step inside `optional` is the one exception: the optional group is dropped and the rest of the callout plays. A body that produces no clip at all gets no frame.
