# Race Engineer: one clip set for several spellings of a name

> **Issue:** [#1580](https://github.com/niklam/iracedeck/issues/1580) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `2d3f6229f`.

## The problem

A driver name is a slug, and a slug is five clips per voice: one entry in each of `names`, `session-start-greeting`, `race-start-greeting`, `race-end-greeting` and `position-overtake-come-on`, in `configs/default.voice.json` and in `configs/shawn.voice.json` (109 names in each today). The dropdown lists every slug that has a `names/` clip in any installed voice (`scanDriverNames`, `packages/audio-scenarios/src/manifest.ts:89`), the setting stores the slug picked (`driverName`, `packages/settings/src/global-settings.ts:376-384`), and the greeting vars play `poolRef(<group>, <slug>)`. So a spelling that sounds like another one still costs five clips per voice, and the two sets drift apart the first time one is re-cut. Dominic and Dominik have shipped as two sets since #1118, #1579 adds Geoff beside Jeff with identical text, and #941 (calling other drivers by name) would multiply this, because iRacing first names come in many spellings of one spoken name.

Niklas settled the user-facing behaviour in the issue (2026-11-01): one clip set per spoken name; each alias is its own row in the Your Name dropdown, sorted with the other names; the setting keeps the spelling picked and is resolved at speak time.

## Decisions

### 1. One shared map in `@iracedeck/callout-script`, not per voice pack

The map is a committed module of the plugin, `packages/callout-script/src/driver-name-aliases.ts`, exported from the package index beside `stripTakeSuffix` (`packages/callout-script/src/coverage.ts:131`), which is the other rule that folds a stored name onto the slug it is spoken under. `callout-script` is the right home because it is the zod-only leaf that the map's readers already reach: `audio-scenarios` (the resolver, the name list and the pack reference), the `audio-assets` generator and tests, and the repo scripts behind `lint:pack` and the pack reference, which already import it (`scripts/lib/lint-pack-scanner-parity.test.mjs`). The Property Inspector does not need it (decision 3), and neither does `@iracedeck/settings` (decision 4, step 1). The package's header (`packages/callout-script/src/index.ts:1-13`), its `package.json` description and its `CLAUDE.md` gain the driver-name rules beside the grammar and the pack format's rules, since the map is part of how a pack's clips are read.

Equivalence of spellings is a fact about the name, not about the voice: Geoff is said "Jeff" by the people called Geoff, whichever engineer says it. So one list serves every voice, and a third-party pack that records `jeff` serves Geoff users with no work of its own. That is also the shape #941 needs, where the spellings come from the field rather than from a pack author's list.

A third-party pack cannot add aliases in this change. Its escape hatch is the precedence rule in decision 4: a voice that records the alias spelling itself (`dominik`) plays its own clips, so a pack whose language says the two names differently records both and is never overridden. Pack-supplied aliases stay possible later as an additive script key gated by `minPluginVersion`; nothing here forecloses them.

Pack authors are told, because a rule they cannot see makes a pack whose `dominik` clips are silently unnecessary, or a pack author who thinks Geoff users cannot be served. The `names` row of `PLUGIN_PLAYED_CLIPS` (`scripts/lib/lint-pack-run.mjs:113-121`) builds its `playedBy` text from `DRIVER_NAME_ALIASES` instead of hard-coding it, and that text now says three things: the names a pack ships, plus every alias whose canonical it ships, are the names its users can be called by; the aliases, listed; and a voice that records an alias spelling plays its own clips for it. Today's sentence ("The names a pack ships are the names its users can be called by") stops being true and is replaced. The text reaches the generated recording-script page through `playedBy` as it does now, so the website mirrors no list. The format page (`packages/website/src/content/docs/docs/voice-packs/format.md`) states the precedence rule in prose and points at that page for the list.

A voice that records neither the alias nor its canonical behaves as it does today for any name it lacks: the dropdown row exists if another installed voice records the canonical, and in this voice the greeting clauses are skipped (they are `optional` in the bundled scripts) and the path-played lines fail to start, as `driverNameClipPath` documents (`packages/audio-scenarios/src/catalog/pit-crew/driver-name-clip.ts:16-27`).

### 2. Format: a flat alias → canonical map, validated by tests and the generator

```typescript
export const DRIVER_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  dominik: "dominic",
  geoff: "jeff",
  kris: "chris",
});
```

Each key is an alias slug, each value the canonical slug whose clips it plays. Flat rather than canonical → list, so "an alias names exactly one canonical" is structural, and a repeated key is a TypeScript error in an object literal. Entries are sorted by key.

The same module exports the groups a driver name is spoken from, so no consumer keeps its own list of them:

```typescript
export const DRIVER_NAME_GROUPS = Object.freeze([
  "names",
  "session-start-greeting",
  "race-start-greeting",
  "race-end-greeting",
  "position-overtake-come-on",
] as const);
export type DriverNameGroup = (typeof DRIVER_NAME_GROUPS)[number];
```

`names` is the group whose clips define whether a voice records a name (decision 4); the other four are the greeting groups the vars draw from.

`validateDriverNameAliases(map)` in the same module returns every problem, one per entry, and the committed map must return none:

- Both sides are name slugs: lowercase ASCII letters and digits, optionally joined by single hyphens, and not ending in a take suffix (`TAKE_SUFFIX`, `coverage.ts:128`), since a stored `-NN` is folded off before the map is read.
- An alias is not its own canonical.
- No chains: no canonical is also a key. Resolution is one hop, so a chain would be a second hop nobody follows.
- No alias equal to a canonical: the same rule from the other side, stated so the message names the entry that breaks it.

Two more rules depend on the first-party voices, so they live in an `audio-assets` test over `configs/*.voice.json` for every voice in `VOICE_PACKS` (`packages/audio-assets/src/build/voice-packs.mjs:67-88`): every canonical has an entry in each group of `DRIVER_NAME_GROUPS` in every first-party voice, and no alias has an entry in any of them. The generator refuses an entry whose name is an alias in any group of `DRIVER_NAME_GROUPS`, in the same place it refuses a dash in clip text (#1518), so a future batch that re-adds `geoff` fails at the dry run rather than after a paid generation.

Neither `lint:pack` nor the voice-pack scanner validates the map: packs carry none, and a pack that records an alias spelling is legal by decision 1.

### 3. The dropdown: the plugin publishes alias rows in `_driverNames`, the PI is unchanged

A new `selectableDriverNames(manifest)` in `packages/audio-scenarios/src/manifest.ts` returns the names any installed voice records under `names/` (today's `scanDriverNames` fold, takes onto their base) plus every alias whose canonical that set contains, deduplicated (a pack recording `dominik` and the alias give one row) and sorted the way `scanDriverNames` sorts today. Slugs are ASCII lowercase, so that order is alphabetical, and an alias sits among the names rather than beside its canonical.

It is the only exported producer of the name list, so no consumer can publish a list without the alias rows. All four producers switch to it: the plugin's startup state and its rescan (`packages/plugin-runtime/src/phases/voice-packs/scan.ts:87`, `:234`), which publish it as `_driverNames` (`scan.ts:159-164`) and hold it as the Race Engineer's `driverNames` state, and the scenario harness's settings seed and its wiring (`packages/scenario-harness/src/bootstrap-settings.ts:54`, `:64`; `packages/scenario-harness/src/race-engineer-wiring.ts:32`). `scanDriverNames` leaves the package index (`packages/audio-scenarios/src/index.ts:39`) and becomes the module's private union step; the two plugin-runtime tests that stub it by name (`scan.test.ts:74`, `voice-packs.test.ts:55`) stub `selectableDriverNames` instead. The resolver does not use the union at all (decision 4). The comment at `scripts/lib/lint-pack-run.mjs:58`, which says the radio check's name resolves "from the union of every installed voice's names (`scanDriverNames`; …)", is rewritten to say the choice is made from `selectableDriverNames` and the clip from the active voice's own names.

`_driverNames` keeps its meaning, "the names a user can pick". `ird-name-select` renders each entry as a row whose value is the slug and whose label is the title-cased slug (`packages/pi-components/src/components/name-select.ts:176-187`), so the Geoff row is labelled "Geoff" and stores `geoff`, with no change to the component. Its take fold and its persist-only-when-empty fallback (`name-select.ts:189-226`) apply to alias rows unchanged. The row appears only while some installed voice records the canonical, which is the existing availability rule applied to the canonical. If #929's Callsigns / Names grouping lands, an alias row belongs under Names.

### 4. The resolver: one function at the clip boundary, per active voice

```typescript
export function resolveDriverNameSlug(
  spelling: string,
  recorded: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>> = DRIVER_NAME_ALIASES,
): string | null;
```

Pure, in `driver-name-aliases.ts`: `spelling` when the voice records it, else the alias's canonical when the voice records that, else `null`. `recorded` is the active voice's own `names/` bases, never the union across voices. With the union, a stored `dominik` would resolve to itself whenever any installed pack records `dominik`, and the default voice, which no longer does, would then skip every greeting. The `names/` group decides for all five lines, so one name is always spoken from one clip set.

Resolution is two steps, and only the second is new:

1. **The setting → a spelling.** `resolveActiveDriverName` (`global-settings.ts:2049-2067`) keeps its code and its job: the stored value if it is in the selectable list, else its take base, else `defaultName`, else the first entry. Because the list now holds alias rows, a stored `geoff` is found and returned as `geoff`. Its doc comment and the `driverName` field's comment change from "the key under `voice/<voice>/names/`" to "a spelling from `_driverNames`, resolved to its clip at speak time".
2. **A spelling → a clip slug.** Every place a driver name becomes a clip asks `resolveDriverNameSlug` against one voice's own `names/` bases, and plays the spelling unchanged when it answers `null`, which is today's behaviour for a name the voice lacks. There are two such places, both in `audio-scenarios`, and each takes the voice and the clip list from the source that already decides what it plays, so the slug and the clip can never come from two different ideas of the active voice:
   - **The four greeting vars**, through `driverNameRef(engine, group, spelling)` in place of `poolRef`: `sessionStart.greeting` (`catalog/pit-crew/session-start.ts:160`), the race-start greeting (`race-start.ts:340-342`), the race-end greeting (`race-end.ts:155-157`) and `overtake.lost.comeOn` (`overtake.ts:172-174`). Each var takes its group from `DRIVER_NAME_GROUPS` rather than a local string, and `driverNameRef` accepts only a `DriverNameGroup`, so a `poolRef` on a name group is the one way left to bypass the rule, and the test below catches it. `driverNameRef` asks the engine it is handed, never `getScenarioEngine()`: `IScenarioEngine` gains `recordedBases(group): ReadonlySet<string>`, the take-folded bases the ACTIVE voice records in a group, a pass-through to `PoolStore`, which already reads the active voice (`pool-store.ts:117`) and the manifest. `PoolStore` keeps the result memoised per voice and group and clears the memo in `setManifest` (`pool-store.ts:248`), beside the caches it already clears there, so a rescan is never served a stale set. `driverNameRef` calls `engine.recordedBases("names")` and returns `poolRef(group, slug ?? spelling)`. The four register functions widen their `Pick<IScenarioEngine, …>` with `"recordedBases"` (`session-start.ts:151`, `race-end.ts:143`, `race-start.ts:325`, `overtake.ts:159`; called at `catalog/pit-crew/index.ts:1643`, `:1778`, `:1801`, `:1826`). The engine's active-voice reader stays private (`interpreter.ts:420`), no second view of the manifest is exposed, `currentManifest()` gains no new caller (it is documented as test-only at `interpreter.ts:293-294`, and `driverNameClipPath` is its one production caller today), and the facade gains a method, not a field, so `interpreter-facade.test.ts`'s field allow-list is unchanged.
   - **The path-played `names/` clip**, in `driverNameClip(manifest, voice, name)` (`manifest.ts:117-135`), which the radio check (`packages/iracing-actions/src/actions/pit-crew/pit-crew.ts:497-506`) and the Race Engineer Test button (`packages/iracing-actions/src/audio/voice-test.ts:26-34`) reach through `driverNameClipPath`. It resolves the slug from its own arguments: it folds the `voice/<voice>/names/` bases of the `manifest` it was given with `stripTakeSuffix`, calls `resolveDriverNameSlug(name, bases)`, and then looks for the bare clip or the lowest take of that slug as it does now. Both callers resolved `voice` themselves and pass it in, so the name is resolved against exactly the voice whose clip is about to play. No engine accessor is involved on this path.

Before the engine is initialised `driverNameClipPath` returns the spelling's bare path, as it does now. The snapshot getters in `packages/race-engineer-wiring/src/pit-crew-deps.ts:118`, `:132`, `:141` and `:147` keep passing the spelling: resolving at speak time, inside the var, is what makes a voice change take effect on the next line.

For #941, an opponent's name reaches a clip through the same `resolveDriverNameSlug` once #941 has normalised iRacing's `UserName` to a slug. That normalisation is #941's.

### 5. The stored setting never changes

A user who picked Dominik keeps `driverName: "dominik"` in the file, sees the Dominik row selected, and hears the Dominic clips. No settings migration runs and no marker key is added, because no stored value changes meaning: before this change `dominik` named the Dominik clips, after it the same spelling names the clip set it is spoken with. This follows the never-delete-a-choice rule the take fold already follows (#1173): a read-time rule needs no migration.

### 6. Migrating the existing pairs

The check over both voices' five groups found three spellings that are spoken as another name already in the list:

| Alias | Canonical | Why it qualifies |
| --- | --- | --- |
| `geoff` | `jeff` | #1579 ships `geoff` with exactly `jeff`'s text in all five lines (its decision 1). |
| `dominik` | `dominic` | Named by Niklas in the issue; the two shipped with separate takes since #1118. |
| `kris` | `chris` | An English homophone; both predate #1118. Removed only after Niklas hears the two takes side by side and confirms they sound the same; if he does not, `kris` stays a name and its map entry is dropped. |

The canonical is the spelling whose clips stay: Jeff because Geoff's text is Jeff's, Dominic and Chris because they are the older entries and the commoner English spelling. Pairs that look alike but are spoken differently stay separate names: Jørgen and Jurgen (requested as distinct forms in #1118, and cut from different texts), Miguel and Miquel, Matthias and Matthew. Michael and Mikael, the issue's example, are not in either voice.

For each alias, in `default.voice.json` and in `shawn.voice.json`, the five entries are removed from the configs, the five clips from `voice/<voice>/`, and their rows from `generate.manifest.json`; `manifest.json` is regenerated, and `callouts.json` is regenerated and expected unchanged, since no script names a driver name directly. That is 15 entries and 15 clips per voice. Nothing is generated.

Clip removal changes both archives, so both packs bump in `src/build/voice-packs.mjs`. Removing clips is a major bump, from whatever version 3.8.0 publishes (#1579 makes the 3.8.0 minor bump), so `default` and `iracedeck-terse` each take their next major. Both raise `minPluginVersion` to `3.9.0`, the milestone of this change. A plugin without the map would lose the Dominik, Geoff and Kris rows against the new packs and fall back to `driver` for those users; with the raised minimum the catalog keeps such a plugin on the pack it has (`packages/voice-packs/src/voice-pack-catalog.ts:175-199`), where the old clips still play. The comment on `minPluginVersion` (`voice-packs.mjs:34-46`) gains this second reason: a pack also needs a plugin whose alias map serves the spellings it no longer records. Then `pack:voice` runs for both packs and their catalog entries are committed with the change.

The order across versions is safe in both directions: a 3.9.0 plugin with a pre-3.9 pack plays the pack's own `dominik` clips by the precedence in decision 4, and with the new pack plays `dominic`'s.

## Approaches weighed and rejected

- **The map per voice, in `callouts.json` or a new `voice-pack.json` key.** It would let a pack declare equivalences for its own language, but it changes a published, strict format (the script grammar refuses an unknown key and drops the voice, so every pack using it needs a `minPluginVersion`), adds grammar, linter, reference and docs surface, makes every pack repeat the same list, and leaves third-party packs that copied our names behind each time the list grows. "A voice that records the alias plays its own clips" gives a pack the one control it needs without any of that.
- **A shared map plus pack additions now.** Twice the surface, and no pack today asks for it.
- **The map in `@iracedeck/app-constants` so the Property Inspector can read it.** The PI never needs it: the plugin publishes the finished row list.
- **Rewriting the stored spelling to its canonical.** The user would see a name they did not pick; Niklas ruled for keeping the spelling.
- **One dropdown row per spoken name ("Jeff / Geoff", or "Geoff (Jeff)").** Niklas ruled for separate rows.
- **Resolving once, against the union, inside `resolveActiveDriverName`.** It returns a single slug for every voice, which is wrong as soon as one installed voice records the alias spelling and the active one records only the canonical (decision 4). It also cannot serve #941, whose names never pass through the setting.
- **Keeping duplicate entries and relying on the generator cache, as #1579 does for Geoff.** It saves the paid generation for identical text only, still ships every duplicate file in both archives, does nothing for pairs cut from different text (Dominic and Dominik already have different takes), and does not scale to #941.
- **A canonical → aliases map.** It reads well, but an alias listed under two canonicals then becomes a validation rule instead of something the format cannot express.
- **Alias chains.** One hop is enough for any spelling, and a chain would hide which clips a spelling plays.
- **A fallback inside the engine's pool lookup for every group.** It would apply a name rule to pools that are not names, and hide the rule from the code that reads a name.
- **A public active-voice accessor, with the resolver scanning `currentManifest()` itself.** It would put a second copy of "which clips the active voice has" beside `PoolStore`'s, with its own cache to invalidate on a rescan, and give a test-only method production callers. `recordedBases` keeps that knowledge where pools are already derived.
- **`driverNameClip` asking the engine for the voice's names.** Its callers resolved the voice themselves and play a path built from it; reading the names from the engine's idea of the active voice could resolve the slug for one voice and play the clip of another.

## Out of scope

- Calling other drivers by name (#941), and normalising iRacing's `UserName` (case, diacritics, compound first names) to a slug; #941 calls this spec's resolver after its own normalisation.
- Aliases supplied by a voice pack, and any change to the voice-pack format, the scanner or what `lint:pack` checks; only the `names` line's `playedBy` wording changes (decision 1).
- New aliases beyond the three above. A later name batch adds an alias in place of a duplicate entry, and the #1335 homophone check (`docs/superpowers/specs/2026-10-04-issue-1335-driver-names-batch.md`, decision 2) now ends in either a new name or a map entry.
- Dropdown labels other than the title-cased slug (Jørgen still shows as "Jorgen"), and #929's grouping of the dropdown.
- Any change to the take-suffix fold, the fallback to `driver`, or what the radio check and the Test button play beyond resolving the slug.

## Testing

- `callout-script`: `validateDriverNameAliases` reports each refusal (a non-slug, a take suffix on either side, an alias equal to its canonical, a chain) on a hand-made map, one problem per broken entry, and reports nothing for `DRIVER_NAME_ALIASES`. `resolveDriverNameSlug` returns the spelling when the voice records it even if it is an alias, the canonical when only that is recorded, and `null` when neither is.
- `audio-assets`: the first-party test iterates `DRIVER_NAME_GROUPS` and fails on an alias entry put back into either voice's `names` group and on a canonical removed from one of the groups (each checked once as a positive control). The generator dry run refuses an alias entry in any of those groups.
- `audio-scenarios`: `selectableDriverNames` lists an alias only while its canonical is recorded, lists a name once when a voice records the alias spelling too, and stays sorted; `scanDriverNames` is no longer on the package index. `PoolStore.recordedBases` answers for the active voice only, folds takes, and is re-derived after `setManifest`. Each of the four greeting vars and `driverNameClip` play `jeff`'s clips for `geoff` in a voice that records only `jeff`, and a voice's own `geoff` clips in a voice that records `geoff`; `driverNameClip` resolves against the voice it is passed while the engine's active voice is a different one. A catalog test registers the real vocabulary and, for every var whose description names a group of `DRIVER_NAME_GROUPS` (`descriptionNamesGroup`, `reference/pack-reference.ts:317`), resolves it with a `geoff` spelling over a voice that records only `jeff`, and fails unless it returns `jeff`'s pool, so a new name var written with a bare `poolRef` is caught. The bundled-script and script-coverage tests stay green with the clips removed.
- Pack reference: `pnpm generate:pack-reference` regenerates the `names` line with the alias list and the precedence rule, and its freshness test fails on a map change until it is rerun.
- `settings`: `resolveActiveDriverName` returns a stored `geoff` when `geoff` is in the list, and falls back as today when it is not.
- `pnpm generate:callout-scripts` leaves both `callouts.json` unchanged; `pack:voice` succeeds for both packs and regenerates their catalog entries; `pnpm test` covers the pack-reference freshness.
- Niklas listens to Chris against Kris, and Dominic against Dominik, on a review page before those clips are removed.
- By hand, with each first-party pack selected: the Your Name dropdown shows Dominik, Geoff and Kris as their own rows among the names; picking one stores that spelling (checked in `global-settings.json`) and the harness's session-start, race-start, race-end and lost-position lines and the Test button play the canonical take; a settings file that already holds `dominik` opens with Dominik selected and is not rewritten.
