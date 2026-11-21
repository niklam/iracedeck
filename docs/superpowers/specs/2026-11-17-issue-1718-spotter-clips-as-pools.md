# Spotter clips resolve as pools, and a var can declare what it draws

> **Issue:** [#1718](https://github.com/niklam/iracedeck/issues/1718) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The spotter engine (`audio-scenarios/src/catalog/pit-crew/spotter-engine.ts`, #651) picks a clip per car-presence transition and hands it to the script through the `spotterClip` var. It hands over a finished path, `voice/{voice}/spotter/car-left.mp3`, which the engine checks against the manifest as written. Every other line is a pool since #836/#1064: `pool:<group>/<base>` takes the bare `<base>.mp3` and every `<base>-NN.mp3` (`poolMemberPattern`, exactly two digits). A pack that records the spotter as takes (`car-left-01.mp3`) therefore has every spotter call abort under #835, at debug level, and the driver hears no spotter at all.

`lint:pack` does not see it. It exempts a group from the orphan rule when a var's description names the group (`descriptionNamesGroup`), and the `spotterClip` description names the spotter group, so every file there counts as used, and nothing knows which bases the engine will ask for, so nothing is missing. `lint-pack.ts`'s header already names the gap: "Declared sources on `defineVar` would close it."

## Decision

### 1. Every spotter clip is a pool reference

`levelClip`, `combinedClip`, the three-wide clip and the clear clip return `poolRef("spotter", <base>)` instead of a path; `pendingSpotterClip` holds that reference, and the var returns it unchanged. The bases and their spelling do not change, so the first-party voices' bare files keep playing as pools of one, and a pack may ship the bare file, takes, or both, exactly as for any other line.

The engine-owned path lists go:

- **Clear** is one base, so `CLEAR_POOL` and `clearPick` are removed; variety comes from takes of `spotter/clear`.
- **Still there** stays a choice between two LINES, `still-there` and `hold-your-line`, which a pack may record separately. The engine keeps its no-repeat pick between the two bases (`pickNoRepeat` over the base names) and returns the chosen base's pool reference; the take within that base is the pool store's pick.

The take pick and its no-repeat now belong to the pool store, so a take is consumed only when the fire is accepted (#1136/#1138). The base pick for still-there keeps its present behaviour (it advances when the engine fires, accepted or not); the two calls are not `queueable`, so a refused fire is dropped either way and the difference is one skipped alternation.

**The base list is derived, never written out.** The spotter file exports `SPOTTER_CLIP_BASES`, built by running the same naming functions over every input they can receive: each side and count through `levelClip` (with and without the de-escalation flag), each cleared/remaining pair and count through `combinedClip`, for every `SpotterTrackDirection`, plus `three-wide`, `clear`, `still-there` and `hold-your-line`. That yields the 24 bases the default voice ships. A hand-written list could drift from the functions; a derived one cannot.

### 2. `defineVar` may declare the clips a var can produce

`defineVar(name, resolver, description, options?)` gains an optional `options.draws: readonly { group: string; base: string; contracts?: readonly string[] }[]`, the closed set of `(group, base)` pools the resolver can ever return. `contracts` scopes a draw to the contract ids the resolver can return that pool for; absent means any contract. The spotter registers `spotterClip` with `draws` built from `SPOTTER_CLIP_BASES`, scoped: the 21 call bases (`car-*`, `two-cars-*`, `one-car-*`, `clear-*-*`, `three-wide`) to `pit-crew.spotter-call`, and `clear`, `still-there` and `hold-your-line` to `pit-crew.spotter-info`. The scope is derived from the engine's own fire paths like the base list, and the spotter's test pins that every base each fire path can produce lands in its scope. The engine does not enforce it at fire time; it is a declaration for the tooling, and the spotter's test pins the agreement (every transition's reference is in the set, and every base in the set is reachable).

`vocabulary()` reports `draws` on a var that declared it and omits the key on one that did not. Only vars with a closed set declare it. Most vars are open-ended (a position number, a temperature, a driver name), and for those the description heuristic stays.

### 3. `lint:pack` reads declared draws ahead of the description

For a var that declares `draws`:

- its description is not read by `descriptionNamesGroup`, so it no longer exempts the whole group;
- an unscoped draw counts as a reference the script makes when the voice's live script names the var anywhere (`collectScriptReferences(...).vars`);
- a scoped draw counts only when a live entry for one of its contracts names the var (in the entry itself, a fragment it includes, or its frame). `spotterClip` is named by two contracts that draw disjoint lines, so without the scope a pack that scripts only `pit-crew.spotter-call` would have `clear`, `still-there` and `hold-your-line` reported as dangling, a lint failure for lines nothing could ever ask for; the mirror pack would get 21 false errors, and a call-only pack shipping `clear.mp3` would get no orphan.

The same scoping applies to the first-party check in section 4. The reference JSON and the pack format are unchanged.

`@iracedeck/callout-script`'s `CoverageInput` gains `varReferences?: readonly string[]` (`group/base` keys) that `coverageOf` adds to `referenced`. The existing orphan and dangling rules then report both directions without new rules: a declared base the voice does not ship is dangling (`spotter/car-left`, the pack that recorded only some lines), and a spotter file that matches no declared base is an orphan (`car-left-1.mp3`, a take with one digit, which the engine never plays). The coverage module stays vocabulary-free: the linter computes the keys from the vocabulary and the script, and hands them over.

A voice whose script does not name the var gets no var references. Its spotter files are orphans, which is true: nothing plays them.

The generated pack reference keeps its JSON shape. Its recording script attributes a line to a var by the var's `draws` when declared and by `descriptionNamesGroup` otherwise, so the spotter's lines are listed under `spotterClip` exactly as now. The website mirror (`pack-reference-types.ts`) is untouched.

### 4. First-party voices are held to the declaration

`bundled-scripts.test.ts` gains a check: for every first-party voice, every var its script names that declares `draws` has a clip for each declared pool in that voice's manifest. That is where a first-party voice missing a spotter base would surface; today nothing checks it, since the spotter clips are reached only through a var.

## Alternatives rejected

- **Make the spotter's path lookup also accept takes** (try `car-left.mp3`, then any `car-left-NN.mp3`). A second, private copy of the pool rule inside one family, without the no-repeat and pick-session handling the store already has. The point of the fix is that the spotter stops being the exception.
- **Have the linter import `SPOTTER_CLIP_BASES` directly.** It would close this case only, and every future var with a closed set would need another special import in the linter. A declaration on `defineVar` is the general form, and the linter already reads the vocabulary.
- **Name each spotter base in the `spotterClip` description** (`spotter/car-left`, …) so `descriptionNamesGroup` matches per base. It would make the description a 24-item list and a contract written in prose. The heuristic matches a group, not a base, so it would still exempt the whole group.
- **Fold still-there into one pool** (record "Hold your line." as a take of `still-there`). It would change the first-party clip names and the published `(group, base)` that packs record against, for no gain. The two lines are different words, and a pack may want either one alone.

## Out of scope

- Declaring `draws` on any var other than `spotterClip`. Other closed-set vars may adopt it later, one at a time, each with its own test.
- Raising the #835 abort log from debug. `lint:pack` is the loud channel by design; the runtime stays quiet for a pack that omits something.
- Publishing `draws` on the website's Vocabulary page.
- Any change to the spotter's scheduling, weights, focus floor or wording, and any first-party clip change.
- Per-role voices (#1642). That work will resolve the spotter's pool references through its role's voice like any other pool, which this change makes possible without special handling.

## Testing

Unit, in the suites beside the code:

- `spotter-engine.test.ts`: every transition fires a `pool:spotter/<base>` reference; a manifest with only `car-left-01.mp3` / `car-left-02.mp3` plays the left arrival, and one with both the bare file and takes draws from all of them; still-there alternates between the two bases, and each base's takes are drawn from; `SPOTTER_CLIP_BASES` equals the 24 bases the default voice ships, and every reference a transition can produce is in it.
- `vocabulary` / interpreter: `vocabulary()` reports `draws` for `spotterClip` and omits the key for a var registered without it.
- `coverage.test.ts` (`callout-script`): `varReferences` count as referenced for both rules.
- `lint-pack.test.ts`: a takes-only spotter pack is clean; a pack missing `spotter/car-left` reports it as dangling; `car-left-1.mp3` is an orphan; a voice whose script omits the spotter entries reports its spotter files as orphans; a pack scripting only `pit-crew.spotter-call` is clean without the info lines (and reports a shipped `clear.mp3` as an orphan), and a pack scripting only `pit-crew.spotter-info` is clean without the call lines; a var with no `draws` still exempts its group as before.
- `bundled-scripts.test.ts`: the new declared-draws check passes for both first-party voices and fails when a declared base is removed from a test manifest.
- The generated pack reference is unchanged byte for byte (`scripts/generate-pack-reference.test.mjs`).

Manual (Niklas, since it is heard):

1. Build a sideloaded test pack whose spotter clips are the default voice's renamed to `-01`, with one base also given a `-02` take. Point the harness at it (`IRACEDECK_VOICE_PACKS_PATH`), select it, and press every Radar shortcut: each call plays, and the base with two takes alternates.
2. `pnpm lint:pack <that pack>` is clean. Delete one spotter file and rename another to a one-digit take: the linter names the first as missing and the second as an orphan.
3. In iRacing with the test pack active, drive alongside traffic: calls, clear and still-there play as with the default voice. Switch back to the default voice: unchanged.
