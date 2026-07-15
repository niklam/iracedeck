# @iracedeck/audio-scenarios

The Race Engineer's voice catalog: scenarios that subscribe to bus events and
play voice clips through `@iracedeck/audio-service`.

See `.claude/rules/race-engineer-callouts.md` for the end-to-end "how to add
a callout" walkthrough that threads this package together with the bus,
translator, audio-assets, deck-core, plugins, and scenario-harness. The notes
below cover the audio-scenarios-only mechanics.

## Engine modules (`src/`)

- `dsl.ts` — the `Scenario` / step types, the `WEIGHT` bands, and step-shorthand resolution.
- `interpreter.ts` — the scenario engine: subscribes scenarios to the bus, expands sequences at fire time (`pickFromPool` with per-pool no-immediate-repeat, `{voice}` substitution, include/var/conditional resolution), and runs the weight/interrupt/queueable scheduler with per-bus focus floors and the single pending slot. Pools register either as manifest-derived (`definePoolFromManifest(name, group, base)` — members are every `voice/<voice>/<group>/<base>-NN.mp3` in the manifest, resolved per active voice at fire time; issue #664) or as explicit clip lists (`definePool`). Expansion runs **before** bus scheduling (`prepareOps`), and a required step resolving to nothing aborts the whole callout (issue #835 — see "Required-step abort" below).
- `validation.ts` — load-time scenario validation on `defineScenario` (clip/pool/var/include existence, include-cycle detection, scheduling-metadata checks — e.g. `resumable` requires `queueable`). Errors disable the scenario; `{voice}`-templated paths are checked against the **reference voice** only (`referenceVoice()` — `default` when present) and a miss just **warns**, since per-voice clip sets may legitimately diverge (issue #664).
- `manifest.ts` — deliberate leaf module breaking the interpreter ↔ validation circular import; defines the `AudioAssetsManifest` shape (`{ clips, ambientLoop, ticks }`) plus the voice / driver-name scanners and `referenceVoice()`.

## Catalog layout

`src/catalog/pit-crew/` — one file per scenario family, plus wiring, shared helpers, two imperative engines, and three non-family singles (tests, where present, are sibling `*.test.ts` files — not every family has one).

- **Wiring & shared:** `index.ts` (id types, setting-key maps, scenario-id maps, `registerPitCrew()`), `pools.ts` (`POOL_REGISTRY`: pool name → manifest `(group, base)` source, plus `registerPools()`), `radio-frame.ts` (the shared `@pit-crew.radio-open` / `@pit-crew.radio-close` include scenarios).
- **Flags & race flow:** `flag-alerts.ts`, `start-lights.ts`, `rolling-start.ts`, `session-start.ts`, `race-start.ts`, `race-status.ts`, `race-end.ts`, `qualifying-invalidation.ts`.
- **Pit:** `pit-approach.ts`, `pit-box.ts`, `pit-exit.ts`, `pit-limiter.ts`, `pit-status.ts`, `pit-window.ts`, `readback.ts`, `service-reminder.ts`, `stall-departure.ts`, `toggle-confirmations.ts`.
- **Position & pace:** `position.ts`, `overtake.ts`, `lap-time.ts` — plus the shared helpers `position-readout.ts` (the cross-trigger "We're currently P[n]" readout + cooldown), `position-range.ts`, and `overtake-gate.ts` (leaf modules, not families).
- **Car & conditions:** `damage-alerts.ts`, `fuel-laps-left.ts`, `incidents.ts`, `track-conditions.ts`.
- **Imperative engines (not scenario families):** `radar-engine.ts`, `spotter-engine.ts` — see the dedicated section below.
- `welcome.ts` — the once-per-car-entry welcome on `driver.firstOnTrack` (~60% greeting probability as a conditional `if` step, optional driver-name clip, start-window tip).
- `tips.ts` — per-lap racing tips in race sessions (25% chance per `lap.started`), start-window (lap ≤ 1) vs mid-race pools; its header notes the behavior drift from the legacy pit-engineer's polling trigger.
- `background-test.ts` — the PI Background-volume Test-button preview (tick-open + ambient loop + tick-close on the Background bus).

One file per family. Each family file:
- Exports `<FAMILY>_ALERTS: readonly Scenario[]`.
- Exports `<FAMILY>_SCENARIO_IDS: readonly string[]` and `<FAMILY>_POOL_NAMES: readonly string[]` for tests.
- Uses a small constructor function (e.g. `flagScenario(id, body)`) to build scenarios with consistent `family:` / `weight:` / `bus:` defaults.

Per-family issue history lives in `.claude/rules/race-engineer-callout-examples.md` — pointers for the families previously documented at length here:

- **`start-light`** (`start-lights.ts`) — exports `START_LIGHT_ALERTS` (6 scenarios: 2 gantry lines + 4 countdown marks off the single `startLight.countdown.raised { seconds }` event) plus the ids/pools lists; two grouped opt-ins (`calloutEnabledStartLights` / `calloutEnabledStartCountdown`). The gantry lines gate on `isLiveOnTrack` (in-car only); the countdown marks deliberately don't — they're the "get in the car" reminder and play from the garage / session screen / replay view too (#829, saved replays suppressed translator-side). See the #480 / #666 / #673 / #829 entries in the examples rule.
- **`rolling-start`** (`rolling-start.ts`) — exports `ROLLING_START_ALERTS` (1 scenario, subject `pace-car`) plus the ids/pools lists; one opt-in (`calloutEnabledRollingStartPaceCar`). See the #660 entry.
- **Expanded `flag` family** (`flag-alerts.ts`) — the #467 colour flags plus driver-black, race-progression, and caution-waving scenarios, one per-subject `calloutEnabledFlag*` opt-in each. See the #480 / #657 entries.
- **Yellow-cleared delivery + waving debounce** — `YELLOW_CLEARED` is `queueable: true` (one-shot event, replays at idle instead of dropping); the waving scenarios carry `cooldown: WAVING_FLAG_COOLDOWN_MS` (30 s, exported from `flag-alerts.ts`). See the #671 entry.

> **Snapshot-driven variation (issue #558).** A family whose lone scenario reads a runtime resolver in its `where:` predicate or conditional `if` steps cannot build that scenario at module-load time. Such a family exports a `buildXxxScenario(getSnapshot)` builder (plus a `registerXxxVars(engine, getSnapshot)` that registers its `engine.defineVar` clip resolvers) **instead of** a static `<FAMILY>_ALERTS` array — the lone scenario is materialized at wiring time inside `registerPitCrew()`. It still exports `<FAMILY>_SCENARIO_IDS: readonly string[]` and `<FAMILY>_POOL_NAMES: readonly string[]` (the latter `[]` when the readout is composed from `engine.defineVar` resolvers / static `clipPath` steps rather than pools), and still uses the small constructor helper for the shared `family:` / `weight:` / `bus:` defaults. Reference files: `session-start.ts` and `lap-time.ts`.

## Pools

Pools are **config-driven** (issue #664): a pool is *all clips sharing a base
name* — `voice/<voice>/<group>/<base>-NN.mp3` — derived per-voice from the
runtime audio-asset manifest. `POOL_REGISTRY` in `pools.ts` maps each logical
pool name to its `(group, base)` source and carries **no clip lists and no
counts**; adding or removing a variant (or bringing up a partial voice) is a
clip-file change in `@iracedeck/audio-assets` with no code edit. Scenarios
reference pools by name — `"pool:<name>"` in a sequence step, or
`{ pool: "<name>" }` in a step object — exactly as before.

- Members resolve **at fire time for the active voice**. Voices may carry
  different variant counts or omit a pool entirely — a required pool that is
  empty for the active voice **aborts the whole callout** (issue #835, debug
  log, not an error): never a half-sentence. Wrap genuinely-optional clauses
  in `{ optional: [...] }` to skip locally instead (see "Required-step abort"
  below).
- Single-member pools resolve deterministically; multi-member pools are
  **sampled uniform-random** with a per-pool no-immediate-repeat guard
  (`pickFromPool`), shared across every scenario that draws from the pool.
  The tracker resets when the active voice changes, since variant counts
  differ across voices.
- Typo guard: a registry entry whose `(group, base)` matches no clip for the
  **reference voice** (`default`) warns at registration without disabling
  anything.
- Every pool is registry-derived — the last enumerated remainder (the two
  acknowledgment pools) moved into the registry with the #837 rename
  migration (`acknowledgment/acknowledgment-NN`, `pit-actions/acknowledgment-NN`).

## Scenarios

A `Scenario` (see `src/dsl.ts`) binds:
- `id` — `pit-crew.<family>-<subject>`.
- `when: { event, where? }` — bus event filter. The `where:` predicate runs at event arrival; return `false` to skip.
- `family:` — shared identifier for same-family preemption. A newer same-family fire replaces the in-flight family-mate wholesale, **regardless of weight** (it is NOT stashed for replay).
- `weight?:` — higher weight wins a busy bus. Named bands are exported from `dsl.ts` as `WEIGHT`: `TRANSIENT = 5`, `CHATTER = 10`, `NORMAL = 50` (the default when `weight` is omitted), `SAFETY = 70`, `CRITICAL = 100`. Any integer is allowed — scheduling importance is a tunable number, not a fixed enum.
- `interrupt?:` (default `false`) — when a fire wins a busy bus over an in-flight LOWER-weight fire, `true` cuts that line mid-sentence immediately; `false` waits for the current line to finish, then plays. Equal/lower-weight fires never cut.
- `queueable?:` (default `false`) — when a fire can't take the bus right now (equal/lower weight, or below a focus floor), `true` defers it for replay when the bus next idles; `false` drops it. One pending slot per bus (highest-weight waiting fire, ties → newest). Deferred replays do NOT re-run `where:` — when a queued fire's *validity* (not just freshness) can expire while it waits, wrap the whole sequence in an `if:` step (`if:` expands at speak time; empty expansion plays nothing). Reference: the furled pairing in `flag-alerts.ts` (#669).
- `resumable?:` (default `false`, requires `queueable: true` — validated at load time) — an interrupt-cut fire resumes from the interrupted clip at idle-replay instead of re-firing from the top; the replay re-expands first and falls back to a full fresh replay when the expansion changed (#758). Deterministic sequences with side-effect-free `if:` predicates only (the pit-service readback is the reference).
- `pendingHoldMs?:` — after this fire finishes, hold the bus's pending replay for N ms so a train of related fires (the pit-box count-in marks) doesn't let the displaced line stutter back into its gaps (#758). A new fire taking the bus cancels the hold; it re-arms at that fire's finish.
- `focusOwner?:` — marks a scenario as belonging to an exclusive-focus owner. `IScenarioEngine.acquireFocus(bus, ownerId, floorWeight)` / `releaseFocus(bus, ownerId)` raise a per-bus weight floor: while held, only fires at or above the floor — or the owner's own (`focusOwner === ownerId`) — play; everything else defers (if `queueable`) or drops, and releasing drains any deferred fire.
- `sequence:` — ordered steps. The full sequence is `[@pit-crew.radio-open, …body…, @pit-crew.radio-close]` for everything that should sound like radio chatter; the radio frame is itself an include scenario.

Field-by-field guidance on when to reach for each scheduling knob is in `.claude/rules/race-engineer-callouts.md` (step 4).

## Required-step abort + `{ optional: [...] }` (issue #835)

At fire time, every clip-producing step (clip / var / pool / connector) is checked against the manifest for the **active voice**. A required step that resolves to nothing — missing clip, null var, empty pool — **aborts the entire callout**: nothing plays, never a fragment, and no cooldown is stamped. The abort is decided **before** any bus scheduling or preemption (`prepareOps` runs ahead of the cancel in `attemptFire`), so a callout that would have preempted an in-flight one but then aborts can never silence it. A deferred (queueable) fire re-runs the check at idle-replay.

`{ optional: [steps…] }` marks a genuinely-optional clause: if any member resolves to nothing, the **whole group** is skipped locally (never half a clause) and the rest of the callout plays. Reserve it for self-contained add-on sentences, never a step mid-sentence. Current optional clauses: the session-start pit-speed clause, the session/race-start temperature clauses and the race-start position clause (issue #836 — value ranges derive from the clips, no clamping or bounds), the session/race-start setup-warning nudges, the name-based greetings (session-start / race-start / race-end — driver names are a union across voices, so a per-voice name gap must not kill the brief), and the overtake-lost "Come on, `<name>`." opener.

## Value pools — `poolRef(group, base)` (issue #836)

Value-indexed clips (position numbers, lap-time digits, temperatures, speeds, names, and the fixed result/intro lines) are **pools too, usually of size 1**. A `var` resolver returns `poolRef(group, base)` (from `dsl.ts` — the `pool:<group>/<base>` reference form) instead of a raw clip path; the interpreter derives the pool's members from the manifest for the active voice at fire time — every `<base>-NN.mp3` **plus the bare `<base>.mp3`** (a bare value clip is a size-1 pool, so no rename migration was needed). Consequences:

- **No hardcoded value ranges.** The former `SESSION_START_SPEED_VALUES`, temp clamps, `POSITION_MAX` / `POSITION_NUMBER_MAX`, and `LAP_TIME_MINUTE_MAX` constants are gone — the clips that exist define what's speakable. A value with no clip skips its `optional` clause or aborts the callout (per #835). Extending a range is now just generating clips.
- **Variants for free.** Any value clip can gain `-NN` variants (e.g. `currently-01` / `currently-02`) with no code change — the poolRef picks uniform-random with the shared no-repeat guard.
- `where:` predicates keep only **null/known checks** (is there a position at all?), never numeric range checks.

## Live gating

Every voice scenario is wrapped at registration time, outside-in:

1. **Master gate** (`pitCrewRaceEngineerEnabled`) — outermost; one boolean for the whole subsystem.
2. **Per-callout opt-in** (`callout<Polarity><Family><Subject>`) — middle; one boolean per subject.
3. (Family-specific) **engine-internal gate** — innermost; e.g. `getPitActionsAllowed()` cooldown for pit-action confirmations.

All gates are **read live** on every event arrival. A toggle mid-session takes
effect on the next event without re-registering scenarios; an in-flight clip
is never cut by a gate flipping. The gate functions are passed into
`registerPitCrew()` as closures over `getGlobalSettings()`.

## Imperative engines (radar-engine, spotter-engine)

Two files in `src/catalog/pit-crew/` are **imperative engines**, not scenario families: they own a module-level state machine driven by `radar.changed` rather than exporting a `*_ALERTS` scenario array. They differ in how they reach the speaker:

- **`radar-engine.ts`** plays clips **directly** on `AudioChannel.Radar` via `@iracedeck/audio-service` — it never touches the interpreter.
- **`spotter-engine.ts`** (issue #651) **schedules through the interpreter**. Instead of playing directly, each transition computes a clip path into a module variable and fires a single var-driven scenario: `getScenarioEngine().fire("pit-crew.spotter-call")`, where the scenario's lone step is `{ var: "spotterClip" }` (registered via `getScenarioEngine().defineVar("spotterClip", () => pendingSpotterClip)`). **All clip selection is var-driven — no new pools.** Because nothing is enumerated in a pool, the scenario has no dependency on the audio manifest at load time (build/test stay green before the clips are generated). The two engine-owned no-repeat arrays (clear pool, still-there pool) live as module consts inside the engine, *not* in `pools.ts`, for the same reason.

The whole engine is gated by the **Race Engineer master** (`pitCrewRaceEngineerEnabled`, the existing "Race Engineer" toggle button) plus **two per-callout opt-ins** read live on every event/tick: `calloutEnabledSpotterCars` (transition calls) and `calloutEnabledSpotterStillThere` (the "still there" reminder loop — default cadence 3 s, `SPOTTER_STILL_THERE_DEFAULT_SECONDS`, user-configurable 1–10 s via the `spotterStillThereSeconds` global setting, coerced/clamped by `resolveStillThereIntervalMs` and read live each tick), both default ON. The spotter has **no `pitCrewSpotterEnabled` toggle and no Stream Deck mode/button** — it's a Race Engineer voice callout family like flags / position / lap-time. When the master is off, or when **both** opt-ins are off, the engine stays inactive: it acquires no focus floor and fires nothing.

The spotter engine also owns an **exclusive-focus floor**. While any car is alongside it holds `getScenarioEngine().acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY)`. A → clear transition is NOT announced (or the floor released) immediately — `CarLeftRight` flickers at the lateral detection boundary, so the engine buffers the clear and polls the nearest-car gap until it grows by `SPOTTER_CLEAR_BUFFER_METERS` (0.5 m), with `SPOTTER_CLEAR_FALLBACK_MS` (1.5 s) as a fallback timer for sideways separation and an immediate clear when no gap data is available; the floor is released (`releaseFocus(AudioBus.Voice, "spotter")`) when the clear is confirmed, or immediately on force-clear (master off / both opt-ins off / pit road / Lone Qualify — no clip). The floor admits only fires at `WEIGHT.SAFETY` or above — so safety flag callouts still break through while routine chatter is held back — plus the spotter's own fires (matched by `focusOwner: "spotter"` on the `pit-crew.spotter-call` scenario, so a spotter call plays even while its own floor is held). See the #652 weighted-scheduling entry in `.claude/rules/race-engineer-callout-examples.md` for the focus model.

Both engines reuse the existing `radar.changed` bus event (no new event, no translator diff). `registerPitCrew` threads three spotter accessors into `registerSpotterEngine`: `getSpotterStillThereIntervalMs` (plugins wire it to `resolveStillThereIntervalMs` over the live `spotterStillThereSeconds` setting), `getSpotterTrackDirection` (wired to `getTrackDirection()` from `@iracedeck/sim-events-iracing` — road courses speak left/right, ovals inside/outside, resolved per fire), and `getSpotterNearestCarGapMeters` (wired to `getNearestCarGapMeters()`; drives the → clear confirmation buffer — the default `() => null` disables it).

## Adding a subject to an existing family

Adding one more callout to a family that already exists (e.g. another flag colour, or a paired `*-cleared`) needs **no `registerPitCrew` signature change and no plugin change** — the per-family `get<Family>CalloutEnabled` closure is generic over the family's id type, so a new union member routes through it automatically:

1. Add the scenario to the family file and append it to the `<FAMILY>_ALERTS` array.
2. Add its pool to `POOL_REGISTRY` in `pools.ts` — one line mapping the pool name to its `(group, base)`; the clips themselves (`voice/<voice>/<group>/<base>-NN.mp3`) are authored/generated in `@iracedeck/audio-assets`. Adding a *variant* of an existing callout needs no `pools.ts` change at all.
3. In `index.ts`, extend three places: the `<Family>CalloutId` union, `<FAMILY>_CALLOUT_SETTING_KEYS` (key: `callout<Polarity><Family><Subject>`), and `SCENARIO_ID_TO_<FAMILY>_ID`.
4. Cross-package companions: the Zod field in `deck-core/src/global-settings.ts` (default `true`), the PI checkbox row in `pit-crew.ejs`, BOTH exhaustive literals in `deck-core/src/simhub-service.test.ts`, and this package's test fixtures (`<family>.test.ts` + `register-pit-crew.test.ts` — clip-name lists, id lists, fire matrices).
5. If the triggering bus event is new, also add the `scenario-harness` event template (`event-names.ts`, enforced by a compile-time completeness check) and a shortcut button (`scenario-shortcuts.ts`).

## Adding a new family

This is the consumer-side checklist; see the rule
(`.claude/rules/race-engineer-callouts.md`) for the full cross-package flow.

1. New file under `src/catalog/pit-crew/<family>.ts` — scenarios, pool names, scenario-id list.
2. Add the family's `POOL_REGISTRY` entries to `pools.ts` (pool name → `(group, base)`).
3. In `index.ts`:
   - Add `<Family>CalloutId` (type union of subject ids).
   - Add `<FAMILY>_CALLOUT_SETTING_KEYS: Record<<Family>CalloutId, string>` — exported so plugins can read it.
   - Add `SCENARIO_ID_TO_<FAMILY>_ID: Record<string, <Family>CalloutId>` — covers every scenario id in the family.
   - Add `get<Family>CalloutEnabled` parameter to `registerPitCrew` (default `() => true`) — placed **before** the master-gate parameter so the master stays last among per-callout opt-ins. Inserting between existing parameters shifts master-gate's index, so test fixtures that call `registerPitCrew` positionally need `undefined` inserted at the new slot (`register-pit-crew.test.ts`).
   - Wrap the family's scenarios with `wrapWithMaster(wrapCalloutScenario(...))` in the registration loop.

## Conventions

- **Scenario id:** `pit-crew.<family>-<subject>`. The translator does NOT see this id; it's the audio-side convention. The compile-time completeness check in `<FAMILY>_SCENARIO_IDS` catches typos.
- **Pool name:** `<family>-<subject>`. Mirrors the scenario naming so a grep on the family prefix finds both halves. The name does **not** have to equal the manifest `<group>/<base>` (`flag-blue` → `flags`/`blue`; `start-light-ready` → `start-lights`/`start-ready`) — `POOL_REGISTRY` carries the mapping.
- **Family identifier (`family:` field):** matches the file/scenario prefix without the `pit-crew.` namespace. So `flag-yellow-local` has `family: "flag"`, `track-conditions-worsening-mostly-dry` has `family: "track-conditions"`.

## Testing

Many (not all) family files have a sibling `<family>.test.ts`. The cross-cutting
wiring test is `register-pit-crew.test.ts` — it stands up the engine with a real
bus and asserts that every gate (master, per-callout, engine-internal) actually
suppresses dispatch. When you add a closure parameter to `registerPitCrew`,
update the positional call there or every existing test fails.
