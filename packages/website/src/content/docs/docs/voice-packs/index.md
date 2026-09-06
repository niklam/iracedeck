---
title: Voice Packs
description: What a Race Engineer voice pack is, what its callout script can change and what it cannot, why a correct script can be silent, and where the format, the tutorial and the reference pages are.
---

A voice pack is a folder: a `voice-pack.json` that names it, the recorded lines of one or more voices, and for each voice a **callout script** — `voice/<voice-id>/callouts.json` — that says how those lines are put together when the Race Engineer speaks. iRaceDeck ships one pack; anyone can build another and drop it into the voices folder. This section is for the person building one. If you only want to install or choose a voice, [Race Engineer Voices](/docs/features/race-engineer-voices/) is the page you need.

The short version: a pack decides **what is said**. It never decides **whether**, **when**, or **what may be interrupted** to say it.

## A correct script can be silent

The most confusing thing that will happen to you as a pack author is a script that is right in every detail and says nothing. It is worth understanding before anything else, because it is not a bug and nothing tells you about it.

Every callout is triggered by iRaceDeck's own code — a sim event arrives, and a gate written in code decides whether this callout is due. Your script entry is only consulted after that gate says yes. So an entry for the leader's final-lap warning is silent all through practice and whenever you are the leader, an entry for the pit-window callout is silent outside a race, and an entry that reads out a best lap is silent until a lap has been completed — not because the script is wrong, but because the moment never came. The same is true when you audition a callout in the scenario harness: firing the event with no matching sim state resolves the callout's variables to nothing, and the callout aborts before a clip plays.

When a callout stays quiet, the first move is always the same: open the [callout reference](/docs/voice-packs/reference/callouts/), find the id, and read its **description** (when it fires) and its **test** line (how to make it fire). Both come from the code and the bundled script, and both are more reliable than staring at your entry.

## Two halves: the contract and the script

Each callout is two artifacts that pair by id. The **contract** lives in iRaceDeck's code. The **script entry** lives in your pack.

| The contract — in code                                              | The script entry — in your pack                       |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| Which sim event triggers it, and the gate that decides it is due    | The sequence of clips, pauses and choices it speaks  |
| Its weight, its family, whether it may cut a quieter line          | A `comment` saying what it says                       |
| How often it may repeat, how long it waits after the trigger       | A `test` line saying how to hear it                   |
| Which audio channel it plays on                                     | `skip: true`, to say nothing on purpose               |
| Its default radio frame                                             | A `frame` override                                    |
| Every variable, condition and case a script may name                | —                                                     |

The split is deliberate. Scheduling stays with iRaceDeck so that no pack can demote a flag below chatter, drop the family that lets a stale callout be replaced by a newer one, or set a repeat interval to zero — every one of those would sound like a plugin bug to the person hearing it, not a pack bug. Triggers stay with iRaceDeck because the moment does not vary by voice; only the phrasing does.

What your script references — variables such as `{{lapTime.second}}`, conditions such as `readback.fuelQueued`, cases such as `session.type` — is a **vocabulary** registered in code and published for you in the [vocabulary reference](/docs/voice-packs/reference/vocabulary/). A script names things from that vocabulary; it can never define one. The vocabulary is the real public interface of the format; the JSON is only how it is spelled.

## Absent means skipped

A pack is never punished for what it does not say. A callout your script has no entry for is skipped in your voice — no error, no fallback to the bundled wording, nothing at all. `"skip": true` on an entry does exactly the same thing while saying so in the file.

That is what makes a first pack finishable. A pack with three entries is a valid pack that plays three callouts, and every other callout is simply quiet while that voice is selected. You can record an evening's worth of lines, hear them in the sim, and add a family at a time from there. The [tutorial](/docs/voice-packs/first-pack/) is built around exactly this.

The one thing to know is that the quiet is total. A pack that leaves a callout out does not borrow the bundled voice for it — an omitting pack would otherwise speak in two voices, and that was rejected on purpose. If you want a callout, you script it.

## Frames

Most callouts are wrapped in a **radio frame**: in the bundled voice, a tick as the channel opens, the pit-lane ambience running underneath, and a tick as it closes. The frame is not part of any callout's sequence. The contract names which frame a callout gets by default (`radio` for most, `none` for the terse ones — the pit-box count-in, the pit-status nags, the corner names, the spotter — where beeps would drown the words), and **your script defines what that name means** under `frames`. The engine wraps the body in it at fire time. An entry may override its contract's default with `"frame": "<name>"`, or `"frame": "none"` to play unframed.

Two user settings act on every frame: **Radio beeps** and **Pit ambience**, both on by default. With beeps off the engine drops every step of the frame that is not an `ambient` step; with ambience off it drops every `ambient` step. The rule is by position in the frame, not by clip, so a pack that uses its own beep clip is governed by the same switch as the built-in tick. And a frame only ever wraps speech: a callout whose body expands to nothing this time gets no frame, so nobody ever hears a pair of clicks around silence.

## Pools are the takes of one line

Every line you record is a **pool**: all the takes of it, `voice/<voice-id>/<group>/<base>-01.mp3`, `-02.mp3`, and so on. A step addresses a pool by that path — `"pool:flags/green-race"` — and the engine picks one take at fire time, avoiding the take it played last. Recording a second take of a line is therefore purely additive: add the file, and the pool grows.

The `pools` key in the script is an **alias facility**, not a catalogue. Give a pool a name only when the name carries a decision — it points at a different group than its name suggests, or a second line must not share a no-repeat tracker with the first — and say why in its `comment`. The bundled script names none; a name that merely restates the path is not written.

## Fragments

A **fragment** is a sub-sequence your script defines once, under `fragments`, and includes from several entries as `"@<name>"`. The bundled voice has two: the pit readback's body, read on entry and again on exit, and the gap readout shared by the two gap callouts. An include resolves only within your own script, and the engine splices it in when the script is compiled. Reach for a fragment only where a sub-sequence is genuinely shared between callouts; a `case` or a variable is the tool for complexity inside one.

## Two rules for writing a script

Both were found by writing the two hardest callouts out in full, and both exist because the obvious mechanical translation is wrong.

**A lookup is a variable; a condition is a choice.** Written literally, the tire slot of the pit readback becomes eighteen near-identical `if` blocks — one per tire pattern. That table is not a decision your script is making; it is a lookup over a closed set, and lookups belong in code. So `readback.tirePattern` is a **case**: the code resolves the pattern to a key, and your script maps keys to steps. You may map all four three-corner keys onto one line, or map a key to `[]` and say nothing about it. Use `if` for a two-way choice and `case` for a many-way one, and if you find yourself writing the same `if` ladder twice, the thing you want is probably a case or a variable that already exists in the [vocabulary](/docs/voice-packs/reference/vocabulary/).

**A fragment of a sentence may not be optional; a whole clause may.** An `optional` step swallows whatever inside it resolves to nothing. Whether that is right depends on what is left behind. Drop the number from "you're now P4" and the rest is broken; drop the tire clause from a readback and the readback is shorter and still true. So a position readout carries its number as a required step, and the readback's tire slot can carry a `"default": []` branch.

The lap-time minute is the instructive boundary, and it is a pack choice rather than a rule. The bundled voice gates the minute behind `{ "if": "lapTime.hasMinuteComponent", "then": ["{{lapTime.minute}}"] }`, so a 1:32.4 is read with its minute — "one minute, thirty-two, point four seconds" in the bundled wording — and a 0:34.8 without one. Dropping the minute altogether is a real racing convention — "thirty-two four" for a 1:32.4, the minute understood — so a terse pack may write `{ "optional": ["{{lapTime.minute}}"] }` instead. It only breaks where the assumed minute is not one: an 8:32.4 Nordschleife lap read as "thirty-two four" is nonsense. The format hands that decision to you rather than making it.

## The recording script

Because every clip a full pack needs is addressed by the bundled script or by a variable, the set of lines a complete pack records can be listed — and it is, on the [recording script](/docs/voice-packs/reference/recording-script/) page: every clip group of the bundled voice, every line in it with the text of each take, how many takes ship, and which callouts or variables draw from it. Read it as the shooting script for a full pack, and as the answer to "what do I record for the fuel family" for a partial one.

## Where to go next

- [Your first voice pack](/docs/voice-packs/first-pack/) — three callouts, three clips, and your own voice in the harness in an evening.
- [The `callouts.json` format](/docs/voice-packs/format/) — every key, every step form, the rules the file must satisfy, and what a problem looks like.
- [Callouts](/docs/voice-packs/reference/callouts/) — every callout: when it fires, how to hear it, and what the bundled entry references.
- [Vocabulary](/docs/voice-packs/reference/vocabulary/) — every variable, condition and case a script may name.
- [Recording script](/docs/voice-packs/reference/recording-script/) — every line a full pack records.

The reference pages are generated from iRaceDeck's own code and bundled script, and a test fails when they drift apart, so they always describe the version you are building against.
