# Splitting the settings store by category

> **Issue:** [#1038](https://github.com/niklam/iracedeck/issues/1038) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

One file holds 334 keys that have nothing in common except an owner. Preferences the user chose, 175 bindings they hand-edit, a device list the plugin derived from this machine's hardware, and a version number that decides whether the What's New page opens all share one object, one parse, one atomic write and one blast radius.

Three consequences, in ascending order of importance:

- **Blast radius.** Bindings are 17,351 of 28,226 bytes — 61% of the file. A mis-edit anywhere in that 61% takes the other 141 preferences with it (#1036).
- **Legibility.** A flat 334-key object is not something a person reads.
- **Portability, which is the real one.** #996 (Export / Import) has to decide, key by key, what may travel to another machine. Today that is a filter over one object, and a filter is a thing you can get subtly wrong forever.

## Evidence

**The `_` prefix is not a category.** Profiling a real file, the 18 underscore keys are at least four different kinds of thing:

| Kind | Keys | Portable? | Durable? |
| --- | --- | --- | --- |
| Machine-derived cache | `_audioDeviceList`, `_deckDevices`, `_driverNames`, `_raceEngineerVoices`, `_settingsStorePath` | No — wrong on another PC | Rebuilt |
| Real user data | `_colorHistory*` (7 keys), `_accordionState`, `_settingsWindowBounds` | Yes | Yes |
| Per-install bookkeeping | `_lastSeenVersion`, `_lastChangelogOpenedAt` | No — would suppress What's New | Yes |
| Session selection | `_selectedCar`, `_raceAdminSelectedCar` | No | Transient |

So "move everything starting with `_`" would file the user's colour history — seven keys of genuine user data — next to a hardware cache.

**This lesson is already in the tree, learned the expensive way.** #1014 wrote into `.claude/rules/global-settings.md`: *"Membership is an explicit list, not a naming convention — plenty of `_`-prefixed keys are durable (`_lastSeenVersion`, `_lastChangelogOpenedAt`), and getting that backwards silently loses user state."* That was about run-scoping, and it applies unchanged here.

**#993's invariant was one writer, not one file.** The two-writers problem it solved was the deck host and the plugin both writing the same store. Sharding the plugin's own persistence does not reintroduce it: the plugin still owns every byte.

## Decisions

### 1. Split the persistence; keep one model

The cache stays a single object. `getGlobalSettings()` returns one merged object, `updateGlobalSettings(partial)` takes one partial, and `hostMirrorPayload`, the loopback fake host, both PI bridges and every consumer are untouched. Only `SettingsStore` gains a key→file router, fanning out on save and merging on load.

This is the decision the feasibility rests on, so it doubles as the design's own tripwire: **if the change reaches beyond `settings-store.ts` and its routing table, the approach is wrong and should be reconsidered rather than pushed through.** A split that leaked into the model would multiply not just files but every read path in the plugin.

### 2. Three files, each with a one-line invariant

| File | Holds | Invariant |
| --- | --- | --- |
| `global-settings.json` | User preferences, plus `_colorHistory*`, `_accordionState`, `_settingsWindowBounds` | The user's choices. Exportable and portable. |
| `keybindings.json` | The 175 bindings | The user's bindings. Exportable, portable, hand-edited. |
| `runtime.json` | The cache, bookkeeping and session rows above, plus `_migrationPending` | Machine- and install-scoped. Never exported. **Safe to delete.** |

The invariants are the point, not the file count. "Safe to delete" is a testable property: removing `runtime.json` must cost exactly one spurious What's New and a re-derived device list, never a user setting. If a key cannot be placed without weakening one of these three sentences, that is a signal the key is misdesigned, not that the taxonomy needs a fourth file.

`_warnings` stays where #1014 put it — run-scoped, in no file.

### 3. The routing table is an explicit list, and an unrouted key is a test failure

Shaped like `RUN_SCOPED_SETTING_KEYS`. Every key that is not a plain user preference gets an entry naming its file; plain preferences are the default home.

A key with no entry must fail a test rather than silently land somewhere reasonable. Silence is precisely how #1014's bug happened — a key drifting into the wrong category, correct-looking, until it lost someone's data. The test is what converts the taxonomy from documentation into something enforced.

### 4. `runtime.json` gets no corrupt-aside ceremony

Preserving a corrupt file matters when its contents are irreplaceable. `runtime.json` is by construction replaceable, so a bad one is deleted and rebuilt. Applying #1036's aside-and-explain treatment to it would litter the folder and put a banner in front of a user about a file they have no stake in.

The other two keep the full ceremony, and #1036's banner must name **which** file was rejected — a message saying "your settings file" when only bindings failed would misdescribe what was lost.

### 5. A rejected file must not re-migrate the others

The corrupt path today returns "no file", which reopens the deck-host migration for the whole store. Split, that must narrow to the affected file. A broken `keybindings.json` restoring bindings from the host copy is right; letting it also replace 141 untouched preferences reproduces #1036's complaint with extra steps.

## The migration, and the one thing that can go wrong

The existing single file must become three, once. The failure mode to design against is interruption part-way — a machine losing power between writing `keybindings.json` and writing `global-settings.json` must not leave a state where the old file is gone and only some of the new ones exist.

The safe shape is to treat the original as the source of truth until all three replacements are durable: write the new files first, verify them, and only then retire the original (renamed aside rather than deleted, so the first split is recoverable by hand). This is the one genuinely new failure mode the change introduces and deserves its own tests.

Debounced saves also stop coalescing one payload and start coalescing per file, rewriting only files whose slice actually changed — otherwise a single volume-slider drag rewrites all three.

## Alternatives rejected

- **Keep one file.** What #993 built, and the status quo works. Rejected because it leaves #996 with a filter that must be perfect forever, and leaves 141 preferences downstream of any binding typo.
- **Split by naming rule (`_` prefix).** Rejected on the evidence above; it misfiles seven keys of real user data.
- **Two files (settings + bindings), underscore keys left mixed in.** Cheaper and genuinely tempting. Rejected because it delivers the blast-radius win but not the portability win, and portability is the reason to do this at all. Worth revisiting if the three-file version proves heavier than expected.
- **Do this as part of #996.** Rejected as sequencing: #996 built on one file would harden the filter this exists to delete. Decide this first.

## Open questions

- Where a key with no routing entry lands while the enforcing test is being written (default home, or hard failure from day one).
- Whether `runtime.json` should be per-install or could reasonably be per-machine shared across ecosystems. Today every ecosystem gets its own folder; the device list arguably wants sharing, and arguably not.
