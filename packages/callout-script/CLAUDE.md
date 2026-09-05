# @iracedeck/callout-script

The JSON grammar for Race Engineer voice-pack callout scripts (issue #1064): the shape of `voice/<voice-id>/callouts.json`, the Zod schema that validates it, a parser that never throws, and a walker that lists what a script references. Design record: `docs/superpowers/specs/2026-08-30-issue-1064-callout-scripts-in-voice-packs.md`.

**A leaf. `zod` is its only dependency, and that is the point.** The grammar has three consumers that must not depend on each other — the engine (`@iracedeck/audio-scenarios`) compiles against it, the pack scanner (`@iracedeck/deck-core`) validates with it, the generator and packer (`@iracedeck/audio-assets`) validate with it — so the contract lives where all three can reach it. Do not add a workspace dependency here; if this package needs something from another one, the something is in the wrong package.

## Modules (`src/`)

- `grammar.ts` — types and constants only, no zod. `ScriptStep`, `CalloutScriptEntry`, `FrameDefinition`, `PoolDefinition`, `FragmentDefinition` (#1065), `CalloutScript`, `CalloutScriptParseResult`; `CALLOUT_SCRIPT_SCHEMA_VERSION` (`1`), `NO_FRAME` (`"none"`) with `RESERVED_FRAME_NAME_MESSAGE` (the problem the schema reports when a script defines it — the generator's stricter frame-name rule reuses the same words), `CASE_DEFAULT_BRANCH` (`"default"`), `CONNECTOR_POOL` (`"connector"`), `CALLOUT_SCRIPT_MAX_DEPTH` (`64` — how deep a document may nest containers before the parser refuses it unread), `AMBIENT_ACTIONS`, `STEP_OBJECT_KEYS`; the patterns (`POOL_NAME_PATTERN`, `POOL_DEFINITION_NAME_PATTERN`, `SCENARIO_ID_PATTERN`, `NAME_PATTERN`, `COND_REFERENCE_PATTERN`) and the string-step prefixes; and two pure parsers every consumer shares rather than re-deriving: `parseStringStep` (the DSL's shorthand rules, non-throwing) and `parseCondReference` (`"!name"` → `{ name, negated: true }`).
- `schema.ts` — `ScriptStepSchema`, `CalloutScriptEntrySchema`, `FrameDefinitionSchema`, `PoolDefinitionSchema`, `FragmentDefinitionSchema`, `CalloutScriptSchema`, `parseCalloutScript(json)` and `parseCalloutScriptText(text)` — the one text stage every reader shares (BOM strip → `JSON.parse` → `parseCalloutScript`), so that the scanner, the packer and the harness cannot disagree about what is a readable script; each keeps only its own failure contract around it. The sub-schemas are exported so the generator can validate the authored `configs/<voice-id>.voice.json`'s `scenarios` / `frames` / `pools` / `fragments` keys one at a time.
- `paths.ts` — `CALLOUT_SCRIPT_FILE` and `calloutScriptPath(voiceId)` → `voice/<id>/callouts.json` (POSIX, relative to any audio root).
- `references.ts` — `collectScriptReferences(script)` → `ScriptReferences`: `scenarioIds`, `pools`, `vars`, `conds`, `cases` (with the keys each maps), `includes`, `frames`, and `fragments` — the names the script DEFINES, so a consumer can state the include rule as `includes ⊆ fragments` (#1065). Every list deduped and sorted; walks `then` / `else` / `optional` / every `of` branch, the frames' own `open` / `close`, and every fragment's `sequence` (a pool used only inside a fragment is still a reference). A `skip: true` entry contributes its id and nothing else — the compiler never reads past the skip, so a `frame` or a `sequence` left beside it is not a reference.

## The grammar in one screen

```jsonc
{
  "schema": 1,
  "scenarios": {
    "pit-crew.flag-green": {
      "comment": "…", "test": "…",        // prose; required in the BUNDLED pack by the completeness test, optional here
      "frame": "terse",                    // optional override of the contract's default; "none" = unframed
      "sequence": [                        // required unless "skip": true
        "pool:flags/green-race",           // string forms: "pool:<group>/<base>" | "pool:<name>" (a pools alias) | "pause:<ms>" | "@<fragment-name>" | "{{<var>}}" | a clip path
        { "clip": "flags/green-1.mp3" }, { "var": "position.number" }, { "pool": "flags/green-race", "noRepeat": false },
        { "connector": true }, { "pause": 300 }, { "include": "readback-body" },
        { "optional": [ "{{lapTime.minute}}" ] }, { "ambient": "start" },
        { "if": "!session.isRace", "then": [ "pool:pit-ack" ], "else": [ … ] },
        { "case": "session.type", "of": { "practice": [ … ], "race": [ … ], "default": [] } }
      ]
    },
    "pit-crew.flag-blue": { "skip": true } // deliberate silence, identical to an absent entry
  },
  "frames": { "terse": { "open": [ "tick-open.mp3" ], "close": [ "tick-close.mp3" ] } },
  "pools":  {                              // optional, and usually {}: a NAME only where it carries a decision
    "pit-ack": { "group": "pit-actions", "base": "acknowledgment", "comment": "its own no-repeat tracker, apart from acknowledgment/acknowledgment" }
  },
  "fragments": {                           // optional (#1065): a sub-sequence shared by several entries, included as "@<name>"
    "readback-body": { "comment": "the service list, read on entry and on exit", "sequence": [ "{{readback.fuel}}", { "pause": 300 } ] }
  }
}
```

A pool is all the takes of one line — every `voice/<voice>/<group>/<base>-NN.mp3` — and a step addresses it by that path: `pool:<group>/<base>` is the normal spelling, resolved against the manifest at fire time with the same members and no-repeat tracker either way. The `pools` key is an **alias facility**, not a catalogue: give a pool a name only when the name carries a decision — an alias onto a different group, or a second line that must not share a no-repeat tracker with the first — and say why in its `comment`. The bundled script names none; a name that would merely restate the path (`flag-green` → `flags/green`) is not written. An absent `pools` in the authored config extracts to `{}`.

**The only operator is `!`.** No `and`, `or`, comparisons, field access or arithmetic — a script needing `a && b` gets a named condition registered in code. Every future addition to the grammar has to argue against that line explicitly (spec, *The grammar*).

A **fragment** (#1065) is a sub-sequence the script defines once under `fragments` and includes from several entries — pit readback's body, read on entry and on exit, is the case it exists for. An include resolves ONLY within the same script: never a code scenario, never another voice's script. The engine inlines it at compile time, so the compiled body carries the fragment's steps in place and nothing is looked up at fire time; a fragment that reaches itself through any chain is refused with the chain named (`fragment cycle: a → b → a`), and an include of a name the script does not define is `unknown fragment "x"` — both skip that entry like any other unknown reference. Reach for a fragment only where a sub-sequence is genuinely shared; a `case` or a var is the tool for complexity inside one entry (spec, *What stays in code permanently*).

## Rules the schema enforces

- Every object is strict: an unknown key is a problem. `schema` exists so the format can evolve; it must be the literal `1`, and a higher number is reported as "written for a newer version of iRaceDeck".
- `sequence` is required unless `skip` is exactly `true`. `skip: false` is not a skip.
- A pool **reference** (a `pool` step, either form) matches `POOL_NAME_PATTERN` — lowercase kebab-case, optionally ONE slash: `group/base` is the direct addressing that nearly every step uses, the slash-less form names an alias. A pool **definition** name (a key of `pools`) matches `POOL_DEFINITION_NAME_PATTERN` — the same without the slash, because a defined name never carries one; that is what keeps the two namespaces from colliding.
- A `case`'s `of` needs at least one branch. `"default"` is an ordinary key of `of` to the schema; only `collectScriptReferences` treats it specially (it is not a declared key).
- `pause` is a non-negative finite number, in both forms. `ambient` is `start` | `stop` | `seek`. `connector` is exactly `true`.
- An `if` reference is an optional single `!` then a name; `"!!x"` and `"!"` are refused.
- Frame names, scenario ids, fragment names and vocabulary names are non-empty with no whitespace. A frame may not be **defined** as `"none"` — that name is reserved for "unframed" and is never looked up.
- An include is spelled `"@<fragment-name>"` (string form) or `{ "include": "<fragment-name>" }` (object form) and targets a fragment the SAME script defines; the name itself never starts with `@` — so `{ "include": "@x" }`, `"@@x"` and a fragment **defined** as `"@x"` are refused with the same two-spellings message, exactly as the DSL's `resolveStep` reads the two forms.
- A fragment's `sequence` may not be empty — deliberate silence is `skip: true` on the entry, and a fragment has no such word, so an empty one can only be an author who forgot to fill it in. `fragments` itself is optional in the grammar (absent means none, so no script written before #1065 has to change); the generator always emits the key. Cycles are refused and includes are inlined at compile time — by the engine's compiler, not by this package, which only parses.

**Keep `parseStringStep` (`src/grammar.ts`) in agreement with `parseStepShorthand` in `packages/audio-scenarios/src/dsl.ts`.** The two classify the same five string forms by the same prefix rules, and the engine will run scripts this package has validated, so a drift between them is a script that passes validation and then misbehaves at fire time. Exactly two divergences are deliberate, and both are narrowings on this side — the DSL admits what this package refuses, never the reverse: `"pause:"` is a problem here (the DSL reads `Number("")` as a zero pause), and `"{{}}"` is reported as an empty var (the DSL reads it as a clip path). Both are mistakes nobody means; the schema names them instead of letting them through. The agreement test lives in `audio-scenarios` beside the DSL, not here — this package cannot depend on the engine — so a change to either function is checked by that package's suite; a third divergence needs adding to that test AND to this paragraph.

## `parseCalloutScript` — what the caller owns and what it gets

Takes **already-parsed JSON** (`unknown`) and never throws. Turning text into JSON is `parseCalloutScriptText`'s job — the BOM strip (Windows editors write one, and hand-editing a pack is an advertised install path) and the `JSON.parse`, whose failure is reported as `(document): not valid JSON: <message>` — and every reader goes through it rather than parsing text itself. "Never throws" is kept by two guards the schema alone would not give: a document nested deeper than `CALLOUT_SCRIPT_MAX_DEPTH` containers is refused before the recursive step schema sees it (`(document): the script is nested too deeply to read` — a thousand nested `optional`s took zod past the call stack, reproduced against the built package), and anything the validator throws anyway is returned as a problem.

Problems are strings, one per thing to fix, in the form `<path>: <message>` with the path joined by `.` and array indices as `[n]` (`scenarios.pit-crew.flag-green.sequence[1].then[0].pause: must be a non-negative number of milliseconds`). The prefix is never empty: a non-object document reports under `(document)` — deliberately not a key name, which would point the author at a key that may be fine — a stray top-level key under its own name (`extra: unrecognized key`), and the version literal under `schema`. A missing key says `required — expected an array`; a wrong type says `expected an object, received null`; a message written in this package is kept verbatim. They are rendered in the settings window's Installed Voices problems list, so write any new one for the pack author, not for us.

**Why the step schema is a key dispatch and not a `z.union`.** A zod union that fails yields ONE `invalid_union` issue whose message is "Invalid input", with the real mistake buried among nine near-miss branches. The ten object forms are told apart by which key is present, so `ScriptStepSchema` looks at the keys (in `STEP_OBJECT_KEYS` order), picks the form, validates against THAT strict object and forwards its issues — so a bad `pause` is reported at `.pause` with the pause message, an extra key is named, and an object naming no form gets a message listing the ten. Keep it that way when adding a form: add the key to `STEP_OBJECT_KEYS`, the strict object to `STEP_FORMS`, the arm to `references.ts`, and a round-trip case to `schema.test.ts`.

## What `collectScriptReferences` does NOT include

`frames` lists only the `frame` overrides entries name, minus `"none"` — a contract's default frame is the engine's business, and the reserved word is not a reference. `fragments` is the one list that is not a reference at all but a definition set, kept beside `includes` so the two can be compared without a second walk. `cases[].keys` excludes `"default"` (`CASE_DEFAULT_BRANCH`). `pools` includes slashed `group/base` names as written — the common case, since that is the normal spelling; a consumer checking pools against a registry has to route those to the manifest instead (the engine's `pickFromPoolRef`), which is what the bundled-script completeness test does. It DOES include `"connector"` (`CONNECTOR_POOL`) whenever a `{ "connector": true }` step appears: the step names no pool in the file, but it draws from that one, and a consumer that never saw it would pass a voice with no connector clip.

## Conventions

- Tests beside every module (`foo.ts` → `foo.test.ts`); run with `pnpm exec vitest run packages/callout-script` from the repo root.
- The root `vitest.config.ts` aliases `@iracedeck/callout-script` to `src/`, so a consumer's tests run against the source, never a stale `dist/`. Typechecks still resolve through `dist/` — build this package before typechecking a consumer.
- Do not add this package to any plugin's rollup `external` list: no native code, bundles fine.
