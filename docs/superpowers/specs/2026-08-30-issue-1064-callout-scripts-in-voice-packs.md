> **Issue:** [#1064](https://github.com/niklam/iracedeck/issues/1064) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Callout scripts move into the voice pack

## The problem

A `Scenario` today welds together two things that change for entirely different reasons. `when` / `where` and the scheduling knobs decide **whether and when** the engineer speaks; `sequence` decides **what he says**. The first is telemetry logic that we tuned against real sessions. The second is wording, and wording is the whole substance of a voice pack.

Because they live in one object, a voice pack can only re-record lines we already wrote. It cannot add a callout, drop one, or change how a line is assembled — every one of those is a TypeScript edit in this repo. [#1034](https://github.com/niklam/iracedeck/issues/1034) will ship pack *distribution*, and a downloaded pack still would not be able to change a single word, because the scripts are compiled into the plugin binary.

The independent cost is maintainability: ~100 scenarios across ~50 files in `packages/audio-scenarios/src/catalog/pit-crew/`, in which the branching that picks a wording sits in the same object as the weight that decides what it can interrupt.

## The split

A scenario becomes two artifacts that pair by id.

| Owned by the code — the **contract** | Owned by the pack — the **script** |
| --- | --- |
| `when`, `where` | `sequence` |
| `weight`, `family`, `interrupt`, `queueable`, `resumable`, `pendingHoldMs` | `comment` |
| `cooldown`, `triggerDelay`, `focusOwner` | `test` |
| `channel`, `bus`, `base` | `skip` |
| the default `frame` | a `frame` override |
| every var, condition and case resolver | — |

A pack references the vocabulary by name and can never define one. It cannot change when a callout fires, and it cannot change what a callout may interrupt.

**Scheduling is withheld deliberately.** With community packs dropped in a folder, a pack that demotes a safety flag below chatter, or drops its `family` so a stale callout stops being replaced, produces behaviour that reads as a plugin bug rather than a pack bug. **Pacing is withheld for the same reason** — a `cooldown` of zero on a repeating callout is indistinguishable, from the user's side, from us shipping a spam bug.

**Triggers are withheld because the alternative is a different project.** Letting packs bind their own scenarios needs a declarative predicate language over telemetry, a stable public bus-event contract, and a sandboxing story — roughly five times this work. It is also not what packs need: the phrasing varies by voice, the moment does not.

## The grammar

The `Step` union is already ~90% serializable. `"pool:x"`, `{clip}`, `{pool, noRepeat}`, `{var}`, `{pause}`, `{include}`, `{optional}`, `{connector}` and `{ambient}` are JSON as they stand, and `"{{name}}"` is already the string shorthand for a var (`parseStepShorthand` in `dsl.ts`). Only the closures change. (`{ambient}` was missing from the first draft of this list; a pack-defined frame is the one place a script needs it — see *Frames*.)

- **`{ "if": "<cond>", "then": [...], "else": [...] }`** — the predicate becomes a registered name. A `!` prefix negates.
- **`{ "case": "<caseVar>", "of": { "<key>": [...], "default": [...] } }`** — new. The resolver returns a key; the script maps keys to steps.

**The line, and it is a rule rather than a preference: the only operator is `!`.** No `and`, no `or`, no comparisons, no field access, no arithmetic. A script needing `a && b` gets a named condition registered for it. This is what stops the format sliding into a predicate language one convenience at a time, and every future addition to the grammar has to argue against it explicitly.

`case` earns its place by removing nesting rather than adding power — the key still comes from code, the script only maps. `flag-green` is the smallest illustration:

```json
{ "case": "session.type", "of": {
    "practice":   ["pool:flag-green-practice"],
    "qualifying": ["pool:flag-green-qualifying"],
    "race":       ["pool:flag-green-race"] }}
```

against the nested `if`/`else` it replaces. Use `if` for binary choices and `case` for multi-way ones.

## The vocabulary

Three registries, all code-owned, all referenced by name:

- `defineVar(name, () => string | null, description?)` — resolves to a clip path or a pool reference. Exists today; gains an optional description.
- `defineCond(name, () => boolean, description)` — new, mirrors `defineVar`.
- `defineCase(name, () => string | null, keys)` — new. **The key set is declared**, not inferred: `keys` maps each key to a one-line description of what it means.

**Every registration carries prose, because the registries are the source of the generated reference** ([#1066](https://github.com/niklam/iracedeck/issues/1066)). The engine exposes what it holds — every var, condition and case with its description and key set — so the reference generator and `lint:pack` read the vocabulary from the same place the interpreter does, rather than from a hand-maintained list beside it.

**Declaring the key set is what makes `case` usable by anyone who has not read the resolver.** It is the source of the generated reference's branch list, it lets `lint:pack` flag a typo'd key, and it is what tells a pack author that `readback.tirePattern` has sixteen branches and what each one means. A `case` var without a published key set is a step nobody outside this repo can write.

**Publish generously — more vars than our own pack uses.** The published vocabulary is exactly what bounds the phrasings a pack can express. Ours decomposes a lap time into intro / minute / second / tenth, so a pack can reorder those or drop the intro, but cannot say "ninety-two point four" instead of "one thirty-two point four", because no `lapTime.totalSeconds` resolver exists. That is four lines and no runtime weight. **The vocabulary is the public API here; the JSON is only how it is spelled.**

## Two rules for writing a script

Both were found by writing the two hardest callouts out in full, and both exist because the obvious mechanical translation is wrong.

### A lookup is a var; a condition is a choice

Translating pit readback literally produces **eighteen near-identical `if` blocks** for the tire slot alone — two compound cases, the fifteen entries of `TIRE_PATTERN_CLIPS`, and a "no tires" fallback. That table is not a script decision. It is a lookup over a closed set, and lookups belong in code.

As a `case` with a declared key set, the whole callout is sixteen readable lines:

```json
"pit-crew.pit-readback-entry": {
  "comment": "Reads back queued pit service on entry — fuel, tires or compound, fast repair, windshield.",
  "test": "Harness → Pit service → readback requested, reason: entry, after setting a service snapshot. In-sim: queue fuel and two tires, then enter the pit lane.",
  "sequence": [
    { "if": "readback.limiterReminderDue", "then": ["pit-readback/opener-entry-limiter.mp3"] },
    { "if": "!readback.hasAnyService",
      "then": ["pit-readback/empty-fallback.mp3"],
      "else": [
        { "if": "readback.isFirstEntry", "then": ["pit-readback/opener-entry.mp3"] },
        { "if": "readback.fuelQueued",
          "then": ["pit-readback/fuel-on.mp3"],
          "else": ["pit-readback/fuel-off.mp3"] },
        { "case": "readback.tirePattern", "of": {
            "all":     ["pit-readback/tires-all.mp3"],
            "fronts":  ["pit-readback/tires-fronts.mp3"],
            "skip-lf": ["pit-readback/tires-three-corners.mp3"],
            "none":    ["pit-readback/tires-off.mp3"],
            "default": [] }},
        { "pause": 300 },
        { "if": "readback.fastRepairQueued",  "then": ["pit-readback/fast-repair-on.mp3"] },
        { "if": "readback.fastRepairSkipped", "then": ["pit-readback/fast-repair-off.mp3"] },
        { "if": "readback.windshieldQueued",  "then": ["pit-readback/windshield-on.mp3"] }
      ]}
  ]
}
```

**`case` rather than a var returning the clip directly, because the mapping is the pack's business.** A var returning `tires-all.mp3` would leave a pack forced to cut fifteen separate tire recordings. With `case` it can collapse all four three-corner keys onto one line, or map several keys to `[]` and stay silent about them. That difference is what makes a plausible first pack possible.

### A fragment may not be optional; a clause may

`{optional}` swallows a step that resolves to nothing. Whether that is correct depends on what is left behind:

> A step that is a **fragment of a sentence** must not be `{optional}`. A step that is a **whole clause** may be.

Drop the number from "you're now P4" or from "three point two seconds behind" and the remaining speech is broken or false. Drop readback's tire clause and the readback is shorter and still true. That is why the tire slot can carry a `"default": []` branch and a position readout cannot.

**Lap time is the instructive boundary case, and it is a pack choice rather than a rule.** `lap-time.ts` gates its minute clip behind `{ if: hasMinuteComponent }`, and my first reading was that dropping the minute always produces a false statement — "one thirty-two point four" degrading to "thirty-two point four". That is wrong, and Niklas corrected it: dropping the minute is a real convention in racing, the assumed minute is understood, and Crew Chief reads times back that way. It only breaks where the assumed minute is not 1 — an 8:32.4 Nordschleife lap read as "thirty-two four" is nonsense.

So the minute is not governed by the rule above; it is a phrasing decision with a range where it holds. Under this design that decision belongs to the pack: a terse pack writes `{ "optional": ["{{lapTime.minute}}"] }`, a careful one keeps the hard `if`. **Recorded because the mistake is the useful part** — a rule about correctness was being applied to something that was really a matter of register, and the format is better for handing it over instead of deciding it.

**Neither rule can be applied by a codemod.** Every conditional step in the catalog gets migrated on its own terms ([#1065](https://github.com/niklam/iracedeck/issues/1065)).

## Frames

`@pit-crew.radio-open` / `-close` appear in 35 sequences today and are presentation, not content. They become an engine-applied wrapper: the contract names each scenario's default frame, the pack defines what a frame means, and no sequence ever writes one.

**The frame is not merely a beep.** `radio-open` is `tick-open` plus `ambient: start` plus `ambient: seek`; `radio-close` is `ambient: stop` plus `tick-close`. Those two includes are the only thing in the codebase that ever starts or stops the pit-lane ambience bed. Anyone reasoning about removing "the beeps" is also reasoning about removing the ambience, and the two want separating rather than deleting.

**It is not universal today and the wrapper must preserve that.** Pit-box count-in (`pit-box.ts:8`), pit-status repeat nags (`pit-status.ts:41`), corner names (`corner-name.ts:5`) and spotter calls (`spotter-engine.ts:114`) all opt out, each with an inline reason amounting to *"at that cadence the beeps would drown the words"*. The contract carries `frame: "none"` for those, where those rationale comments already live.

**Two new settings**, because `backgroundVolume` currently governs the beeps and the ambience together and that coupling is the real complaint underneath "it should at least be behind an option": **Radio beeps** on/off (`raceEngineerRadioBeeps`) and **Pit ambience** on/off (`raceEngineerPitAmbience`), both default on, both read live at frame expansion through a closure injected into the engine, with `backgroundVolume` remaining the level control. The definition is by position in the frame, not by clip path: with beeps off the engine drops every non-ambient step of the frame, with ambience off it drops every `ambient` step. A frame that uses its own beep clip instead of the built-in ticks is therefore governed by the setting too.

**The wrapper lands for every family in this issue, not just the migrated one.** The two include strings come out of all 35 sequences, `radio-frame.ts` is deleted, and an un-migrated `Scenario` gets the same `frame` field as a contract (defaulting to `radio`, `none` on the four opt-outs). Keeping the includes alive beside the wrapper until [#1065](https://github.com/niklam/iracedeck/issues/1065) would have meant two frame mechanisms honouring the two settings two different ways for one release; one mechanism exercised by everything from day one is the cheaper thing to be right about.

**A frame wraps speech, so an empty body gets no frame.** The frame is applied only when the body expanded to at least one play op. This is what preserves the furled pair, whose speak-time predicate sits *inside* the frame today precisely so a stale fire produces no beeps, and it means no callout can ever play bare ticks around nothing.

Whether to retire the beeps entirely is explicitly **not** decided here. It is a product change of a different kind and deserves its own issue.

## Pools

`POOL_REGISTRY` (`pools.ts`, ~280 lines) moves into the pack config, one family at a time as each migrates — a pool named by the active voice's pack is looked up before the code registry, so the two coexist until [#1065](https://github.com/niklam/iracedeck/issues/1065) empties the latter. It is already pure data — `Readonly<Record<string, {group, base}>>` — and the prose it carries wants to be a `comment` field. The note explaining why `pit-action-acknowledgment` is a separate pool from `acknowledgment`, so their no-repeat trackers stay independent, is real knowledge currently reachable only by opening a TypeScript file.

Moving it also makes the alias layer pack-overridable, which is what lets a pack re-point `flag-blue` at its own group without rewriting every script that uses it.

**A pack may also address its own clip groups directly.** Today a `{ pool }` step resolves only through the registry, while `pool:<group>/<base>` works only when returned from a var resolver (the `var` case of `expandSequence` in `interpreter.ts`). Routing a slashed name in a pool step to the same `pickFromPoolRef` is a one-line change; registered names never contain a slash, so the namespaces cannot collide, as the doc comment on `pickFromPoolRef` already notes.

**Named pools stay the recommended form anyway**, because the name is the indirection that protects packs from our file layout. Reorganise `flags/` and every pack hardcoding `flags/blue` breaks, while every pack using `flag-blue` does not.

## Where it lives, and how it ships

Authored under new `scenarios`, `frames` and `pools` keys in `configs/<voice-id>.voice.json` — **one authored file per voice**, chosen over a sibling `<id>.scenarios.json` despite the two halves having genuinely different lifecycles. One file is what a pack author wants to be handed. (The first draft said "per pack"; the authored file has always been per *voice*, and a pack may carry several, so the script is per voice throughout.)

That file is generator-only today and never reaches the plugin, so `pnpm generate:callout-scripts` extracts just the runtime keys — `scenarios`, `frames`, `pools`, under a `schema: 1` header — into a committed artifact, `voice/<voice-id>/callouts.json`, guarded by a freshness test naming the command — the same pattern as `changelog.mdx → changelog.json` and `action-comms.json`. The 8,300-line `groups` block, the ElevenLabs voice id and the TTS settings never ship. The artifact lives *inside the voice tree* so that it rides every path a voice already travels with no extra wiring: the plugin build copies it into `assets/audio`, the packer stages it into the archive beside the clips, the installer's seed copies it into the packs folder, and the scanner reads it beside the clips it admits.

**Where the schema lives.** The grammar is a published contract with three consumers — the engine compiles against it, the scanner validates with it, the generator and packer validate with it — and no existing package can reach all three (`deck-core` does not depend on `audio-scenarios`, and must not grow a dependency on the Race Engineer to validate a file). So the types, the Zod schema and `parseCalloutScript` live in a new leaf package, `@iracedeck/callout-script`, whose only dependency is `zod`. `voice-pack.json`'s own schema stays in `deck-core` for now; moving it beside the script schema is a reasonable follow-up, not part of this issue.

**How it reaches the engine.** #1034 stage 2 shipped before this issue, so disk-scanned packs already exist and carry only clips. The scanner therefore reads `voice/<voice-id>/callouts.json` for every voice it admits, and the voice-pack service reads the same file for each bundled voice under the plugin's own audio root through the same file-system port — **one reader for both**, so that when #1034 stage 3 drops the bundle only the roots list changes. The service hands the engine a map of voice id → parsed script (`setScripts`); the engine compiles every voice's scripts against the contracts and vocabulary registered in code, and at fire time looks up the active voice's compiled script for the contract. `setScripts` runs on every rescan, exactly as `setManifest` does today.

## Skip semantics

The guarantee: **a pack is never punished for what it does not say.**

- **Absent from the pack → skipped.** One parameter-free `info` line per load (`Voice scripts loaded`), then per voice at `debug` the aggregate (`Voice "laconic": 62 of 104 callouts scripted`) and the individual ids. The first draft put the aggregate at `info`; `.claude/rules/logging.md` keeps parameters out of info lines, and the rule wins (decided 2026-09-04) — a support log needs debug logging on to show coverage, which is the same switch every other Race Engineer detail is behind. A hundred warn lines every start would itself be the loud failure this exists to avoid.
- **`"skip": true` → identical behaviour**, but self-documenting in the file and surviving the bundled-pack completeness check as a deliberate declaration rather than an oversight.
- **Unknown pool, var, condition, case key, include or frame → warn once, that scenario skipped.** Never an exception, never a half-played callout.
- **Missing clip at fire time → unchanged.** The #835 rule already does the right thing: a required step aborts the callout, an `{optional}` clause is skipped.
- **Malformed script JSON → that voice is dropped from its pack**, with a problem line in Installed Voices naming the file and the reason, exactly as a voice with no usable clips is dropped today. The unit is the voice rather than the whole pack because the script is per voice; a pack's other voices stay loadable, and the active voice falls back through `resolveActiveRaceEngineerVoice` as if the pack had never claimed it. No half-loaded voice.
- **No script file at all → a clips-only voice**, valid, whose callouts are all skipped. This is what a pack built for the #1034 stage-2 format is after this issue, and it is deliberate: the plugin still bundles `default` when this ships, so the only pack anyone can hold today is the one that gains its script here.
- **A `setWarning` banner** when the *active* voice has no loadable script; that mechanism exists and is run-scoped.

**Two audiences, one rule.** Silence is correct for a third-party pack and wrong for ours, so the bundled pack gets a build-time completeness test: every code-declared id has a script, no script names an id the code does not declare, and every entry carries `comment` and `test`. That test is the safety net JSON otherwise costs us — deleting a TypeScript array entry breaks a test today, and deleting a JSON key would not.

`comment` and `test` are required in the bundled pack because they are the **source text of the published reference** ([#1066](https://github.com/niklam/iracedeck/issues/1066)), not decoration.

## What stays in code permanently

The radar and pit-road-speeding engines play direct on `AudioChannel.Radar` and never touch the DSL. The `playVoiceSequence` callers — toggle acknowledgments and the SDK-connect radio check — bypass the scenario engine entirely. None of them are scenarios, and none are in scope.

**Fragments remain available** for sub-sequences shared across several scenarios, composed with `"@<id>"` (the string form carries the `@`) or `{ "include": "<id>" }` (the object form carries the bare id — the grammar refuses `{ "include": "@x" }` and `"@@x"` alike, so the two spellings cannot drift). A fragment is just a scenario with no `when` — exactly what the radio frame was before it became a frame, so this needs no new machinery. Note the shipped constraint: an include may target a fragment registered in code, and #1065 decides whether packs may define their own.

Worth recording that the case which motivated keeping them turned out not to need them. Pit readback was expected to require code-built slot fragments because of its fifteen-way tire table; once that table became a `case` with a declared key set, all four of its service slots sit in the script as ordinary steps and no fragment is involved. **`case` absorbed the job fragments were being held in reserve for**, and it did so while leaving the mapping with the pack rather than taking it into code. Fragments stay for genuine sharing between scenarios, not as an escape hatch for complexity within one.

## Rejected alternatives

- **A declarative predicate language over telemetry.** See "The split". Five times the work, and aimed at the half that does not vary by voice.
- **Pack-owned scheduling or pacing.** Breaks preemption in ways that present as plugin bugs.
- **A sibling `configs/<id>.scenarios.json`.** Honest about lifecycles, but two files per pack; the extraction step gets the same separation without splitting what an author edits.
- **Inheriting the default pack's script when a pack omits a callout.** Rejected deliberately: an omitting pack should not silently speak in the default voice. Absent means skipped.
- **A var returning the tire clip directly, rather than `case`.** Simpler, and it forces every pack to cut fifteen tire recordings.
- **`{ optional: [...] }` wherever a var can resolve to nothing.** Conflates "nothing to say" with "cannot say it". See "A fragment may not be optional".

## Scope

This issue delivers the seam plus the **flags family migrated as proof** — 24 scenarios exercising a `where`, nested branching and session-type dependence — and the frame wrapper for every family (see *Frames*). [#1065](https://github.com/niklam/iracedeck/issues/1065) migrates the rest and replaces `voice-parity.test.ts`; [#1066](https://github.com/niklam/iracedeck/issues/1066) documents the format and is the home of the per-callout Play button and `lint:pack` (decided 2026-09-04: the button's list is only complete after #1065, and the linter shares its introspection with the reference generator); [#1034](https://github.com/niklam/iracedeck/issues/1034) distributes packs.

**The archive changes, the version does not.** Adding `callouts.json` to the `default` archive changes its bytes, and the packer's rule is that a *published* version's bytes never change. `default` 1.0.0 is not published — the 3.2.0 tag run creates it — so the version stays 1.0.0 and `catalog/default.json` is regenerated (decided 2026-09-04). Had 1.0.0 been out, this would have been a bump.

**Ordering.** Decided 2026-09-04: this issue, then #1065, then #1066, all before #1034 stage 3 drops the bundle. While `default` is still bundled, the plugin root wins path resolution and voice-id collisions, so this format change ships inside the plugin binary and a stale seeded copy in AppData is inert. Dropped first, the same change would have become a mandatory network fetch at plugin-update time — and under "absent means skipped", an offline user would have updated into a silent engineer.
