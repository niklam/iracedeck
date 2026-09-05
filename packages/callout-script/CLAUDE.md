# @iracedeck/callout-script

The JSON grammar for Race Engineer voice-pack callout scripts (issue #1064): the shape of `voice/<voice-id>/callouts.json`, the Zod schema that validates it, a parser that never throws, and a walker that lists what a script references. Design record: `docs/superpowers/specs/2026-08-30-issue-1064-callout-scripts-in-voice-packs.md`.

**A leaf. `zod` is its only dependency, and that is the point.** The grammar has three consumers that must not depend on each other — the engine (`@iracedeck/audio-scenarios`) compiles against it, the pack scanner (`@iracedeck/deck-core`) validates with it, the generator and packer (`@iracedeck/audio-assets`) validate with it — so the contract lives where all three can reach it. Do not add a workspace dependency here; if this package needs something from another one, the something is in the wrong package.

## Modules (`src/`)

- `grammar.ts` — types and constants only, no zod. `ScriptStep`, `CalloutScriptEntry`, `FrameDefinition`, `PoolDefinition`, `CalloutScript`, `CalloutScriptParseResult`; `CALLOUT_SCRIPT_SCHEMA_VERSION` (`1`), `NO_FRAME` (`"none"`) with `RESERVED_FRAME_NAME_MESSAGE` (the problem the schema reports when a script defines it — the generator's stricter frame-name rule reuses the same words), `CASE_DEFAULT_BRANCH` (`"default"`), `CONNECTOR_POOL` (`"connector"`), `AMBIENT_ACTIONS`, `STEP_OBJECT_KEYS`; the patterns (`POOL_NAME_PATTERN`, `POOL_DEFINITION_NAME_PATTERN`, `SCENARIO_ID_PATTERN`, `NAME_PATTERN`, `COND_REFERENCE_PATTERN`) and the string-step prefixes; and two pure parsers every consumer shares rather than re-deriving: `parseStringStep` (the DSL's shorthand rules, non-throwing) and `parseCondReference` (`"!name"` → `{ name, negated: true }`).
- `schema.ts` — `ScriptStepSchema`, `CalloutScriptEntrySchema`, `FrameDefinitionSchema`, `PoolDefinitionSchema`, `CalloutScriptSchema`, and `parseCalloutScript(json)`. The sub-schemas are exported so the generator can validate the authored `configs/<voice-id>.voice.json`'s `scenarios` / `frames` / `pools` keys one at a time.
- `paths.ts` — `CALLOUT_SCRIPT_FILE` and `calloutScriptPath(voiceId)` → `voice/<id>/callouts.json` (POSIX, relative to any audio root).
- `references.ts` — `collectScriptReferences(script)` → `ScriptReferences`: `scenarioIds`, `pools`, `vars`, `conds`, `cases` (with the keys each maps), `includes`, `frames`. Every list deduped and sorted; walks `then` / `else` / `optional` / every `of` branch and the frames' own `open` / `close`.

## The grammar in one screen

```jsonc
{
  "schema": 1,
  "scenarios": {
    "pit-crew.flag-green": {
      "comment": "…", "test": "…",        // prose; required in the BUNDLED pack by the completeness test, optional here
      "frame": "terse",                    // optional override of the contract's default; "none" = unframed
      "sequence": [                        // required unless "skip": true
        "pool:flag-green-race",            // string forms: "pool:<name>" | "pause:<ms>" | "@<scenario-id>" | "{{<var>}}" | a clip path
        { "clip": "flags/green-1.mp3" }, { "var": "position.number" }, { "pool": "flag-green", "noRepeat": false },
        { "connector": true }, { "pause": 300 }, { "include": "pit-crew.some-fragment" },
        { "optional": [ "{{lapTime.minute}}" ] }, { "ambient": "start" },
        { "if": "!session.isRace", "then": [ … ], "else": [ … ] },
        { "case": "session.type", "of": { "practice": [ … ], "race": [ … ], "default": [] } }
      ]
    },
    "pit-crew.flag-blue": { "skip": true } // deliberate silence, identical to an absent entry
  },
  "frames": { "terse": { "open": [ "tick-open.mp3" ], "close": [ "tick-close.mp3" ] } },
  "pools":  { "flag-green-race": { "group": "flags", "base": "green-race", "comment": "…" } }
}
```

**The only operator is `!`.** No `and`, `or`, comparisons, field access or arithmetic — a script needing `a && b` gets a named condition registered in code. Every future addition to the grammar has to argue against that line explicitly (spec, *The grammar*).

## Rules the schema enforces

- Every object is strict: an unknown key is a problem. `schema` exists so the format can evolve; it must be the literal `1`, and a higher number is reported as "written for a newer version of iRaceDeck".
- `sequence` is required unless `skip` is exactly `true`. `skip: false` is not a skip.
- A pool **reference** (a `pool` step, either form) matches `POOL_NAME_PATTERN` — lowercase kebab-case, optionally ONE slash for direct `group/base` addressing. A pool **definition** name (a key of `pools`) matches `POOL_DEFINITION_NAME_PATTERN` — the same without the slash, because registered names never carry one; that is what keeps the two namespaces from colliding.
- A `case`'s `of` needs at least one branch. `"default"` is an ordinary key of `of` to the schema; only `collectScriptReferences` treats it specially (it is not a declared key).
- `pause` is a non-negative finite number, in both forms. `ambient` is `start` | `stop` | `seek`. `connector` is exactly `true`.
- An `if` reference is an optional single `!` then a name; `"!!x"` and `"!"` are refused.
- Frame names, scenario ids and vocabulary names are non-empty with no whitespace. A frame may not be **defined** as `"none"` — that name is reserved for "unframed" and is never looked up.
- An include is spelled `"@<scenario-id>"` (string form) or `{ "include": "<scenario-id>" }` (object form), and the id itself never starts with `@` — so `{ "include": "@x" }` and `"@@x"` are refused with the same two-spellings message, exactly as the DSL's `resolveStep` reads the two forms.

**Keep `parseStringStep` (`src/grammar.ts`) in agreement with `parseStepShorthand` in `packages/audio-scenarios/src/dsl.ts`.** The two classify the same five string forms by the same prefix rules, and the engine will run scripts this package has validated, so a drift between them is a script that passes validation and then misbehaves at fire time. Exactly two divergences are deliberate, and both are narrowings on this side — the DSL admits what this package refuses, never the reverse: `"pause:"` is a problem here (the DSL reads `Number("")` as a zero pause), and `"{{}}"` is reported as an empty var (the DSL reads it as a clip path). Both are mistakes nobody means; the schema names them instead of letting them through. The agreement test lives in `audio-scenarios` beside the DSL, not here — this package cannot depend on the engine — so a change to either function is checked by that package's suite; a third divergence needs adding to that test AND to this paragraph.

## `parseCalloutScript` — what the caller owns and what it gets

Takes **already-parsed JSON** (`unknown`) and never throws. Turning text into JSON is the reader's job — and so is stripping a UTF-8 BOM first, as `parseVoicePackManifest` in deck-core does, because Windows editors write one and hand-editing a pack is an advertised install path.

Problems are strings, one per thing to fix, in the form `<path>: <message>` with the path joined by `.` and array indices as `[n]` (`scenarios.pit-crew.flag-green.sequence[1].then[0].pause: must be a non-negative number of milliseconds`). The prefix is never empty: a non-object document reports under `(document)` — deliberately not a key name, which would point the author at a key that may be fine — a stray top-level key under its own name (`extra: unrecognized key`), and the version literal under `schema`. A missing key says `required — expected an array`; a wrong type says `expected an object, received null`; a message written in this package is kept verbatim. They are rendered in the settings window's Installed Voices problems list, so write any new one for the pack author, not for us.

**Why the step schema is a key dispatch and not a `z.union`.** A zod union that fails yields ONE `invalid_union` issue whose message is "Invalid input", with the real mistake buried among nine near-miss branches. The ten object forms are told apart by which key is present, so `ScriptStepSchema` looks at the keys (in `STEP_OBJECT_KEYS` order), picks the form, validates against THAT strict object and forwards its issues — so a bad `pause` is reported at `.pause` with the pause message, an extra key is named, and an object naming no form gets a message listing the ten. Keep it that way when adding a form: add the key to `STEP_OBJECT_KEYS`, the strict object to `STEP_FORMS`, the arm to `references.ts`, and a round-trip case to `schema.test.ts`.

## What `collectScriptReferences` does NOT include

`frames` lists only the `frame` overrides entries name, minus `"none"` — a contract's default frame is the engine's business, and the reserved word is not a reference. `cases[].keys` excludes `"default"` (`CASE_DEFAULT_BRANCH`). `pools` includes slashed `group/base` names as written; a consumer checking pools against a registry has to route those to the manifest instead (the engine's `pickFromPoolRef`). It DOES include `"connector"` (`CONNECTOR_POOL`) whenever a `{ "connector": true }` step appears: the step names no pool in the file, but it draws from that one, and a consumer that never saw it would pass a voice with no connector clip.

## Conventions

- Tests beside every module (`foo.ts` → `foo.test.ts`); run with `pnpm exec vitest run packages/callout-script` from the repo root.
- The root `vitest.config.ts` aliases `@iracedeck/callout-script` to `src/`, so a consumer's tests run against the source, never a stale `dist/`. Typechecks still resolve through `dist/` — build this package before typechecking a consumer.
- Do not add this package to any plugin's rollup `external` list: no native code, bundles fine.
