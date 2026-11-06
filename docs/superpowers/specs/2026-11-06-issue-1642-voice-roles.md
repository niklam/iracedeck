# Voice roles: a Spotter and a Race Engineer, each with its own voice

> **Issue:** [#1642](https://github.com/niklam/iracedeck/issues/1642) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The engine resolves every clip, script and frame through one active voice: `getActiveVoice()`, threaded through `PoolStore`, `ScriptSet`, `Expansion`, `Scheduler` and the resume check in `@iracedeck/audio-scenarios`, and fed from the `raceEngineerVoice` setting through `resolveActiveRaceEngineerVoice`. A pack's `voice-pack.json` lists voices, but the user picks one of them for everything.

The goal (issue) is a voice per role, starting with Spotter and Race Engineer, so that a user can pair voices from different packs and an author can publish a voice made for one role. Decided with Niklas on 2026-11-06:

- Roles are iRaceDeck's. Every contract belongs to exactly one role, and neither users nor packs move a callout between roles.
- A pack declares which roles each voice covers; undeclared means all roles.
- A role whose voice has no line for one of its callouts is silent for it. There is no fallback to the other role's voice.
- The roles share one bus and today's scheduling, and each role's lines use its own voice's radio frame.
- More roles may come later; two ship now.

## Decision

### The roles and the split

Two role ids, `spotter` and `engineer`. They are a closed list owned by `@iracedeck/callout-script` (`VOICE_ROLES`, `VoiceRole`), together with their display names (`VOICE_ROLE_LABELS`: "Spotter", "Race Engineer"), which the pickers, the banner, the Installed Voices badge and the Callouts page all show. The pack manifest, the engine and the settings all name the roles, and that leaf is the one package all three already depend on, so no new dependency edge appears. `app-constants` can't hold them, because the manifest's zod schema needs the ids and that leaf may import nothing. The website mirrors the labels by hand in `pack-reference-types.ts`, as it does the rest of the reference shape.

The rule behind the split: **the Spotter is the eyes on the track, right now** (traffic, the flag in front of you, the pace car, where the car is in the pit lane and in the box), and **the Race Engineer handles numbers, strategy and consequences**. "Is it a warning?" is not the test: a fuel warning is strategy.

| Role | Contracts (by id prefix or id) |
|---|---|
| Spotter | `spotter-call`, `spotter-info` |
| Spotter | race-control flags: `flag-yellow-local`, `flag-yellow-full`, `flag-yellow-cleared`, `flag-yellow-waving`, `flag-caution-waving`, `flag-green`, `flag-blue`, `flag-white`, `flag-white-last-lap`, `flag-white-leader`, `flag-red`, `flag-checkered`, `flag-debris`, `flag-crossed`, `flag-one-pace-lap-to-go`, `flag-green-held`, `flag-ten-to-go`, `flag-five-to-go` |
| Spotter | `caution-*` (follow, pace car out and off, field caught, extra lap, one to go, lineup changed, catch up, position, restart) |
| Spotter | `rolling-start-*`, `start-light-ready`, `start-light-go` |
| Spotter | pit-lane guidance: `pit-box-*` (the count-in), the pit-status positioning lines (`pit-status-too-far-*`, `pit-status-bad-angle` and their `-repeat`s), `limiter-*`, `no-limiter-*` |
| Race Engineer | penalty flags: `flag-black`, `flag-meatball`, `flag-disqualify`, `flag-dq-scoring-invalid`, `flag-furled`, `flag-furled-cleared` |
| Race Engineer | `start-light-countdown-*` (a reminder to get in the car, not a light) |
| Race Engineer | the pit-status service lines (`pit-status-in-progress`, `-complete`, `-nothing-to-do`, `-cant-fix-that`), `pit-readback-*`, `tire-wear-report`, `pit-window-*`, `fuel-laps-left-*`, `damage-repair-needed` |
| Race Engineer | `incident-*`, `qualifying-invalidation-*`, `opponent-pit-*`, `opponent-flag-*` |
| Race Engineer | `lap-time-*`, `fastest-lap-race`, `gap-*`, `position-change`, `overtake-*`, `race-status`, `race-start`, `race-end`, `session-start`, `track-conditions-*`, `corner-name-approaching` |
| Race Engineer | press and toggle confirmations: `readout-*`, `toggle-*`, `auto-fuel-*`, `tire-set-*`, `tire-compound-*` |

Three calls worth stating:

- **`opponent-flag-*` is the engineer's.** Since #1274 these name a nearby rival's penalty by car number: news about the race, not a hazard to drive around.
- **`corner-name-approaching` is the engineer's.** It is coaching in practice, not traffic.
- **The pit-status family is split.** Positioning in the box is guidance; whether the service ran is the engineer's report.

### Role on the contract

`ScenarioContract` gains `role?: VoiceRole`. The engine treats an absent role as `engineer`, so the interpreter's own test contracts need no change. `bundled-scripts.test.ts` requires every catalog contract to set it explicitly, so a new callout cannot inherit a role by omission. The role is code-owned like all pacing: a script cannot set it, and the grammar refuses a `role` key in a script entry (the entry object is strict already).

### Voice resolution per role

`getActiveVoice(): string | null` becomes `getVoiceForRole(role: VoiceRole): string | null`. No fire-less voice accessor survives inside the engine. The fire's voice is resolved once, when it expands, and passed down: `Expansion.prepare` receives it and hands it to the `PoolStore` calls and the `{voice}` substitution. A module that still reads "the" voice without a fire is the bug this design exists to remove. Every reader takes the voice of the fire it serves:

- **Scripts.** `ScriptSet` compiles the script of each voice assigned to a role, and looks an entry up in the voice of the contract's role. When both roles have the same voice, it compiles once.
- **Pools.** `PoolStore` resolves `pool:<group>/<base>` and `poolRef(...)` against the fire's voice, and keys its no-repeat trackers by `(voice, pool)`. Today it resets the trackers when the active voice changes; now it resets them per voice when a role's voice changes.
- **Frames.** `Expansion` wraps a fire in the frame from its own voice's script, so a spotter line carries the spotter voice's ticks. The Radio beeps and Pit ambience switches stay global (`frameOptionsFromSettings`).
- **Resume.** The stash records the voice that played the fire. The resume check compares it with the current voice of that fire's role ("voice changed while stashed").
- **Scripted check.** `engine.isScripted(id)`, which the spotter engine asks before raising its focus floor, answers for the voice of that contract's role.
- **Clips played outside scripts.** The toggle acknowledgments, the welcome greeting, the radio check and every `names/` clip played by plugin code (`PLUGIN_PLAYED_CLIPS`) belong to the Race Engineer voice.
- **The Background Test** previews the Race Engineer voice's frame (`scheduler.ts`'s frame lookup). It is one frame preview, and the engineer is the voice the radio is known by.
- **Debug state.** `describeState` reports `voices: { engineer, spotter }` in place of `activeVoice`, and each contract's `scripted` flag is computed against the voice of that contract's role, not one voice for all.

Scheduling is untouched: one `AudioBus.Voice`, one volume, the same weights, families, interrupts, queue and focus floor. A family still preempts across roles (the `flag` family holds both race-control and penalty flags), which is today's behaviour with two speakers instead of one.

### Pack format

Each entry of `voice-pack.json`'s `voices` gains an optional `roles`:

```json
{ "id": "anna", "label": "Anna", "roles": ["spotter"] }
```

- Absent means every role. That is every pack today, so no pack changes behaviour.
- When present, it is a non-empty array of strings. Unknown role ids are ignored, so a pack written for a later plugin that adds a `strategist` still loads. A voice whose `roles` names no role this plugin knows is offered in no picker, and the scanner reports it once at debug.
- An empty array, a non-string entry or a duplicate is a manifest problem (`validateVoicePackManifest`), and like every manifest problem it refuses **the whole pack**, not one voice. The schema is `z.array(z.string())` with refinements, never `z.enum`, so an unknown id passes.
- `roles` lives on the shared `voiceEntry` primitive, which the catalog schema reuses too. The packer writes it into both `voice-pack.json` and `catalog/<id>.json`. The installer's `seedManifestText`, which today copies only `id` and `label` from a catalog entry, copies it too. Without that, a first-party pack seeded from the catalog would lose its declaration and offer a spotter-only voice for every role.
- `roles` decides **which pickers offer the voice**, nothing else. The engine plays whatever the voice assigned to a role has scripted for that role's contracts.
- `VOICE_PACK_MANIFEST_SCHEMA_VERSION` stays `1`. The field is additive and an older plugin ignores unknown keys, so an older plugin lists a spotter-only voice as an ordinary voice that is silent for most callouts. A first-party pack that declares `roles` therefore carries a `minPluginVersion` of the release that ships this. A third-party pack has no such field, and the format page tells authors so.

The packer writes `roles` through `buildVoicePackManifest` from a new optional `roles` on the `VOICE_PACKS` entry's voice. `lint:pack` reports, per voice, how many contracts of each declared role its script covers. A voice that declares a role while scripting none of that role's contracts is a problem, because the picker would offer a voice that never speaks.

### Settings

- **New key `spotterVoice`** (string, default `""`, the `raceEngineerVoice` shape and its `preprocess` guard). `""` means "Same as Race Engineer". A user choice, so it persists and is not run-scoped. It needs no bare-id migration: the key is born after #1144, so only composite ids are ever stored in it.
- **`resolveVoiceForRole(role, settings, available, rolesByVoice)`** replaces `resolveActiveRaceEngineerVoice`, which is deleted rather than kept alongside. The role map is an argument, never read from the settings cache: the first scan runs before `initGlobalSettings`, so a resolver that read `_voiceRoles` from settings would resolve against the previous run's map.
  - For `engineer`, it follows today's rule over the voices that cover `engineer` only. That includes its last fallback, the first voice in the published order, so a spotter-only voice can never be picked as the engineer.
  - For `spotter`, a value of `""`, or a voice that is no longer available or no longer covers `spotter`, resolves to the engineer's voice.
  - The stored value is never rewritten: a pack missing for one scan does not erase the choice.
- **Who passes the map.** The engine and the scan pass `voicePacks.state.voiceRoles`, built in the voice-pack service's `onPacksChanged` beside `raceEngineerVoices`. That covers `plugin-runtime`'s `phases/race-engineer.ts` and `phases/voice-packs/scan.ts`, and the scenario harness's `main.ts`. The deck actions parse `_voiceRoles` from settings, as they parse `_raceEngineerVoices` today: `pit-crew.ts`, `audio-toggles.ts` and `voice-test.ts`. `ird-voice-select`'s browser copy of the rule (`voice-select.ts`, pinned to the plugin's rule by test) gets the same role filter.
- **New passthrough key `_voiceRoles`** (composite id → role ids, undeclared expanded to every role). It is published in the same `updateGlobalSettings` write as `_raceEngineerVoices` and `_voiceLabels` and shares their lifetime, for the reason `VOICE_LABELS_KEY` gives. The pickers filter by it; the list of voices that exist stays `_raceEngineerVoices`, unchanged in shape.
- **The missing-script banner** (`voice-script-missing`) stays one id with one set-or-clear decision. The reporter clears the id whenever its evaluation returns nothing, so calling it once per role would let the second call erase the first role's banner. `evaluateVoiceScriptWarning` instead takes `{ voices: { engineer, spotter }, scriptedVoices, labels }` and returns one warning naming every role whose voice has no script ("The Spotter voice … has no callout script"), or nothing.

### Settings window and Property Inspector

The Race Engineer card shows two pickers, **Race Engineer voice** and **Spotter voice**. The Spotter picker's first option is "Same as Race Engineer", then every voice that covers `spotter`. The Race Engineer picker lists every voice that covers `engineer`. Each picker has its own Voice Test. The Race Engineer test is today's (name and greeting). The Spotter test plays the spotter voice's "Car left" through its frame. It is a new kind in `runAudioPreview`'s allow-list, the one preview path, and it takes the clip from the spotter engine's own clip catalog rather than restating the path. The Installed Voices card shows a role badge on a voice that does not cover both roles. The label rule (#1147) applies to both pickers unchanged.

### Harness and debug state

The scenario harness gets a voice picker per role, with the same "Same as Race Engineer" default. A Telemetry Snapshot shows which voice each role was using, through the debug state above.

### Rules updated in the same change

- `race-engineer-callouts.md`: step 4a gains `role` among a contract's fields, with the split rule, and the voice-pack rows name per-role resolution.
- `global-settings.md`: the Race Engineer voice paragraph covers `spotterVoice` and `resolveVoiceForRole`, the missing-script banner entry covers both roles, and `_voiceRoles` joins the passthrough keys.
- `settings-window.md`: `_voiceRoles` joins the keys the window reads, and the Spotter preview kind joins the preview list.
- `callout-script/CLAUDE.md` (`roles`, `VOICE_ROLES`) and `voice-packs/CLAUDE.md` (the scan's role map, the seed).

### Generated reference

`buildPackReference` adds each contract's role, and the website's Callouts page shows it on every callout and lets the reader filter by role. That page is what a spotter-pack author reads to see which callouts to record.

## Alternatives rejected

- **Users assign callouts to roles.** Every spotter pack must cover the same calls, or a pack and a user's setting could disagree about who speaks. Niklas ruled it out.
- **Packs define roles or map callouts to roles.** The same reason, from the pack side.
- **Falling back to the Race Engineer voice when the Spotter voice lacks a line.** It mixes two speakers within one role, and it contradicts "absent means skipped".
- **Declaring roles per pack rather than per voice.** A team pack ships a spotter voice and an engineer voice side by side, so the declaration belongs to the voice.
- **A bus or channel per role.** Two voices could then talk over each other, and every weight decision would have to be made twice.
- **One voice folder with several speakers (today's route).** It works for an author, but it doesn't let a user combine packs.
- **Bumping the manifest schema version for `roles`.** An older plugin would refuse every pack that adopts it, including all-role packs that only list roles for clarity. Ignoring the key there costs one silent-ish entry in an older picker, which the first-party `minPluginVersion` and the format page cover.

## Out of scope

- A first-party Spotter voice pack: its own issue.
- A per-role volume. Both roles use the Race Engineer volume.
- Roles beyond Spotter and Race Engineer (strategist, team principal).
- New callouts for either role, such as a rejoin "clear" call (#1113).
- Letting a pack move a callout to another role, or set a role on a script entry.

## Testing

Unit and integration:

- `bundled-scripts.test.ts`: every catalog contract sets `role`, and the assignment matches the table above (a snapshot of id → role, so a change is a reviewed diff).
- Interpreter tests: with two voices assigned, a spotter-role fire plays the spotter voice's clips, script entry and frame, and an engineer-role fire the engineer's; a spotter voice with no entry for a spotter contract is silent while the engineer voice has one; no-repeat trackers are kept per voice; a resume after the spotter voice changed replays the whole body; `isScripted` answers for the role's voice.
- `callout-script`: `roles` absent, valid and unknown-only. Empty, duplicated and non-string refuse the whole pack, through `validateVoicePackManifest` and the scanner.
- `voice-packs`: a catalog entry carrying `roles` seeds a manifest that keeps them, and the catalog schema accepts them.
- `settings`: `resolveVoiceForRole` for `""`, an available spotter voice, one that disappeared, and one whose pack dropped `spotter`. Also: an engineer fallback list whose first voice is spotter-only, which skips it; and a check that the stored value is never rewritten.
- The missing-script banner: a missing spotter script and a present engineer script raise it, and a later evaluation with both present clears it, in one write each.
- `lint:pack`: a voice declaring `spotter` with no spotter entries is reported.
- PI: both pickers filter by `_voiceRoles`, and "Same as Race Engineer" saves `""`.

By hand (Niklas):

- Sideload a spotter-only pack (any voice, `roles: ["spotter"]`). It appears only in the Spotter picker. Choosing it, the proximity calls, flags and pit-lane guidance come in that voice with its frame, and the readback, fuel and lap times stay in the engineer's.
- With Spotter on "Same as Race Engineer", everything sounds exactly as before.
- Remove the spotter pack mid-session: spotter calls move to the engineer voice, and the stored setting still names the removed voice.
- An older plugin build lists the spotter-only voice as an ordinary voice and still starts.
