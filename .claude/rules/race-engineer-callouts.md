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
| **Voice lines (source of truth)** | `packages/audio-assets/configs/<voice-id>.voice.json` — canonical: `default.voice.json`; key parity across voices enforced by `voice-parity.test.ts` |
| **Generated clips** | `packages/audio-assets/voice/<voice>/<group>/<name>.mp3` (gitignored locally; committed once stable) |
| **Generator cache** | `packages/audio-assets/generate.manifest.json` |
| **Runtime manifest** | `packages/audio-assets/manifest.json` (rebuilt by `generate:manifest`) |
| **Bus event catalog** | `packages/event-bus/src/event-catalog.ts` |
| **Bus public exports** | `packages/event-bus/src/index.ts` (export new enums as values, not just types) |
| **iRacing translator** | `packages/sim-events-iracing/src/diff/<name>.ts` + wired into `translator.ts` |
| **Translator state** | `packages/sim-events-iracing/src/state.ts` (TranslatorState type AND createInitialState — keep them in sync) |
| **Audio pools** | `packages/audio-scenarios/src/catalog/pit-crew/pools.ts` |
| **Audio scenarios** | `packages/audio-scenarios/src/catalog/pit-crew/<family>.ts` |
| **Family wiring (id type, key map, scenario id map, registerPitCrew param)** | `packages/audio-scenarios/src/catalog/pit-crew/index.ts` |
| **Per-callout opt-in (Zod field)** | `packages/deck-core/src/global-settings.ts` |
| **PI checkbox row** | `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs` |
| **Plugin closure (live-read)** | `packages/iracing-plugin-stream-deck/src/plugin.ts` AND `packages/iracing-plugin-mirabox/src/plugin.ts` (mirror each other) |
| **Scenario-harness button** | `packages/scenario-harness/src/scenario-shortcuts.ts` |
| **Scenario-harness event template** | `packages/scenario-harness/src/event-names.ts` (compile-time completeness check enforces this) |

## Naming conventions

- **Per-callout opt-in setting key:** `callout<Polarity><Family><Subject>` (`.claude/rules/global-settings.md` is the canonical reference). Polarity is always `Enabled`; the schema field's *default* encodes the family's natural baseline (callouts default `true`). Examples: `calloutEnabledFlagYellowLocal`, `calloutEnabledTrackWetness`.
- **Scenario id:** `pit-crew.<family>-<subject>` — `pit-crew.flag-yellow-local`, `pit-crew.pit-status-too-far-left`, `pit-crew.track-conditions-worsening-mostly-dry`.
- **Pool name:** `<family>-<subject>` — matches the scenario subject. One pool per scenario; arrays of clip paths so future variants append cleanly.
- **Voice clip path:** `voice/{voice}/<group>/<name>.mp3` — group keys the `groups` map in the voice config; name keys the entry inside the group.
- **Family identifier (for preemption):** matches the directory naming: `flag`, `damage`, `pit-status`, `track-conditions`. All scenarios in a family share the same `family:` value, so a newer fire supersedes an in-flight one cleanly.

## Adding a new callout — checklist

When adding to an existing family (e.g. another flag colour) you skip steps 1–2 and the bus-side wiring; when introducing a brand-new family you do all of it.

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

In `packages/audio-assets/configs/default.voice.json` (and every other voice file — `voice-parity.test.ts` enforces matching `<group>/<entry-name>` sets across voices, even though text can differ):
- Add (or extend) a group with one entry per `(direction × subject)` combination.
- Each entry: `name` (kebab-case, suffix `-01` so future variants append as `-02`), `text`, optional `seed` for reproducibility, optional `previous_request_ids` to bias prosody continuity.
- Use `<break time="0.3s" />` for natural pauses inside a single line.
- Per-entry overrides for `model_id`, `language_code` (inside `voice_settings`), `output_format`, normalization flags etc. are supported and shallow-merge on top of the voice's defaults.

Generate the clips:

```bash
pnpm --filter @iracedeck/audio-assets generate --group <group-name>     # only the new group
pnpm --filter @iracedeck/audio-assets generate:manifest                  # rebuild runtime manifest
```

Each `configs/<voice-id>.voice.json` is the per-voice source of truth — voices are self-contained, no cross-voice fallback. `generate.manifest.json` is the per-voice hash cache (keys include `voice/<voice-id>/…` so changing one voice's settings invalidates only that voice's entries). `manifest.json` is the runtime asset listing. The `--group` filter keeps the generator from re-cutting unrelated entries (and saves API cost); `--voice <id>` scopes to one voice. ElevenLabs is a paid API — never run unfiltered `generate` casually.

### 4. Audio pools + scenario

- Add one pool per `(direction × subject)` to `packages/audio-scenarios/src/catalog/pit-crew/pools.ts`. Single-element pools are deterministic; multi-element pools rotate per-pool.
- Write a scenario file under `packages/audio-scenarios/src/catalog/pit-crew/<family>.ts`. Mirror `flag-alerts.ts` / `pit-status.ts` / `track-conditions.ts`. Each scenario has:
  - `id: "pit-crew.<family>-<subject>"`
  - `family: "<family>"` (shared across the whole family for preemption)
  - `priority: "normal"` (use `"urgent"` + `preempt: true` only for safety-critical lines like meatball)
  - `sequence: ["@pit-crew.radio-open", "pool:<name>", "@pit-crew.radio-close"]`
  - `when: { event, where: (e) => …predicate… }`
- Export `<FAMILY>_ALERTS` (readonly array) and `<FAMILY>_SCENARIO_IDS` / `<FAMILY>_POOL_NAMES`.

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

### 7. Property Inspector row

In `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs`:
- Inside the Race Engineer Callouts accordion, add (or extend) an `sdpi-item` for the family.
- Use the auto-balancing 2-column grid pattern already in the file: build the array of `{ setting, label }` once, then map to `<sdpi-checkbox>` rows. The grid template comes from `Math.ceil(items.length / 2)` so it scales without per-row maintenance.

### 8. Plugin closure (BOTH plugins)

In **both** `packages/iracing-plugin-stream-deck/src/plugin.ts` AND `packages/iracing-plugin-mirabox/src/plugin.ts`:
- Import the `<FAMILY>_CALLOUT_SETTING_KEYS` map and `<Family>CalloutId` type.
- Pass a closure to `registerPitCrew` that reads the setting **live on every event arrival**:

```ts
(id: <Family>CalloutId) =>
  (getGlobalSettings() as Record<string, unknown>)[<FAMILY>_CALLOUT_SETTING_KEYS[id]] !== false,
```

Live-read (don't capture the value) — a mid-session toggle takes effect on the next event without re-registering scenarios.

### 9. Update test fixtures

- `packages/deck-core/src/simhub-service.test.ts` constructs an exhaustive `getGlobalSettings()` mock for every callout key. Add the new keys there or the type-check fails at build.
- `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts` calls `registerPitCrew(...)` positionally. When you insert a new closure parameter, the existing master-gate argument shifts — add `undefined` (or a stub) at the new position to keep the master in the right slot.

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

- **Track Conditions / Wetness change** — issue #526. End-to-end example covering a brand-new family with a new bus enum, directional predicate, single per-callout opt-in covering multiple subjects.
- **Flag callouts** — issue #467. Per-subject opt-in (one boolean per flag colour); scope-aware predicate (`yellow.scope`); session-type branching (green/white/checkered).
- **Pit-service status** — issue #479. Per-target opt-in across eight subjects; sentinel suppression (* → None).
- **Damage** — issue #489. Single-subject family; debounced rising-edge detection in the diff.
- **Pit readback** — issues #476 / #481. Compositional scenarios (multiple pools per fire) and snapshot-at-fire-time pattern.
- **Session start ("car entry")** — issue #542. Single-subject family on the existing `driver.firstOnTrack` event; snapshot-at-fire-time conditions (`getSessionStartConditions()`) composed with the PI driver-name pick in each plugin; dynamic clips resolved via `engine.defineVar` (`registerSessionStartVars`) rather than enumerated `if` branches; a conditional clause (pit speed) gated on a curated value set.
- **UI-side acknowledgment (Race Engineer toggle)** — issue #554. Not a sim-event-driven callout — the scenario engine isn't involved. The Pit Crew action's `toggleRaceEngineer()` plays "going silent" / "resuming" directly via `playVoiceSequence(...)` on `AudioChannel.Voice`, gated by a per-callout opt-in (`calloutEnabledToggleRaceEngineer`). Reuses the same `in-flight` bypass shape as the PI Voice Test (`raceEngineerToggleInFlight` ↔ `raceEngineerTestInFlight`) so `applyRaceEngineerAudio` leaves Voice audible after the master gate flips off, until the ack clip finishes. Reach for this pattern when a Stream Deck button itself needs to speak a confirmation; reach for the scenario-engine pattern when telemetry should drive the speech.
- **SDK-connection ack (Telemetry-connect radio check)** — issue #554 follow-up. Triggered by a real-time signal that isn't on the event-bus catalog: the SDK controller's connection state (false→true transition). Each Pit Crew instance subscribes to `sdkController` with its own id (`pitCrewRadioCheck:<contextId>`); a module-scope `lastTelemetryConnected: boolean | null` dedups so the ack fires once per real transition no matter how many Pit Crew buttons happen to be mounted. Disconnect flips the tracker back so reconnects re-fire. Composes the active driver-name clip + a new `toggle/radio-check-01` clip via `playVoiceSequence(...)`. No in-flight bypass needed (master gate is on by definition when this fires; gate-off short-circuits before playback). Use this pattern when a non-event-bus signal (connection state, app monitor, settings change) should drive a one-shot callout, with care to dedup across action instances at module scope.
- **Lap time (best lap)** — issue #555. Single-subject family on a new `lap.completed` bus event with a rich payload (`{ lap, lapTime, isBest, isFirstValid, bestLapTime?, previousBestLapTime?, lapsRemaining?, timeRemaining?, sessionType? }`). Time readout composed from `lap-time-intro` + `lap-time-minute` + `lap-time-second` + `lap-time-decimal` clips via `engine.defineVar` (`registerLapTimeVars`); a conditional `{ if }` step skips the minute clip for sub-1-minute laps; `where:` filters on `isBest && lapTimeIsSpeakable(lapTime)` so off-range laps stay silent rather than producing a partial readout. The snapshot resolver is **plugin-owned** (a `lap.completed` subscription that caches the latest payload) rather than translator-owned, because the data is frozen in the event itself rather than read from live telemetry. Triggered by `LapLastLapTime` changing (the field iRacing refreshes when a lap completes) rather than `LapCompleted` incrementing — the counter races the time-field refresh and produces stale duplicate emissions.
- **Race start** — issue #568. Single-subject family that **replaces** session-start in race sessions: the existing session-start scenario's `where:` returns false when `sessionType === "race"`, and race entries are spoken exclusively by the new race-start scenario fired off `session.changed` (~3 s after the transition lands, before the driver even has to leave the garage). Reuses an existing bus event rather than introducing a new one — the trigger is `session.changed` filtered by `classifySessionType(getSessionType()) === "race"`, anchored on the per-session reset hook (`resetPerSessionState`) from #564. Demonstrates **clip-group reuse across families** — the conditions brief (track temp / air temp / wetness intros, integer temp clips, wetness state clips, degrees-unit clips) re-points at the existing `session-start`, `session-start-temp-numbers`, and `position-number` groups so the new clips ship as only 3 entries (`time-to-race-01`, `starting-from-pole-01`, `qualifying-put-us-to-01`). Position clause uses a **two-branch conditional** — P1 picks a pre-recorded "Starting from pole. Well done." single clip; P2..POSITION_MAX composes "Qualifying put us to," + `position-number/<n>`; out-of-range or missing positions skip the clause entirely so the greeting + conditions still play. Snapshot is **plugin-composed** (telemetry-derived `RaceStartConditions` + PI driver-name pick), translator exposes `getRaceStartConditions()` without the pit speed limit (race start doesn't speak it). Family `race-start` (distinct from `session-start`) reserves the namespace for future race-only openers (wet-race brief, formation-lap brief) so a future addition can preempt this scenario without affecting practice / qualifying.
- **Race status + race end** — issue #569. Two families on the same trigger model: race-status (`lap.completed` `where:` filters on `sessionType === "race" && lapsSincePositionChange > 0 && lapsSincePositionChange % 3 === 0 && !getRaceFinishedFired()`) plus race-end (`race.finished`, a once-per-session latched event the translator emits on the first lap.completed after the checkered raises in a race). Demonstrates **payload extension as cadence anchor** — `lap.completed.lapsSincePositionChange` is computed in `diffLaps` from `state.lastPositionChangeLap`, anchored on the driver's first valid lap (no change yet) so a hold-position-from-start driver still hears every-3 status updates; the same field acts as both the cadence counter (race-status) and the change-detection signal (position-change). Race-end uses a **latch-once event** rather than a transient — the diff emits race.finished only on a successful position read so a missing-position lap defers the latch and the next lap.completed retries. Cross-scenario coordination via a **state-field resolver** (`isRaceFinished()`) lets race-status's `where:` suppress on the final lap without inter-scenario coupling — the diff publishes race.finished first into the pending queue, so by the time lap.completed's where: runs the latch reads true. Two new bus events (`position.changed` is added as plumbing for future per-change race callouts but has no consumer this issue; `race.finished` is consumed by race-end). Reach for this pattern when a single bus event needs to drive multiple families with different cadence/gating rules, and when one family's fire needs to suppress another's same-tick fire.
- **Overtake gained / lost** — issue #574. Two-event family with mirrored gain/loss semantics. **Bus event extension instead of a new shape** — `overtake.completed` was extended with position context (`position`, `previousPosition`, `gapBehindMeters`, `isLeader`, plus the class-position fields) rather than introducing a separate `overtake.gained` event, because the gain side already existed; the new `overtake.lost` parallels it for the loss direction. **Physical-gap gating in the translator** — on top of the existing `OVERTAKE_HOLD_MS = 3000` sustainment + `OVERTAKE_MAX_JUMP = 3` sim-glitch filter, a 10 m (`OVERTAKE_MIN_GAP_M`) distance check between the player and the relevant neighbour (whoever's now immediately behind for a gain; immediately ahead for a loss) postpones emission rather than dropping it — pending state is held until the gap opens up. Computed from `CarIdxLapDistPct` × parsed track length (cached on `TranslatorState.trackLengthMeters` keyed by `(TrackID, SessionNum)` so a track change invalidates the cache). When track length isn't parsed yet, the gate is treated as unknown and emission proceeds — don't punish missing data. **Driver-name composition from a dedicated per-name clip group** — the loss line's "Come on, &lt;name&gt;." slot is a full per-name clip from the `position-overtake-come-on` group (one entry per driver name + a `driver` fallback), resolved via `resolveActiveDriverName(driverNames, "driver")` so the line stays complete even when the user's name isn't recorded. Originally (#542/#574) this slot reused the `session-start-greeting/<driverName>.mp3` pool, but those clips carry an "Ok, &lt;name&gt;," greeting prefix, so the spliced line played "Come on, Ok, Niklas. Don't give up..." — #591 replaced the splice with purpose-recorded "Come on, &lt;name&gt;." clips and dropped the generic `come-on-01` from the sequence. **Two scenarios under a shared `family: "overtake"`** so a fast sequence of swaps doesn't stack stale callouts — the engine preempts the in-flight family-mate when a fresher fire arrives. Reach for this pattern when extending an existing event with new payload fields (vs. introducing a parallel event), when a gate needs to *postpone* rather than *drop* a pending fire while waiting for an external condition, and when a callout needs to compose with a per-user dynamic clip that already has a pool. The shared "We're currently P[n]" readout (live position at speak-time + cross-trigger cooldown) lives in `position-readout.ts` and is reused by overtake, lap-completed (#566), and race-status (#569) — see the `POSITION_CURRENTLY_CLIP` constant + `tryClaimPositionAnnouncement` cooldown.
- **Multi-class overtake detection** — issue #588. Demonstrates **keying change-detection on the position that's actually spoken**. The overtake diff originally detected on OVERALL position (`calculateRacePositions[playerCarIdx]`), but in a multi-class race the overall rank churns as other-class cars pass / pit / lap even while the driver holds station in class — so a steady class-leader heard an endless stream of "we lost a position / we're currently P[class]" (the readout already speaks CLASS position in multi-class via `selectLivePosition`). Fix: `diffOvertakes` computes `useClass = isMultiClass === true && rawClassPos > 0` and runs all change-detection / sustainment on `currentPos = useClass ? classPos : overallPos` against a `lastEffective` baseline; single-class is byte-identical (still overall). The payload keeps overall `position`/`previousPosition` and class `classPosition`/`previousClassPosition` (consumers read class in multi-class); `isLeader` stays overall ("leading the race" ≠ class P1). The physical-gap gate is skipped in multi-class — the class neighbour can't be found from the overall `positions` array, and a class change sustained for the hold window is already a real overtake. Reach for this pattern when a callout's *detection* signal and its *spoken* value must be the same projection of multi-dimensional telemetry (overall vs class), and when a gap/neighbour gate doesn't translate to the new projection (skip it rather than mis-compute).
- **Invalid-lap prefix on the position callout** — issue #572. Demonstrates **extending an existing callout with a contextual prefix derived from a new payload field, without adding a new opt-in**. Adds `lapIsValid?: boolean` to the `lap.completed` payload — derived in `diffLaps` from `resolveLapIsValid(telemetry)` which `every`s the four `LapDeltaTo*_OK` flags (`LapDeltaToBestLap_OK`, `LapDeltaToSessionBestLap_OK`, `LapDeltaToSessionOptimalLap_OK`, `LapDeltaToSessionLastlLap_OK` — preserving iRacing's "Lastl" typo) and returns `undefined` when no flag is present so consumers fall through to the existing path on a missing signal. The position scenario wraps its existing `if/then/else` (pole vs intro+number) in a new outer `if/then/else` keyed on `sessionType === "qualifying" && lapIsValid === false`; the invalid branch is composed from static clip steps — a local `POSITION_DIDNT_COUNT_CLIP` ("That lap didn't count.") followed by the shared `POSITION_CURRENTLY_CLIP` (#574's "We're currently") and the existing `position.number` var, beating the pole / "better" branches unconditionally. **Gated to qualifying** so the #574 race path (live position at speak-time + shared cooldown) is untouched — "that lap didn't count" has no meaning in a race where every lap counts; the frozen-snapshot `position.number` resolver returns the qualifying number. No new opt-in key — rides on `calloutEnabledPositionChange` because the invalid prefix is conceptually the same callout with a contextual modifier; if user feedback later wants it independently silenceable, add `calloutEnabledPositionInvalidLap` as a separate subject. Reach for this pattern when the new behavior is a *modifier* of an existing callout (rather than a parallel subject) and the trigger is already on the bus payload.

## Why these rules exist

- **Live-read closures** — a toggle taking effect mid-session is a hard requirement; capturing the value at registration time means re-registering scenarios on every settings change, which the engine can't safely do without dropping in-flight audio.
- **Per-subject opt-in keys** — a future addition gets `default: true` for every existing user via Zod's `.passthrough()`. Array storage and bitmask encodings break this property; per-item booleans don't (`.claude/rules/global-settings.md`).
- **Family preemption** — rapid same-family transitions (yellow→green at restart, TooFarLeft→TooFarRight while parking, MostlyDry→VeryLightlyWet→LightlyWet during a downpour) should never play back-to-back stale callouts. Sharing the `family:` string lets the engine cancel the older fire cleanly.
- **Test fixtures must be exhaustive** — the deck-core simhub test constructs a typed object that must satisfy `GlobalSettings`. Forgetting a new key fails `pnpm build` (tsc strict), not `pnpm test` (vitest esbuild). Always run build before claiming green.
