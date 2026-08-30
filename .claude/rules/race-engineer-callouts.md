---
paths:
  - "packages/event-bus/**"
  - "packages/sim-events-iracing/**"
  - "packages/audio-scenarios/**"
  - "packages/audio-assets/**"
  - "packages/scenario-harness/**"
  - "packages/deck-core/src/global-settings.ts"
  - "packages/iracing-actions/src/actions/pit-crew/**"
  - "packages/iracing-plugin-stream-deck/src/plugin.ts"
  - "packages/iracing-plugin-mirabox/src/plugin.ts"
  - "packages/iracing-plugin-ulanzi/src/plugin.ts"
---
# Race Engineer Callouts

How to add or modify a Race Engineer voice callout. This threads through six packages — once you've done it, the per-package details below are checklist material.

## Architecture at a glance

```text
iRacing telemetry (TrackWetness, PitSvStatus, …)
        │
        ▼ diff module — `packages/sim-events-iracing/src/diff/<name>.ts`
@iracedeck/event-bus  ───────────────────────────────────►  publishes a SimEvent
        │                                                   on `IEventBus`
        ▼ scenario `where:` predicate
@iracedeck/audio-scenarios  ─────────────────►  selects pool, expands sequence
        │                                       wraps with master-gate + opt-in
        ▼ pool resolves to `voice/<voice>/…/<name>.mp3`
@iracedeck/audio-assets  ───────────────────►  ElevenLabs-generated clips
        │
        ▼ playback via `@iracedeck/audio-service`
Driver hears the line.
```

Six layers, one direction. The **opt-in** wraps the scenario's `where:` so a
toggle at the Property Inspector silences future fires without cutting an
in-flight clip; the **master gate** (`pitCrewRaceEngineerEnabled`) wraps every
voice scenario as the outermost short-circuit.

## Where things live

| Concern | File |
|---|---|
| **Voice lines (source of truth)** | `packages/audio-assets/configs/<voice-id>.voice.json` — canonical: `default.voice.json`; voices may differ in variant counts and omit callouts (issue #664), `voice-parity.test.ts` only guards against `<group>/<base>` keys unknown to default |
| **Generated clips** | `packages/audio-assets/voice/<voice>/<group>/<name>.mp3` (gitignored locally; committed once stable) |
| **Generator cache** | `packages/audio-assets/generate.manifest.json` |
| **Runtime manifest** | `packages/audio-assets/manifest.json` (rebuilt by `generate:manifest`) |
| **Bus event catalog** | `packages/event-bus/src/event-catalog.ts` |
| **Bus public exports** | `packages/event-bus/src/index.ts` (export new enums as values, not just types) |
| **iRacing translator** | `packages/sim-events-iracing/src/diff/<name>.ts` + wired into `translator.ts` |
| **Bundled track datasets (corner markers)** | `packages/track-data/` — committed snapshot + resolver + attribution constants; refresh via `scripts/refresh-corner-data.mjs` (issue #888) |
| **Translator state** | `packages/sim-events-iracing/src/state.ts` (TranslatorState type AND createInitialState — keep them in sync) |
| **Audio pools** | `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` — `POOL_REGISTRY` maps pool name → manifest `(group, base)`; members (`<base>-NN.mp3`) derive per-voice from the manifest at fire time (issue #664) |
| **Audio scenarios** | `packages/audio-scenarios/src/catalog/pit-crew/<family>.ts` |
| **Family wiring (id type, key map, scenario id map, registerPitCrew param)** | `packages/audio-scenarios/src/catalog/pit-crew/index.ts` |
| **Per-callout opt-in (Zod field)** | `packages/deck-core/src/global-settings.ts` |
| **Callout checkbox row** | `packages/pi-components/partials/race-engineer-callouts.ejs` (settings window only since #1003 — `pit-crew.ejs` carries no callout rows) |
| **Plugin closure (live-read)** | `packages/iracing-plugin-stream-deck/src/plugin.ts`, `packages/iracing-plugin-mirabox/src/plugin.ts`, AND `packages/iracing-plugin-ulanzi/src/plugin.ts` (byte-identical in code — mirror each other) |
| **Scenario-harness button** | `packages/scenario-harness/src/scenario-shortcuts.ts` |
| **Scenario-harness event template** | `packages/scenario-harness/src/event-names.ts` (compile-time completeness check enforces this) |

## Naming conventions

- **Per-callout opt-in setting key:** `callout<Polarity><Family><Subject>` (`.claude/rules/global-settings.md` is the canonical reference). Polarity is always `Enabled`; the schema field's *default* encodes the family's natural baseline (callouts default `true`). Examples: `calloutEnabledFlagYellowLocal`, `calloutEnabledTrackWetness`.
- **Scenario id:** `pit-crew.<family>-<subject>` — `pit-crew.flag-yellow-local`, `pit-crew.pit-status-too-far-left`, `pit-crew.track-conditions-worsening-mostly-dry`.
- **Pool name:** `<family>-<subject>` — matches the scenario subject. One pool per scenario. A pool's members are all clips sharing its `(group, base)` — `voice/<voice>/<group>/<base>-NN.mp3` — so future variants are clip-file additions with no code change (issue #664). The pool name need not equal `<group>/<base>` (`flag-blue` → `flags`/`blue`); `POOL_REGISTRY` carries the mapping.
- **Voice clip path:** `voice/{voice}/<group>/<name>.mp3` — group keys the `groups` map in the voice config; name keys the entry inside the group.
- **Family identifier (for preemption):** matches the directory naming: `flag`, `damage`, `pit-status`, `track-conditions`. All scenarios in a family share the same `family:` value, so a newer fire supersedes an in-flight one cleanly.

## Adding a new callout — checklist

When adding to an existing family (e.g. another flag colour) you skip steps 1–2 and the bus-side wiring; when introducing a brand-new family you do all of it.

**An SFX cue is not a scenario, and skips steps 3–5 entirely** (issue #912, the first one). A cue that must react instantly plays direct from an imperative engine — `getAudio().playOnChannel(...)`, the `radar-engine.ts` model — instead of firing through the interpreter, so it has no voice lines, no pool, no scenario, no `SCENARIO_ID_TO_*` map and no `wrapCalloutScenario` loop. It still needs everything else: the bus event (1), the diff and state (2), the family id + setting-key map and the `registerPitCrew` parameter (5's wiring half), the Zod field (6), the checkbox row (7), all three plugin closures (8), the fixtures (9) and the harness entries (10). The opt-in is read live inside the engine's own tick rather than by a scenario wrapper. Note what direct playback costs and buys: no weight, family or focus contest — so nothing to tune against other callouts, but equally no interpreter to keep it from overlapping one.

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

In `packages/audio-assets/configs/default.voice.json` (other voices *may* add the same entries with their own wording, but don't have to — a voice without a clip skips that callout; `voice-parity.test.ts` only rejects `<group>/<base>` keys unknown to default, issue #664):
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

### 4. Audio pools + scenario

- Add one `POOL_REGISTRY` entry per `(direction × subject)` to `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` — pool name → `(group, base)`, no clip lists. The pool's members are derived per-voice from the manifest (`voice/<voice>/<group>/<base>-NN.mp3` plus the bare `<base>.mp3`, issue #836) at fire time, so adding a *variant* later is a clip-file change only. Single-member pools are deterministic; multi-member pools are sampled uniform-random with a per-pool no-immediate-repeat guard (the interpreter's `pickFromPool` — not a sequential rotation; the tracker resets on voice change).
- **Value-indexed clips are pools too (issue #836).** A `var` resolver returns `poolRef(group, base)` from `dsl.ts` (the `pool:<group>/<base>` reference form) instead of a raw clip path — position numbers, lap-time digits, temperatures, speeds, and names all resolve this way, usually as size-1 pools. There are **no hardcoded value ranges or clamps**: the clips that exist for the active voice define what's speakable, and a value with no clip skips its `optional` clause or aborts the callout (per #835). Keep `where:` predicates to null/known checks only — never numeric range checks.
- Write a scenario file under `packages/audio-scenarios/src/catalog/pit-crew/<family>.ts`. Mirror `flag-alerts.ts` / `pit-status.ts` / `track-conditions.ts`. Each scenario has:
  - `id: "pit-crew.<family>-<subject>"`
  - `family: "<family>"` (shared across the whole family — a newer same-family fire replaces the in-flight family-mate wholesale, regardless of weight)
  - `weight:` — omit for an ordinary callout (defaults to `WEIGHT.NORMAL = 50`). Use the named bands from `dsl.ts` (`WEIGHT.TRANSIENT = 5`, `CHATTER = 10`, `NORMAL = 50`, `SAFETY = 70`, `CRITICAL = 100`, `PROXIMITY = 120`; any integer allowed) so importance is a tunable number, not a fixed enum. Higher weight wins a busy bus. Flag callouts sit at `WEIGHT.SAFETY` (above routine chatter and a spotter focus floor); the meatball cut-through line is `weight: WEIGHT.CRITICAL` + `interrupt: true`. `PROXIMITY` (#867) is reserved for immediate-danger proximity information that must ALWAYS be heard — the spotter's transition calls are its only occupant; it sits strictly above CRITICAL because an equal-weight fire never cuts, and it pairs with `interrupt: true` + `queueable: false`. Don't put anything informational there: a repeating or non-danger line at PROXIMITY would chop up CRITICAL calls (that's why the spotter's "Clear."/still-there sibling stays at SAFETY).
  - `interrupt:` (default `false`) — `true` cuts an in-flight LOWER-weight fire mid-sentence; `false` waits for the current line to finish. Equal/lower-weight fires never cut. Reserve `interrupt: true` for safety-critical lines (meatball, fuel-critical) that must cut anything in flight.
  - `queueable:` (default `false`) — `true` defers a fire that can't take the bus now (equal/lower weight, or below a focus floor) for replay when the bus next idles; `false` drops it. Use it for background commentary that should wait its turn rather than vanish. The deferred fire replays unconditionally (its `where:` is NOT re-run — a `where:` that commits a side effect, like the position-readout cooldown claim, would fail on a second call); freshness comes from var resolvers reading live state at speak time.
  - `resumable:` (default `false`, requires `queueable: true` — validated at load time) — when an `interrupt` cuts this fire mid-playback, the idle-replay CONTINUES from the interrupted clip instead of re-firing from the top (issue #758). The replay re-expands the sequence first and falls back to a full fresh replay when the expansion changed while stashed (the #481 freshness guarantee). Only for deterministic sequences with side-effect-free `if:` predicates; the pit-service readback is the reference consumer.
  - `pendingHoldMs:` — after this fire finishes, hold the bus's pending replay for N ms so a displaced line doesn't stutter back into the gaps of a train of related fires (issue #758; the pit-box count-in marks are the reference consumer). A new fire taking the bus cancels the hold; it re-arms at that fire's finish.
  - `focusOwner:` (optional) — marks the scenario as belonging to an exclusive-focus owner. The engine's `acquireFocus(bus, ownerId, floorWeight)` / `releaseFocus(bus, ownerId)` raise a per-bus weight floor: while held, only fires with `weight` at or above the floor — or the owner's own (`focusOwner === ownerId`) — play; everything else defers (if `queueable`) or drops. Set the floor to the band you want to admit (e.g. `WEIGHT.SAFETY`). Releasing drains any deferred fire.
  - `sequence: ["@pit-crew.radio-open", "pool:<name>", "@pit-crew.radio-close"]`
  - `when: { event, where: (e) => …predicate… }`
- **Missing → skip the whole callout (issue #835).** At fire time every clip-producing step is checked against the manifest for the active voice; a required step that resolves to nothing (missing clip, null var, empty pool) aborts the entire callout — never a fragment, no cooldown stamped, and never cancelling an in-flight callout (the abort is decided before preemption). Wrap a genuinely-optional clause in `{ optional: [steps…] }` so it skips locally instead — use it only for self-contained add-on sentences (the setup-warning nudge, name greetings, the pit-speed / temperature / grid-position clauses, the incident point-count clause), never for a step mid-sentence.
- Export `<FAMILY>_ALERTS` (readonly array) and `<FAMILY>_SCENARIO_IDS` / `<FAMILY>_POOL_NAMES`.
  - **Snapshot-driven variation (issue #558):** for a family whose lone scenario reads a runtime resolver in its `where:` predicate or conditional `if` steps, export `buildXxxScenario(getSnapshot)` + `registerXxxVars(engine, getSnapshot)` (the latter registers its `engine.defineVar` clip resolvers) **instead of** a static `<FAMILY>_ALERTS` array — the scenario is materialized at wiring time inside `registerPitCrew()` — while still exporting `<FAMILY>_SCENARIO_IDS` / `<FAMILY>_POOL_NAMES`. See `session-start.ts` / `lap-time.ts` for the precedent.

### 5. Family wiring

In `packages/audio-scenarios/src/catalog/pit-crew/index.ts`:
- Add a `<Family>CalloutId` type union of subject ids.
- Add a `<FAMILY>_CALLOUT_SETTING_KEYS: Record<<Family>CalloutId, string>` map — the canonical id↔key map plugins read from.
- Add a `SCENARIO_ID_TO_<FAMILY>_ID` map covering every scenario id in the family.
- Add a `get<Family>CalloutEnabled` parameter to `registerPitCrew` (default `() => true` for tests). Add it **before** the master-gate parameter so the master stays last among the per-callout opt-ins.
- Wrap the family's scenarios with `wrapWithMaster(wrapCalloutScenario(s, …))` in the registration loop.

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
- Pass a closure to `registerPitCrew` that reads the setting **live on every event arrival**:

```ts
(id: <Family>CalloutId) =>
  (getGlobalSettings() as Record<string, unknown>)[<FAMILY>_CALLOUT_SETTING_KEYS[id]] !== false,
```

Live-read (don't capture the value) — a mid-session toggle takes effect on the next event without re-registering scenarios.

### 9. Update test fixtures

- `packages/deck-core/src/simhub-service.test.ts` constructs an exhaustive `getGlobalSettings()` mock for every callout key — in **two** object literals (the main settings mock AND a second `.passthrough()`/round-trip literal further down). Add the new key to **both** or the type-check fails at build (`grep` the existing nearest key to find every literal).
- **Every** `*.test.ts` that calls `registerPitCrew(...)` positionally shifts when you insert a new closure parameter — not just `register-pit-crew.test.ts`. At minimum `register-pit-crew.test.ts`, `rolling-start.test.ts`, and `start-lights.test.ts` pass the rolling-start / start-light / master tail positionally; `grep -rl "registerPitCrew(" packages/audio-scenarios/src` and add `undefined` (or a stub) at the new position in each so the masters stay in the right slot. (Tests that stop before your new param — e.g. `scenario-harness/src/main.ts` ends at the race-start arg — are unaffected.)

### 10. Scenario-harness shortcut

For QA convenience, add a button to `packages/scenario-harness/src/scenario-shortcuts.ts` so the harness UI can fire the event directly (bypassing the diff). Pick a `category` string — group related shortcuts under the same category for the UI.

If the bus event itself is **new**, also add an entry to `packages/scenario-harness/src/event-names.ts`. The compile-time completeness check forces this — `pnpm build` will fail otherwise.

### 11. Verify

```bash
pnpm install
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
- **Test fixtures must be exhaustive** — the deck-core simhub test constructs a typed object that must satisfy `GlobalSettings`. Forgetting a new key fails `pnpm build` (tsc strict), not `pnpm test` (vitest esbuild). Always run build before claiming green.
- **Pre-guard emissions need a non-transient discriminator** — anything published before the `IsReplayPlaying` guard in `translator.ts` (the `session.changed` paths, `driver.firstOnTrack`, and the #829 `diffStartCountdown`) survives replay-mode ticks by design, which is correct for live session transitions (#568) and for callouts that must reach an out-of-car driver (#829), but lets standalone replay viewing leak callouts unless the emission is also gated on a signal that distinguishes "live, transiently in replay mode" from "watching a replay." Use `isReplayOnlySession(sessionInfo)` — a read on `WeekendInfo.SimMode === "replay"` (issue #604). Do not gate on `IsReplayPlaying` — that's the transient #568 is explicitly bypassing. A pre-guard diff that keeps per-tick state must also have that state preserved by `wipeStateForReplay` (the #771/#829 preserved cluster), or the replay edges reset it mid-episode.
