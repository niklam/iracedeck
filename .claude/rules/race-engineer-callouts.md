---
paths:
  - "packages/event-bus/**"
  - "packages/sim-events-iracing/**"
  - "packages/audio-scenarios/**"
  - "packages/audio-assets/**"
  - "packages/callout-script/**"
  - "packages/scenario-harness/**"
  - "packages/deck-core/src/global-settings.ts"
  - "packages/iracing-actions/src/actions/pit-crew/**"
  - "packages/iracing-plugin-stream-deck/src/plugin.ts"
  - "packages/iracing-plugin-mirabox/src/plugin.ts"
  - "packages/iracing-plugin-ulanzi/src/plugin.ts"
---
# Race Engineer Callouts

How to add or modify a Race Engineer voice callout. This threads through seven packages — once you've done it, the per-package details below are checklist material.

## Architecture at a glance

```text
iRacing telemetry (TrackWetness, PitSvStatus, …)
        │
        ▼ diff module — `packages/sim-events-iracing/src/diff/<name>.ts`
@iracedeck/event-bus  ───────────────────────────────────►  publishes a SimEvent
        │                                                   on `IEventBus`
        ▼ contract `where:` predicate
@iracedeck/audio-scenarios  ─────────────────►  the CONTRACT decides whether and when
        │                                       (wrapped with master-gate + opt-in);
        │                                       the active voice's SCRIPT says what
        ▼ script entry → `pool:<group>/<base>` → `voice/<voice>/<group>/<base>-NN.mp3`
@iracedeck/audio-assets  ───────────────────►  `voice/<voice>/callouts.json` + clips
        │                                       (grammar: @iracedeck/callout-script)
        ▼ playback via `@iracedeck/audio-service`
Driver hears the line.
```

Seven layers, one direction. The **opt-in** wraps the contract's `where:` so a
toggle at the Property Inspector silences future fires without cutting an
in-flight clip; the **master gate** (`pitCrewRaceEngineerEnabled`) wraps every
voice callout as the outermost short-circuit.

**Since #1064 a callout is two artifacts that pair by id.** The **contract** (`ScenarioContract`, in code) decides *whether and when* the engineer speaks and how the fire is scheduled — `when` / `where`, `weight`, `family`, `interrupt`, `queueable`, `cooldown`, `channel`, `bus`, `base`, the default `frame` — and registers every var, condition and case a script may name. The **script** (a `scenarios` entry in the voice's `callouts.json`) decides *what* he says: the `sequence`, plus `comment`, `test`, an optional `skip` and an optional `frame` override. A pack references the vocabulary by name and can never define one, change when a callout fires, or change what it may interrupt — scheduling, pacing and triggers are withheld deliberately, because a pack that got them wrong would present as a plugin bug. **Absent means skipped:** a voice whose script has no entry for a contract is silent for it, at debug level, never an error. **Every family is scripted.** The flags went first (#1064) and #1065 moved the other 125 callouts across, one conditional step at a time; nothing in the catalog registers a `Scenario` (a contract with an inline `sequence`) any more — that type is an engine primitive the interpreter's tests use. A new callout, in an existing family or a new one, is a contract in code plus a script entry in the voice config, always both.

## Where things live

| Concern | File |
|---|---|
| **Voice lines (source of truth)** | `packages/audio-assets/configs/<voice-id>.voice.json` — canonical: `default.voice.json`; voices may differ in variant counts and omit callouts (issue #664); `src/generate/script-coverage.test.ts` holds each voice's script to its own clips — an authored clip in a group the script addresses that nothing references, or a reference to a clip nobody authored, fails (#1065, replacing the old parity guard) |
| **Callout script (source of truth)** | The same `configs/<voice-id>.voice.json`, under three keys beside `groups` (#1064): `scenarios` (contract id → `{ comment, test, sequence }`, or `skip: true`), `frames` (named open/close wrappers — `radio` is the default; `none` is reserved and can never be defined) and `pools` (pool name → `{ group, base, comment }` — an alias facility, optional and usually empty: a sequence addresses its clips directly as `pool:<group>/<base>`, and a name is given only where the name carries a decision). One authored file per voice, on purpose: it is what a pack author is handed |
| **Script artifact** | `packages/audio-assets/voice/<voice-id>/callouts.json` — the three maps under `schema: 1`, extracted by `pnpm generate:callout-scripts` and committed; `src/callout-scripts.test.ts` fails on drift naming the command. It lives inside the voice tree so it rides every path a voice travels: the plugin build copies it into `assets/audio`, the packer stages it beside the clips, the installer seeds it, the scanner reads it; `setScripts` hands the engine voice id → parsed script on every rescan, as `setManifest` does for clips |
| **Script grammar** | `packages/callout-script/` (`@iracedeck/callout-script`) — the `ScriptStep` / `CalloutScript` types, the Zod schema, the never-throwing `parseCalloutScript` and `collectScriptReferences`. A leaf package on `zod` alone, because the engine, the scanner and the generator all validate the same contract without depending on each other |
| **Script compiler + vocabulary registries** | `packages/audio-scenarios/src/script-compiler.ts` (`compileVoiceScript`, pure) and the engine's `defineVar` / `defineCond` / `defineCase` + `vocabulary()` in `interpreter.ts`; a family registers its own names in a `register<Family>Vocabulary(engine)` (`flag-alerts.ts` is the precedent) |
| **Bundled-script completeness test** | `packages/audio-scenarios/src/catalog/pit-crew/bundled-scripts.test.ts` — every contract the real `registerPitCrew` registers has an entry, no entry names an undeclared id, every entry has `comment` + `test`, every referenced pool / frame / var / condition / case key exists, every pool the script draws from — a `pool:<group>/<base>` reference, or a named pool it defines — has a clip for the bundled voice, and the whole catalog registers and compiles against the real `manifest.json` with no warning. The safety net JSON otherwise costs: deleting a TypeScript array entry breaks a test, deleting a JSON key would not |
| **Generated clips** | `packages/audio-assets/voice/<voice>/<group>/<name>.mp3` (gitignored locally; committed once stable) |
| **Generator cache** | `packages/audio-assets/generate.manifest.json` |
| **Runtime manifest** | `packages/audio-assets/manifest.json` (rebuilt by `generate:manifest`) — the BUILT-IN half only since #1034; installed voice packs add clips at runtime via `mergeManifests` + `IScenarioEngine.setManifest` |
| **Installed voice packs** | `%LOCALAPPDATA%\iRaceDeck\Race Engineer\Voices\<pack>\` — scanned by `deck-core`'s `createVoicePackService`; each pack is its own audio root, so its clips keep the same `voice/<id>/…` shape and every pool/validation path is unchanged (#1034) |
| **Bus event catalog** | `packages/event-bus/src/event-catalog.ts` |
| **Bus public exports** | `packages/event-bus/src/index.ts` (export new enums as values, not just types) |
| **iRacing translator** | `packages/sim-events-iracing/src/diff/<name>.ts` + wired into `translator.ts` |
| **Bundled track datasets (corner markers)** | `packages/track-data/` — committed snapshot + resolver + attribution constants; refresh via `scripts/refresh-corner-data.mjs` (issue #888) |
| **Translator state** | `packages/sim-events-iracing/src/state.ts` (TranslatorState type AND createInitialState — keep them in sync) |
| **Audio pools** | A script addresses its clips directly — `pool:<group>/<base>` — and names a pool (`pools` in `callouts.json`) only where the name carries a decision; the family's TypeScript file pins the `(group, base)` pairs in its literal `<FAMILY>_CLIP_SOURCES`. There is no code registry any more (`POOL_REGISTRY` emptied through #1064/#1065 and `pools.ts` was deleted). Members (`<base>-NN.mp3`) derive per-voice from the manifest at fire time (issue #664) |
| **Audio contracts** | `packages/audio-scenarios/src/catalog/pit-crew/<family>.ts` — the family's `ScenarioContract`s (or a `build<Family>Contract(getSnapshot)` builder where the `where:` reads a runtime resolver) and its `register<Family>Vocabulary(engine)` |
| **Family wiring (id type, key map, scenario id map, `PitCrewDeps` key)** | `packages/audio-scenarios/src/catalog/pit-crew/index.ts` |
| **Per-callout opt-in (Zod field)** | `packages/deck-core/src/global-settings.ts` |
| **Callout checkbox row** | `packages/pi-components/partials/race-engineer-callouts.ejs` (settings window only since #1003 — `pit-crew.ejs` carries no callout rows) |
| **Plugin closure (live-read)** | `packages/iracing-plugin-stream-deck/src/plugin.ts`, `packages/iracing-plugin-mirabox/src/plugin.ts`, AND `packages/iracing-plugin-ulanzi/src/plugin.ts` (byte-identical in code — mirror each other) |
| **Scenario-harness button** | `packages/scenario-harness/src/scenario-shortcuts.ts` |
| **Scenario-harness event template** | `packages/scenario-harness/src/event-names.ts` (compile-time completeness check enforces this) |

## Naming conventions

- **Per-callout opt-in setting key:** `callout<Polarity><Family><Subject>` (`.claude/rules/global-settings.md` is the canonical reference). Polarity is always `Enabled`; the schema field's *default* encodes the family's natural baseline (callouts default `true`). Examples: `calloutEnabledFlagYellowLocal`, `calloutEnabledTrackWetness`.
- **Scenario id:** `pit-crew.<family>-<subject>` — `pit-crew.flag-yellow-local`, `pit-crew.pit-status-too-far-left`, `pit-crew.track-conditions-worsening-mostly-dry`.
- **Pool:** every line is a pool — all the clips sharing one `(group, base)`, `voice/<voice>/<group>/<base>-NN.mp3` — so future variants are clip-file additions with no code change (issue #664). A script addresses one directly as `pool:<group>/<base>` (`pool:flags/blue`); that spelling IS the pool, and the `(group, base)` is published the moment a script uses it — renaming a base is a rename in every pack's script and clip folder. A pool gets a **name** only when the name carries a decision the path does not: an alias onto a different group, or a second line that must not share a no-repeat tracker with the first (`pit-action-acknowledgment` beside `acknowledgment`) — and then the reason goes in its `comment`. A name that would merely restate the path (`flag-blue` → `flags`/`blue`) is not written; the thirty flag pools that once had one do not any more, and no family that followed in #1065 named one either — the bundled script's `pools` is `{}`.
- **Vocabulary name (var / condition / case):** `<family>.<camelCaseName>` — `session.type`, `flag.furledStillShown`, `readback.tirePattern`, `lapTime.minute`. Names and their one-sentence descriptions are the public API of the script format (the generated reference, #1066, is built from `vocabulary()`), so pick them for a pack author who has not read the resolver. A `case`'s key set is declared with the registration, not inferred.
- **Voice clip path:** `voice/{voice}/<group>/<name>.mp3` — group keys the `groups` map in the voice config; name keys the entry inside the group.
- **Family identifier (for preemption):** matches the directory naming: `flag`, `damage`, `pit-status`, `track-conditions`. All contracts in a family share the same `family:` value, so a newer fire supersedes an in-flight one cleanly.

## Adding a new callout — checklist

When adding to an existing family (e.g. another flag colour) you skip steps 1–2 and the bus-side wiring; when introducing a brand-new family you do all of it. Step 4 has two halves since #1064 — 4a is the contract in code, 4b is the script entry in the voice config — and every callout does both: the contract decides whether and when, the script entry decides what is said, and neither exists without the other (a contract with no entry is silent; an entry with no contract is a warn and a skip).

**An SFX cue is not a scenario: it skips steps 3 and 4 entirely, and the scenario half of step 5** (issue #912, the first one). A cue that must react instantly plays direct from an imperative engine — `getAudio().playOnChannel(...)`, the `radar-engine.ts` model — instead of firing through the interpreter, so it has no voice lines, no pool, no scenario, no `SCENARIO_ID_TO_*` map and no `wrapCalloutScenario` loop. Step 5 therefore splits: its **wiring** half is still required — the `<Family>CalloutId` type, the `<FAMILY>_CALLOUT_SETTING_KEYS` map and the `registerPitCrew` parameter — while its scenario-registration half does not apply. It still needs everything else too: the bus event (1), the diff and state (2), the Zod field (6), the checkbox row (7), all three plugin closures (8), the fixtures (9) and the harness entries (10). The opt-in is read live inside the engine's own tick rather than by a scenario wrapper. Note what direct playback costs and buys: no weight, family or focus contest — so nothing to tune against other callouts, but equally no interpreter to keep it from overlapping one.

### 1. Define the bus event

In `packages/event-bus/src/event-catalog.ts`:
- If the event carries a sim-defined enum, define a **canonical enum** alongside `RadarState` / `FlagScope` / `PitServiceKind`. Use `export enum`, not just `export type`.
- Add a line to `SimEventMap`. Use `{ from, to }` for value-change events; `EmptySimEventPayload` for transition events with no payload.
- Export the enum from `packages/event-bus/src/index.ts` as a **value** (not just a type) so runtime consumers can reference it.

### 2. Translator diff + state

- Add fields to `TranslatorState` in `packages/sim-events-iracing/src/state.ts` (typically `<name>Initialized: boolean` + a `last<Name>` cache). **Update both the type AND `createInitialState()`** — TypeScript catches the mismatch only via `pnpm build` (vitest's esbuild path is more permissive).
- Write the diff module under `packages/sim-events-iracing/src/diff/<name>.ts`. Pattern: seed silently on first tick, advance baseline every tick, emit the bus event only on real transitions. Suppress sentinel-state transitions (Unknown ↔ x for track-wetness; * → None for pit-status).
- Wire into `translator.ts` `handleTick`.
- Add tests: first-tick seeding, single-step transitions, unchanged ticks, sentinel handling, invalid input handling.

### 3. Voice lines

In `packages/audio-assets/configs/default.voice.json` (other voices *may* add the same entries with their own wording, but don't have to — a voice without a clip skips that callout, issue #664; what `script-coverage.test.ts` insists on is that every clip a voice authors in a group its script addresses is referenced by that script, and everything the script references exists — #1065):
- Add (or extend) a group with one entry per `(direction × subject)` combination.
- Each entry: `name` (kebab-case, suffix `-01` so future variants append as `-02`), `text`, optionally `seed` (omit it on new entries — the generator defaults an omitted seed to `1` — or set `"seed": 1` explicitly; NEVER an arbitrary/random value, since the seed only selects which take ElevenLabs produces. Bump it deliberately for a different take when the generated clip doesn't sound right — the seed feeds the hash, so the change re-cuts only that clip), optional `previous_request_ids` to bias prosody continuity.
- Use `<break time="0.3s" />` for natural pauses inside a single line.
- Per-entry overrides for `model_id`, `language_code` (inside `voice_settings`), `output_format`, normalization flags etc. are supported and shallow-merge on top of the voice's defaults.

Generate the clips:

```bash
pnpm --filter @iracedeck/audio-assets generate:dry-run --group <group-name>  # preview: must list ONLY the new entries
pnpm --filter @iracedeck/audio-assets generate --group <group-name>          # only the new group
pnpm --filter @iracedeck/audio-assets generate:manifest                      # rebuild runtime manifest
```

Each `configs/<voice-id>.voice.json` is the per-voice source of truth — voices are self-contained, no cross-voice fallback. `generate.manifest.json` is the per-voice hash cache (keys include `voice/<voice-id>/…` so changing one voice's settings invalidates only that voice's entries). `manifest.json` is the runtime asset listing. The `--group` filter keeps the generator from re-cutting unrelated entries (and saves API cost); `--voice <id>` scopes to one voice. ElevenLabs is a paid API — never run unfiltered `generate` casually.

### 4a. The contract in code (pools, vocabulary, scheduling)

- Pools: there is nothing to declare in code — the script addresses the clips as `pool:<group>/<base>` (step 4b), naming a pool only where the name carries a decision, and the `(group, base)` joins the family's literal `<FAMILY>_CLIP_SOURCES`. The pool's members are derived per-voice from the manifest (`voice/<voice>/<group>/<base>-NN.mp3` plus the bare `<base>.mp3`, issue #836) at fire time, so adding a *variant* later is a clip-file change only. Single-member pools are deterministic; multi-member pools are sampled uniform-random with a per-pool no-immediate-repeat guard (the interpreter's `pickFromPool` — not a sequential rotation; the tracker resets on voice change). A named pool is looked up in the active voice's script; there is no code registry to fall back on since #1065.
- **Value-indexed clips are pools too (issue #836).** A `var` resolver returns `poolRef(group, base)` from `dsl.ts` (the `pool:<group>/<base>` reference form) instead of a raw clip path — position numbers, lap-time digits, temperatures, speeds, and names all resolve this way, usually as size-1 pools. There are **no hardcoded value ranges or clamps**: the clips that exist for the active voice define what's speakable, and a value with no clip skips its `optional` clause or aborts the callout (per #835). Keep `where:` predicates to null/known checks only — never numeric range checks.
- **Vocabulary.** Everything a script may name is registered in code, with prose, in a `register<Family>Vocabulary(engine)` the family exports and `registerPitCrew` calls before the registration loops (`registerFlagVocabulary` in `flag-alerts.ts` is the precedent):
  - `engine.defineVar(name, (ctx) => clipPathOrPoolRef | null, description)` — a value the script speaks with `"{{name}}"` / `{ var }`: a clip path or a `poolRef(group, base)`, `null` for "nothing to say".
  - `engine.defineCond(name, (ctx) => boolean, description)` — a yes/no the script branches on with `{ if: "name" }`; `"!name"` negates.
  - `engine.defineCase(name, (ctx) => key | null, { key: "what it means", … }, description)` — a multi-way choice the script maps with `{ case: "name", of: { key: […], default: […] } }`. **The key set is declared, not inferred** — it is what lets a pack author write the branch without reading the resolver, and what lets the compiler refuse a typo'd key. A resolver returning an undeclared key is a code bug (warned once) and takes the `default` branch; a `null` takes `default` too, and with no `default` the case says nothing.
  - Every resolver is a `VocabularyResolver<T>` (`dsl.ts`, #1065): it receives the `ScenarioContext` of the fire — `event`, `data`, `telemetry`, `now` — so a family can phrase a callout by WHY it fired (readback's opener reads the event's `reason`). `event` is `null` for an imperative `fire(id)`, so a resolver that reads it must tolerate that; a resolver that needs nothing from the fire is written as a zero-parameter function, which is assignable unchanged.
  - **Publish generously — more vars than our own script uses.** The vocabulary is exactly what bounds the phrasings a pack can express; a resolver is four lines and no runtime weight. Every description is one sentence written for the generated reference (#1066).
- Write the family file under `packages/audio-scenarios/src/catalog/pit-crew/<family>.ts`. Mirror `flag-alerts.ts` (a static contract list with a `case` and speak-time gates), `readback.ts` (a snapshot-driven body — the fifteen-way tire table as one declared-key `case`) or `pit-status.ts` (a family whose repeat nags hang on speak-time conditions). Each contract has:
  - `id: "pit-crew.<family>-<subject>"`
  - `family: "<family>"` (shared across the whole family — a newer same-family fire replaces the in-flight family-mate wholesale, regardless of weight)
  - `weight:` — omit for an ordinary callout (defaults to `WEIGHT.NORMAL = 50`). Use the named bands from `dsl.ts` (`WEIGHT.TRANSIENT = 5`, `CHATTER = 10`, `NORMAL = 50`, `SAFETY = 70`, `CRITICAL = 100`, `PROXIMITY = 120`; any integer allowed) so importance is a tunable number, not a fixed enum. Higher weight wins a busy bus. Flag callouts sit at `WEIGHT.SAFETY` (above routine chatter and a spotter focus floor); the meatball cut-through line is `weight: WEIGHT.CRITICAL` + `interrupt: true`. `PROXIMITY` (#867) is reserved for immediate-danger proximity information that must ALWAYS be heard — the spotter's transition calls are its only occupant; it sits strictly above CRITICAL because an equal-weight fire never cuts, and it pairs with `interrupt: true` + `queueable: false`. Don't put anything informational there: a repeating or non-danger line at PROXIMITY would chop up CRITICAL calls (that's why the spotter's "Clear."/still-there sibling stays at SAFETY).
  - `interrupt:` (default `false`) — `true` cuts an in-flight LOWER-weight fire mid-sentence; `false` waits for the current line to finish. Equal/lower-weight fires never cut. Reserve `interrupt: true` for safety-critical lines (meatball, fuel-critical) that must cut anything in flight.
  - `queueable:` (default `false`) — `true` defers a fire that can't take the bus now (equal/lower weight, or below a focus floor) for replay when the bus next idles; `false` drops it. Use it for background commentary that should wait its turn rather than vanish. The deferred fire replays unconditionally (its `where:` is NOT re-run — a `where:` that commits a side effect, like the position-readout cooldown claim, would fail on a second call); freshness comes from var resolvers reading live state at speak time.
  - `resumable:` (default `false`, requires `queueable: true` — validated at load time) — when an `interrupt` cuts this fire mid-playback, the idle-replay CONTINUES from the interrupted clip instead of re-firing from the top (issue #758). The replay re-expands the sequence first and falls back to a full fresh replay when the expansion changed while stashed (the #481 freshness guarantee). Only for deterministic sequences with side-effect-free `if:` predicates; the pit-service readback is the reference consumer.
  - `pendingHoldMs:` — after this fire finishes, hold the bus's pending replay for N ms so a displaced line doesn't stutter back into the gaps of a train of related fires (issue #758; the pit-box count-in marks are the reference consumer). A new fire taking the bus cancels the hold; it re-arms at that fire's finish.
  - `focusOwner:` (optional) — marks the scenario as belonging to an exclusive-focus owner. The engine's `acquireFocus(bus, ownerId, floorWeight)` / `releaseFocus(bus, ownerId)` raise a per-bus weight floor: while held, only fires with `weight` at or above the floor — or the owner's own (`focusOwner === ownerId`) — play; everything else defers (if `queueable`) or drops. Set the floor to the band you want to admit (e.g. `WEIGHT.SAFETY`). Releasing drains any deferred fire.
  - `frame:` — omit it. The engine wraps every callout whose body expanded to at least one clip in the walkie-talkie frame (`DEFAULT_FRAME`, `"radio"`: open tick, ambience bed, close tick — defined by the voice's script, not by code); `frame: NO_FRAME` (`"none"`) is for the four terse families whose cadence would have the beeps drown the words (pit-box count-in, pit-status nags, corner names, spotter), each stating why beside it. **A sequence never spells the frame** — the former `["@pit-crew.radio-open", …, "@pit-crew.radio-close"]` includes are gone (a sequence carrying them would be framed twice), and **an empty body gets no frame**: a speak-time gate (`{ if: …, then: [body] }`) that expands to nothing produces no bare ticks. The user's Radio beeps / Pit ambience switches are applied inside the frame by position — to its steps, before any expands, so a switched-off step can never abort a callout — and every clip a frame plays rides the SFX channel, a pack's own beep included. The frame expands before the body (a frame that aborts must not let a body condition's side effect commit), and its ops are tagged with their side, which is how the #758 resume re-keys with the frame's open rather than with a tick looked up by path.
  - `when: { event, where: (e) => …predicate… }`
  - No `sequence:` — a contract has none; its body is the script entry in step 4b. (The `Scenario` type that carries one is an engine primitive for the interpreter's tests, not a shape the catalog registers.)
- **Missing → skip the whole callout (issue #835).** At fire time every clip-producing step is checked against the manifest for the active voice; a required step that resolves to nothing (missing clip, null var, empty pool) aborts the entire callout — never a fragment, no cooldown stamped, and never cancelling an in-flight callout (the abort is decided before preemption). Wrap a genuinely-optional clause in `{ optional: [steps…] }` so it skips locally instead — use it only for self-contained add-on sentences (the setup-warning nudge, name greetings, the pit-speed / temperature / grid-position clauses, the incident point-count clause), never for a step mid-sentence.
- Export `<FAMILY>_CONTRACTS: readonly ScenarioContract[]`, plus `<FAMILY>_SCENARIO_IDS` and `<FAMILY>_CLIP_SOURCES: readonly { group, base }[]` — a **literal** list of the `(group, base)` sources its script addresses, since nothing derives it; the bundled voice must ship a clip for each and the bundled script must reference exactly that set (`[]` for a family that speaks only through var resolvers, as `lap-time.ts` does).
  - **Snapshot-driven variation (issue #558):** for a family whose lone contract reads a runtime resolver in its `where:` predicate — or whose vocabulary does — export `build<Family>Contract(getSnapshot)` and let `register<Family>Vocabulary(engine, getSnapshot)` close over the same resolver, **instead of** a static `<FAMILY>_CONTRACTS` array — the contract is materialized at wiring time inside `registerPitCrew()` — while still exporting `<FAMILY>_SCENARIO_IDS` / `<FAMILY>_CLIP_SOURCES`. See `session-start.ts`, `lap-time.ts` or `corner-name.ts` for the precedent; `readback.ts` is the same idea for a two-contract family.

### 4b. The script entry in the voice config

In `packages/audio-assets/configs/default.voice.json`, beside the `groups` you extended in step 3 — the same file, on purpose — add:

- Reference the clips as `pool:<group>/<base>` — the `(group, base)` from step 3, spelled in the step itself; there is nothing to declare. Give a pool a NAME under `pools` (`"<name>": { "group": "<group>", "base": "<base>", "comment": "…" }`) only when the name carries a decision — an alias onto a different group, or a second line that must not share a no-repeat tracker with the first — and then put the reason in its `comment`. A name that merely restates the path is not written.
- Under `scenarios`, keyed by the contract id:

```json
"pit-crew.<family>-<subject>": {
  "comment": "What it says and when — one or two sentences; this is the reference's text.",
  "test": "Harness → <Category> → <Button label>. In-sim: how to provoke it.",
  "sequence": ["pool:<group>/<base>"]
}
```

`comment` and `test` are **required in the bundled script** (the completeness test insists) because they are the source text of the published reference (#1066), not decoration; `test` names the harness button from step 10, so keep the label in sync. A callout the bundled voice deliberately does not speak carries `"skip": true` instead of a `sequence` — identical behaviour to an absent entry, but self-documenting and accepted by the completeness test as a declaration rather than an oversight. A `frame` override (`"none"`, or another frame the script defines) is the exception, not the rule.

The step grammar is the closure DSL's, serialised: `"pool:<group>/<base>"` (or `"pool:<name>"` for a named alias) / `{ pool, noRepeat? }`, `"{{var}}"` / `{ var }`, `{ clip }`, `{ pause }` / `"pause:<ms>"`, `{ include: "<fragment>" }` / `"@<fragment>"` (a sub-sequence the SAME script defines under `fragments`, inlined at compile time — #1065; cycles refused, an undefined name skips the entry), `{ optional: […] }`, `{ connector }`, `{ ambient }`, and the two branching forms — `{ "if": "<cond>", "then": […], "else": […] }` and `{ "case": "<case>", "of": { "<key>": […], "default": […] } }`. Use `if` for a binary choice and `case` for a multi-way one. Reach for a **fragment** only where a sub-sequence is genuinely shared between scenarios — the bundled script has two, `readback-body` (the entry and exit readbacks) and `gap-readout` (the gap family) — never to hide complexity inside one callout; `case` absorbed that job. Three rules govern what goes in one:

- **The only operator is `!`.** No `and`, no `or`, no comparisons, no field access, no arithmetic. A script needing `a && b` gets a named condition registered for it in 4a. This is what stops the format sliding into a predicate language one convenience at a time; every future addition to the grammar has to argue against it explicitly.
- **A lookup is a var; a condition is a choice.** A table over a closed set (the fifteen tire patterns, a session type) is not a script decision — it is a `case` with a declared key set, or a var, and the mapping stays in the script: with `case` a pack can collapse several keys onto one line or map a key to `[]` and stay silent, which a var returning the clip directly would take away. Writing the same thing as eighteen `if` blocks is the mechanical translation, and it is wrong.
- **A fragment may not be optional; a clause may.** `{ optional }` swallows a step that resolves to nothing, and whether that is correct depends on what is left behind: drop the number from "you're now P4" and the speech is broken or false; drop the tire clause from a readback and it is shorter and still true. So a whole clause may carry `{ optional }` or a `"default": []` branch, a sentence fragment never. (The lap-time minute is the boundary case, and it is a pack's *register* choice rather than a correctness rule — see the #1064 entry in the examples file.)

Then regenerate the artifact and commit it with the config:

```bash
pnpm generate:callout-scripts      # configs/*.voice.json → voice/<voice-id>/callouts.json
```

Other voices script the same ids in their own words, or leave them out — absent means skipped, and an unknown pool, var, condition, case key, include or frame skips that one callout for that voice with ONE warn naming the reference (never an exception, never a half-played line). Only the bundled voice is held to completeness.

### 5. Family wiring

In `packages/audio-scenarios/src/catalog/pit-crew/index.ts`:
- Add a `<Family>CalloutId` type union of subject ids.
- Add a `<FAMILY>_CALLOUT_SETTING_KEYS: Record<<Family>CalloutId, string>` map — the canonical id↔key map plugins read from.
- Add a `SCENARIO_ID_TO_<FAMILY>_ID` map covering every scenario id in the family.
- Add a `get<Family>CalloutEnabled?: (id: <Family>CalloutId) => boolean` key to `PitCrewDeps`, its `() => true` default to `DEFAULT_DEPS`, and the matching line to the destructure at the top of `registerPitCrew` (issue #1052). All three: the `satisfies` clause catches a key with no default, but nothing checks the destructure — a missing one surfaces as "cannot find name" wherever you use the closure. **Placement is irrelevant** — the deps are keyed, so position carries no meaning. There is no "masters last" rule to observe any more; putting the key next to its family's neighbours is a readability choice and nothing else.
- Wrap the family's contracts with `wrapWithMaster(wrapCalloutScenario(c, …))` in an `engine.defineContract(...)` registration loop. The family's `register<Family>Vocabulary(engine)` is called beside the other families' vocabulary registrations, before every loop, so the first `setScripts` compile sees every name.

### 6. Per-callout opt-in (Zod schema)

In `packages/deck-core/src/global-settings.ts`:
- Add a Zod field for each subject using the canonical pattern: `z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true").default(true)`. Default `true` for callouts (the family's natural baseline); see `.claude/rules/global-settings.md` for the polarity rationale.

### 7. Callout checkbox row

In `packages/pi-components/partials/race-engineer-callouts.ejs` — **not** `pit-crew.ejs`, which has carried no callout rows since #1003 moved every plugin-global setting into the settings window:
- Add (or extend) an `sdpi-item` for the family. The partial is items-only; the settings window wraps them in its "Callouts" card.
- Use the auto-balancing 2-column grid pattern already in the file: build the array of `{ setting, label }` once, then map to `<sdpi-checkbox>` rows. The grid template comes from `Math.ceil(items.length / 2)` so it scales without per-row maintenance.

### 8. Plugin closure (ALL THREE plugins)

In **all three** plugin entry points — `packages/iracing-plugin-stream-deck/src/plugin.ts`, `packages/iracing-plugin-mirabox/src/plugin.ts`, AND `packages/iracing-plugin-ulanzi/src/plugin.ts` (byte-identical in code — mirror each other):
- Import the `<FAMILY>_CALLOUT_SETTING_KEYS` map and `<Family>CalloutId` type.
- Add an entry to the `PitCrewDeps` object passed to `registerPitCrew`, keyed by the name you gave the dep, reading the setting **live on every event arrival**:

```ts
registerPitCrew(eventBus, {
  // …existing keys, in no particular order…
  get<Family>CalloutEnabled: (id: <Family>CalloutId) =>
    (getGlobalSettings() as Record<string, unknown>)[<FAMILY>_CALLOUT_SETTING_KEYS[id]] !== false,
});
```

Live-read (don't capture the value) — a mid-session toggle takes effect on the next event without re-registering scenarios.

### 9. Update test fixtures

- `packages/deck-core/src/simhub-service.test.ts` constructs an exhaustive `getGlobalSettings()` mock for every callout key — in **two** object literals (the main settings mock AND a second `.passthrough()`/round-trip literal further down). Add the new key to **both** or the type-check fails at build (`grep` the existing nearest key to find every literal).
- **Call sites of `registerPitCrew(...)` need no edit when you add a key** (issue #1052). Every one names what it passes, so a new `PitCrewDeps` key is simply absent from the ones that don't want it and takes its `DEFAULT_DEPS` entry. Adding a key cannot disturb an existing call site.
- **A new contract with no script entry fails `bundled-scripts.test.ts`** (audio-scenarios), and an edited config with a stale artifact fails `callout-scripts.test.ts` (audio-assets) — both name what is missing. Family tests that fire a scripted contract load the real artifact (`import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" }`) and hand it to `engine.setScripts(new Map([[voice, script]]))` AFTER `registerPitCrew`, as the plugins do — a contract with no script is silent, not unframed, so a test that forgets the artifact sees nothing fire.

  This used to be the most dangerous step on the page, and it is worth knowing why so nobody reinstates it. The parameters were positional and nearly all shared a shape, so inserting one shifted every later argument at every call site — and the result still type-checked, because a value landing in the wrong slot was usually assignable to it. It went wrong twice on 2026-08-28: once loudly, once silently and green. If you find surviving advice anywhere about adding `undefined` "at the new position" or keeping the masters last, it predates #1052 and is now wrong.

### 10. Scenario-harness shortcut

For QA convenience, add a button to `packages/scenario-harness/src/scenario-shortcuts.ts` so the harness UI can fire the event directly (bypassing the diff). Pick a `category` string — group related shortcuts under the same category for the UI. The script entry's `test` line (step 4b) names this button as `Harness → <Category> → <Label>`, so the two are written together.

If the bus event itself is **new**, also add an entry to `packages/scenario-harness/src/event-names.ts`. The compile-time completeness check forces this — `pnpm build` will fail otherwise.

### 11. Verify

```bash
pnpm install
pnpm generate:callout-scripts   # after any script edit — the freshness test names this command
pnpm build         # tsc — catches type-level issues vitest misses
pnpm test          # vitest — fast feedback loop
pnpm lint:fix
pnpm format:fix
```

Manual: trigger from the scenario harness (no iRacing required), then in iRacing for the real-telemetry path. Toggle the PI checkbox mid-session to confirm the live-read path silences future fires without cutting an in-flight clip.

## Reference implementations

Worked precedents — one per past callout, naming the pattern it established and the reusable lesson — live in `@.claude/rules/race-engineer-callout-examples.md`. Consult it when a new callout needs a variation the checklist doesn't cover (continuous-distance triggers, multi-class projection, replay gating, payload-extension cadence anchors, cause classification, self-managed running order, …). That file is scoped to the same `paths:` as this one, so it co-loads whenever you're working on callouts.

## Why these rules exist

- **Live-read closures** — a toggle taking effect mid-session is a hard requirement; capturing the value at registration time means re-registering scenarios on every settings change, which the engine can't safely do without dropping in-flight audio.
- **Per-subject opt-in keys** — a future addition gets `default: true` for every existing user via Zod's `.passthrough()`. Array storage and bitmask encodings break this property; per-item booleans don't (`.claude/rules/global-settings.md`).
- **Family preemption** — rapid same-family transitions (yellow→green at restart, TooFarLeft→TooFarRight while parking, MostlyDry→VeryLightlyWet→LightlyWet during a downpour) should never play back-to-back stale callouts. Sharing the `family:` string lets the engine cancel the older fire cleanly.
- **The contract/script split withholds scheduling, pacing and triggers from packs on purpose** (#1064) — with community packs dropped in a folder, a pack that demotes a safety flag below chatter, drops its `family`, or zeroes a `cooldown` produces behaviour that reads as a plugin bug; letting packs bind their own triggers would need a predicate language over telemetry, a public bus contract and a sandbox — five times the work, aimed at the half that does not vary by voice. Phrasing varies by voice; the moment does not.
- **Scripts can only name, never compose** — the `!`-only rule keeps the grammar a mapping rather than a language, so every branch a pack can take is a name the code declared with a description, and the generated reference (#1066) and the bundled completeness test can both be built from `vocabulary()` instead of from a hand-kept list.
- **The bundled script is tested for completeness, a third-party one is not** — silence is the right failure for a pack that omits a callout ("a pack is never punished for what it does not say") and the wrong one for ours, where an omitted JSON key would otherwise be invisible until a user asked why the engineer stopped mentioning the red flag.
- **Test fixtures must be exhaustive** — the deck-core simhub test constructs a typed object that must satisfy `GlobalSettings`. Forgetting a new key fails `pnpm build` (tsc strict), not `pnpm test` (vitest esbuild). Always run build before claiming green.
- **Pre-guard emissions need a non-transient discriminator** — anything published before the `IsReplayPlaying` guard in `translator.ts` (the `session.changed` paths, `driver.firstOnTrack`, and the #829 `diffStartCountdown`) survives replay-mode ticks by design, which is correct for live session transitions (#568) and for callouts that must reach an out-of-car driver (#829), but lets standalone replay viewing leak callouts unless the emission is also gated on a signal that distinguishes "live, transiently in replay mode" from "watching a replay." Use `isReplayOnlySession(sessionInfo)` — a read on `WeekendInfo.SimMode === "replay"` (issue #604). Do not gate on `IsReplayPlaying` — that's the transient #568 is explicitly bypassing. A pre-guard diff that keeps per-tick state must also have that state preserved by `wipeStateForReplay` (the #771/#829 preserved cluster), or the replay edges reset it mid-episode.
