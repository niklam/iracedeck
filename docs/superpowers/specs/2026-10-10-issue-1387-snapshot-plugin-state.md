# Plugin state in the Telemetry Snapshot

> **Issue:** [#1387](https://github.com/niklam/iracedeck/issues/1387) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Take Snapshot (Telemetry Control, #635) writes `{ timestamp, telemetry, sessionInfo }`: what iRacing reported at one instant. Most support questions are about what the plugin made of it: why the engineer said two laps of fuel, why a caution was never called, why a position read wrong. Those answers live in state the plugin builds over many laps (the validated fuel-lap history, the frozen running order, gap traces, callout latches and cooldowns), and none of it can be rebuilt from one telemetry frame. By the time a report arrives it is gone.

The survey behind this spec (2026-10-10) found three facts that shape the design:

- Nearly all race-derived state lives in the `sim-events-iracing` translator: about 250 `TranslatorState` fields plus the fuel-lap tracker on the instance. Actions hold only render caches, timers and pit-request bookkeeping.
- The spoken "laps of fuel left" figure is stored nowhere. `diffFuelLapsLeft` computes it as locals once per lap and emits an event; Session Info's Laps to Empty does its own division with no margin. A snapshot that recomputed it a third way would show a number neither of them uses.
- No code reads a snapshot file back. The test fixtures under `sim-events-iracing/src/diff/__fixtures__/` are cut from snapshots by hand, the mock telemetry is hard-coded TypeScript, and the CLI only writes. An additive top-level key breaks nothing.

## Decision

The snapshot gains one top-level key, `pluginState`, in the same JSON file. Each owning package exports a reader for its own state; `plugin-runtime` registers the readers as named sections in `@iracedeck/diagnostics`; Take Snapshot collects them synchronously at the press, passes each through one JSON-safe encoder, and writes the file.

```json
{
  "timestamp": "2026-10-10T14:03:11.482Z",
  "telemetry": {},
  "sessionInfo": {},
  "pluginState": {
    "schema": 1,
    "collectedAt": 1791727391482,
    "environment": {},
    "settings": {},
    "sim": {},
    "raceEngineer": {}
  }
}
```

### 1. The registry and the collector (`@iracedeck/diagnostics`)

- `registerStateSection(name, { read, headline? })` stores a section in a module-level map. `read()` returns that subsystem's state as it stands; the optional `headline(state)` returns label/value rows for the Markdown report. Registering a name twice throws, since two owners for one section is a wiring bug.
- `collectStateSections(logger, now?)` runs every `read()`, encodes each result on its own, and returns `{ state, headline, failed }`: `state` is `{ schema, collectedAt, ...sections }`, `headline` is the Markdown rows of every section in registration order, and `failed` names the sections whose reader or encode failed.
- A section name that is empty or one of `schema`, `collectedAt` and `error` is refused at registration: the first two are the envelope's own keys, and `error` is how a failed section reads in the file.
- **Readers are synchronous and side-effect-free.** The press is handled between SDK ticks, so a synchronous collection describes one tick. A reader that awaited would let a tick land in between, and a reader that wrote anything would make taking a snapshot change the behaviour being reported.
- The registry is generic (a name and a function), so diagnostics keeps importing nothing sim-shaped and the sim-boundary lint rule still holds.
- Nothing runs per tick. A reader is called only when a snapshot is taken.

### 2. The JSON-safe encoder

`JSON.stringify` never emits invalid JSON. It either throws (a `BigInt`, a cycle), which today would lose the whole file, or it silently misreports (`Set` and `Map` become `{}`, `NaN` becomes `null`). The encoder turns any value into plain JSON data first:

| Value | Encoded as |
| --- | --- |
| Finite number, string, boolean, `null` | Itself (`-0` is written as `0`, which is what JSON holds) |
| `NaN`, `Infinity`, `-Infinity` | The strings `"NaN"`, `"Infinity"`, `"-Infinity"` |
| `undefined` | Omitted as a property, `null` as an array element or hole |
| `BigInt` | Its decimal string |
| `Date` | ISO string; an invalid date is the string `"Invalid Date"` |
| `Set` | Array of its members |
| `Map` | Array of `[key, value]` pairs (keys need not be strings) |
| Typed array | Plain array |
| `Error` | `{ name, message }`, both coerced to strings |
| Function, symbol | Omitted as a property, `null` as an array element |
| Any other non-plain object (class instance, timer, `WeakMap`, promise, `ArrayBuffer`, an object whose prototype is another object) | The string `"[<constructor name>]"` |
| A reference to one of its own ancestors | `"[Circular]"` |
| A container nested deeper than 32 | `"[MaxDepth]"` |
| More than 2,000,000 values in one section | The encode throws, so the section becomes an error entry |

Non-finite numbers become strings rather than `null` because a `NaN` in derived state is usually the bug being hunted, and `null` would hide it. Only ancestors count as a cycle; the same object reached twice by different paths is encoded twice. That is what the value budget is for: objects that reference each other multiply with every level, and a reader returning such a graph would otherwise stall the plugin's main thread at the press. The largest real section, a 64-car field of gap traces, is about 150,000 values.

As `JSON.stringify` does, the encoder reads own enumerable string-keyed properties only: a non-enumerable or symbol-keyed property is skipped, and so is a named property set on an array (a `-1` index included). An own `__proto__` key is kept as a key.

### 3. Failure isolation

A broken section must never cost the telemetry.

- A reader that throws, or whose result the encoder cannot finish, becomes `{ "error": "<message>" }` in place of its section. One `WARN` naming the section is logged (`Snapshot state section "<name>" failed`), with the reason at debug. The message is always a non-empty string, whatever was thrown, so the error entry cannot itself make the file unwritable.
- A reader that returns a promise is a failed section, not a healthy one: readers are synchronous, and an encoded promise would read as data.
- If the collector itself fails, `pluginState` is `{ "error": "<message>" }` and the envelope is written with telemetry and session info as today.
- The collector isolates per section, so a reader isolates its own parts: one throwing accessor must not cost the rest of its section, least of all the raw state that would explain the throw. `sim` and `raceEngineer` both do (section 4).
- A failing `headline`, or one that returns anything but two-cell rows of primitives, drops that section's rows from the Markdown report and nothing else. The collector validates the rows, because the Markdown writer would otherwise throw on a malformed one and take the report with it.

### 4. The sections

**`environment`** (built in `plugin-runtime`): plugin version, deck host (`getPluginPlatform()`), Node version, whether the SDK is connected, whether iRacing is running, the elevation check's verdict, and whether the settings store had loaded and from where (`file`, `host` or `fresh`). All of it is read at the press, not at registration. No file paths: they carry the Windows user name and add nothing a version and host do not.

**`settings`** (reader in `@iracedeck/settings`, which owns the keys): the parsed global settings, minus every key starting with `_`, except the five the reader names. The `_` keys are run-scoped and internal, and one of them, `_settingsChannel`, holds the loopback settings server's port and token. The rule is an allow-list by construction: a future internal key is excluded without anyone remembering to exclude it. Five internal keys are kept, each because support reads it, and each through its own validating reader (there is no generic one for a key added later to fall into): `_warnings`, the banners a user was shown, as well-formed `{ id, level, message }` records from the banners' own validated read; `_lastSeenVersion`, whose absence is the first-run signal; `_migrationPending` and `_migrationAbandoned`, the host-migration state behind a report of reverted settings; and `_voicePacks`, the voice-pack scan behind a silent engineer, with only its named fields, which leaves out a development pack's directory path. This spec first kept `_warnings` alone; the other four were added at the maintainer's decision once their producers had been read. A kept key that is absent from the settings is absent from the file, and one that is present but malformed is written as `{ "rejected": true }`: never as its value, and never left out, since absence already means something. A file path inside a warning banner's text is not redacted, also the maintainer's ruling: the snapshot already names the user in its session info, and the path of a preserved settings file is what that support case needs. `_voicePackStatus` stays out: it is the whole downloadable catalog plus transient install phases, bulky and stale by design. Before the settings store has loaded the reader returns the schema defaults, since those are what the plugin was acting on; `environment` says whether the store was ready, so that case can be told from a user on defaults.

**`sim`** (reader in `@iracedeck/sim-events-iracing`): the translator's view, curated first and raw second.

- `sessionTick`: the `SessionTick` of the translator's latest telemetry. The snapshot writes that same tick as its `telemetry` (section 8), so the two are equal whenever the translator holds a tick; a difference means the snapshot fell back to a fresh read.
- `inReplay`: the controller's debounced replay state (#1324), the read the translator's replay guard makes. While it holds, the guard returns before any diff runs, so the rest of the section is the wiped state.
- `fuel`: the validated lap history, the tracker's in-progress fields, the stats over the callout's window, and `lapsLeft`. See section 5.
- `order`: the canonical live order, the player's live position, the starting grid slots and the race finish result.
- `gaps`, `opponentFlags`, `caution` (phase, episode, lineup): what the existing accessors return.
- `session`: session type, track direction, standing start, pit actions allowed, damage state, race finished.
- `raw`: the whole `TranslatorState`, the instance's own flags and the controller's replay state, through the encoder, with no curation. Field names are the code's and may change in any release.

If building the curated keys throws, the reader returns `{ initialized: true, curatedError, raw }` instead of throwing, so `raw` survives. The reason key is not `error`, which at a section's top level means the collector replaced the whole section.

The section is named `sim`, not `iracing`, so a second simulator's translator registers under the same name.

**`raceEngineer`** (reader in `@iracedeck/audio-scenarios`): the active voice; per audio bus, the fire in flight (id, weight, how far through its clips it is), the focus owner and floor, every waiting fire (id, weight, supersede group, first deferral time, max wait, the leader it queues behind) and an armed pending hold; each contract's last-fired stamp and whether the active voice scripts it; and each callout family's module-level state (the gap and position cooldowns, the furled marker, the opponent pending values, the caution's last-named car, the background test, the radar, spotter and pit-speeding engines' episode state). `IScenarioEngine` gains `describeState()` for the engine half, and each family file with module state exports a reader that `catalog/pit-crew/debug-state.ts` aggregates. The aggregate is exported from the `@iracedeck/audio-scenarios/pit-crew` subpath, not the root barrel, which imports no sim package and must stay that way. `describeState()` reads the compiled scripts as they stand and reports `scriptsDirty` instead of recompiling, since a recompile logs and clears the script pools' no-repeat state. The engine, each family and the engine's two injected reads (the active voice, the frame options) each fail alone, leaving `{ "error": "<reason>" }` in their place; the section itself never carries a top-level `error`.

`collectedAt` at the top is `Date.now()`, the clock every stamp in these sections uses, so an age is a subtraction.

### 5. Laps of fuel left is computed once, in one place

The arithmetic in `diffFuelLapsLeft` (raw laps left, minus margin, minus the remaining lap fraction, floored and clamped) and its race-coverage determination (the lap counter and the timed estimate, whichever binds) move into pure functions in the same module. The diff calls them; the `sim.fuel` reader calls the same functions with the current telemetry and the same stats and margin closures. The diff's behaviour does not change, and its existing tests are the proof.

`sim.fuel.lapsLeft` therefore holds two things, labelled apart:

- `now`: what the callout's formula gives at the snapshot tick (`rawLapsLeft`, `marginLaps`, `effective`, `unclampedCount`, `count`, `remainingLaps`, `covered`). It is `null` when the formula has no usable inputs, which includes a car that is not in the world (`Lap` and `LapDistPct` read -1 there; the callout never meets that case because it samples at mid-lap, but a snapshot is taken at any tick). Outside a race, after the finish and on the player's final lap the count stands and the comparison with the race distance has no meaning: `remainingLaps` and `covered` are `null`, and `coverageSkipped` says which case it was.
- `announced`: the latches (`lastAnnouncedCount`, `lastSampledLap`, `raceCoveredAnnounced`).

The callout samples once per lap at mid-lap, so `now` is not "what was said"; `announced` is. Session Info's Laps to Empty figure is `FuelLevel` divided by the average over that key's own window, and the history in the same section lets support derive it for any window.

### 6. The file on disk

- **One file.** The state goes in the existing `.json`, not beside it. One attachment is what a user will send, and state in the same object as the telemetry is provably from the same press.
- **Compact leaves.** The writer puts an array whose members are all primitives on one line, and likewise an object of at most four primitive members (a trace sample, a position pair), and indents everything else by two spaces. A wider primitive-only object, such as a session-info driver record with fifty keys, stays one key per line, where it is readable. It is still plain JSON and parses identically. Today's files are about 200 KB with every element of every 64-car array on its own line; the raw gap traces alone are up to about 575 samples for each of 64 cars (`GAP_TRACE_SPAN_LAPS` over `GAP_TRACE_MIN_STEP`), which would be several megabytes indented and measures about 2.7 MB with compact leaves for a synthetic full field (the first estimate here, 1.5 MB, was low). The writer lives in `iracing-sdk`'s `snapshot.ts` and the snapshot CLI uses it too, so both producers write the same shape.
- **Size budget: 5 MB.** The figure above is a synthetic worst case, not a race. The measurement that decides it is a snapshot taken mid-race with a field of 60 or more cars; over budget, the reader thins the gap traces and nothing else changes.
- **`schema: 1`** covers the curated sections. It is bumped when a curated key is renamed or removed, never for an addition, and never for anything under `sim.raw`.

### 7. The Markdown companion

`generateMarkdown` takes optional extra sections (`{ title, rows }`). Take Snapshot passes one, **Plugin State**, built from the registered `headline` rows: plugin version and host, fuel per lap and the sample count, laps of fuel left and the last announced count, live position, gaps ahead and behind, caution phase, active voice. A section whose reader failed shows one row saying so, and so does one whose `headline` failed; the collector emits both in the section's place, so the action passes the rows through. A pipe, a backslash or a line break in a cell is escaped, so text the report does not control cannot break its table. The `sim` rows open with one saying so when a replay was on screen, since the figures under it are then not the live race. When the JSON carries an error entry in place of the whole plugin state, the section is one row saying it is unavailable, so the two files never disagree about what was recorded.

### 8. Wiring

- `plugin-runtime` registers all four sections in one place, at the end of `initCore`. Registration only stores a function, and every reader answers for a subsystem that has not started yet (`initialized: false`) instead of throwing, so the registrations need no ordering against the later phases and one file names every section. A snapshot from a plugin whose scenario engine never started says so instead of lacking the section.
- Telemetry Control takes its telemetry from the translator's latest tick (`getLatestTelemetry()`), the tick every figure in `sim` was computed from, and reads the controller afresh only when the translator holds none. The first version of this design read afresh and claimed the two described one tick; a review showed that false for a real share of presses, because `getCurrentTelemetry()` is a new shared-memory read and the controller polls faster than iRacing writes, so a fresh read can be a frame ahead. It then calls `collectStateSections()` with no `await` in between. It then writes the JSON before it builds the Markdown, so a failure in the report leaves the JSON on disk; before, one `try` covered both and a report failure cost both files. It already imports diagnostics for Capture Profile.
- `buildSnapshotEnvelope` takes the collected state as an optional argument, so the CLI's call is unchanged and writes no `pluginState`.

## Alternatives rejected

- **The action calls the existing `getLive*` accessors directly.** They do not expose the fuel history, the laps-left figure, the tire wear report or any latch, and the list of what to dump would live in one action and drift from the packages that own the state.
- **Each package registers itself with diagnostics.** `sim-events-iracing`, `audio-scenarios` and `settings` would each gain a dependency on diagnostics for a debugging feature. Exporting a reader and letting the composition root register it is how diagnostics already learns about iRacing.
- **Raw state only.** Zero maintenance, but support would read internal field names and still not have the laps-left number, which is not a field.
- **Curated only.** The callout latches are what explain a silence, and with the encoder in place the raw dump costs one line.
- **A separate `-state.json`.** Two files to attach, and nothing ties them to the same tick.
- **`null` for `NaN`, as `JSON.stringify` does.** It hides the defect.
- **A deny-list of secret keys in the encoder.** The encoder cannot know what is secret. The package that defines the keys filters them, by a rule that excludes new internal keys by default.

## Out of scope

- State held inside action instances. It is render caches, timers and pit-request bookkeeping; none of it is a race calculation.
- Plugin state from the `telemetry-snapshot` CLI. It is a separate process and has none.
- A snapshot button in the settings window, and SAVED / FAILED feedback on the key. Both are worth their own issues; the key stays log-only here.
- Bundling the plugin log, zipping, or uploading. The user attaches files as today.
- Anonymising driver names or customer ids. Session info already carries them in every snapshot since #635; the website page says what the file contains.
- Reading a snapshot back: loading one into the scenario harness or replaying it through the translator.
- Any stability promise for `sim.raw`.
- A guard that every new module-level variable of a callout family joins the Race Engineer reader. The guard is per file (see Testing): a family file that declares module state must export a reader. Which variables that reader returns is the author's call, and `race-engineer-callouts.md` gains the step. State a line pattern cannot see, a variable in a closure or a `const` object mutated in place, is outside the guard too.

## Testing

Automated:

- **Encoder:** one case per table row; a cycle, a shared non-circular reference, depth 33; and a property test that `JSON.parse(JSON.stringify(encode(x)))` succeeds and equals `encode(x)` for every fixture.
- **Collector:** a throwing reader yields an error entry and leaves the other sections intact; a duplicate name throws at registration; a throwing `headline` drops only its rows.
- **Settings reader:** run over the real settings cache holding `_settingsChannel`, `_voicePacks` and `_warnings`; the output contains the kept keys and no other `_` key, and the token string appears nowhere in the serialised section. A second test adds an unknown `_future` key and expects it gone.
- **Fuel:** the existing `diffFuelLapsLeft` tests pass unchanged after the extraction; a new test drives the diff to an announcement and asserts the reader's `now.count` at that same tick equals the announced count.
- **`sim` reader:** the caution fixture replayed through the translator, then read; `raw` round-trips through `JSON.parse`, and the Sets arrive as arrays.
- **Race Engineer reader:** a fire deferred behind a held bus appears in the waiting list with its group and wait. A source scan of `catalog/pit-crew/` fails for a file that declares module-level `let` state, or a module-level `const` bound to an empty `Map` or `Set`, and exports no state reader; it also fails for a reader the aggregate does not call.
- **Writer:** output parses to the same value as `JSON.stringify` gives; a 64-element number array is one line.
- **Telemetry Control:** `pluginState` is written when the collector succeeds; when it throws, the files are still written with an error entry.
- **Startup order:** `start-plugin.test.ts` records the four registrations, adjacent, at the end of `initCore`.

By hand, in iRacing:

1. In an AI race with at least five laps run, take a snapshot. Check that `sim.sessionTick` equals `telemetry.SessionTick`, that `sim.fuel.history` has the laps just driven, and that `lapsLeft.now.rawLapsLeft` matches a Session Info Laps to Empty key left at its default window.
2. Search the file for the settings window's token (visible in the settings file as `_settingsChannel`). It must not be there.
3. Take a snapshot with a car alongside and a callout waiting; check the waiting fire and the spotter's focus floor are listed.
4. Take a snapshot mid-race in the largest field available and note the file size against the 5 MB budget.
5. Take a snapshot while watching a replay and with iRacing closed: the first writes a file whose `sim` section has `inReplay` true and shows the replay-wiped state (no gaps and no gap traces; the order falls back to plain lap progress) with `fuel.history` kept, the second is skipped with the existing warning.
6. Open the `.md` and check the Plugin State table reads correctly at a glance.
