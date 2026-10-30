# Route the callout catalog's sim reads through a declared SimRuntime

> **Issue:** [#1378](https://github.com/niklam/iracedeck/issues/1378) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `e876631a2`. Reviewed by the `architect` agent before implementation; its seven findings are folded in below.

## Problem in one paragraph

`SimRuntime` (`race-engineer-wiring/src/sim-runtime.ts`) is `typeof` 19 iRacing getters, so its surface is whatever `sim-events-iracing` happens to export. The catalog also reads the translator singleton behind it:

- `getLatestTelemetry` in eight families: caution, flag-alerts, pit-limiter, pit-status, race-start, radar-engine, spotter-engine and pit-speeding-engine.
- `getSessionType` in flag-alerts, race-start, radar-engine, spotter-engine and start-lights. Caution and rolling-start reach it transitively through flag-alerts' exported `liveRaceCar` (`flag-alerts.ts:90,107`; imported at `caution.ts:266` and `rolling-start.ts:83`).
- `getStandingStart` in flag-alerts.
- `isDamageRepairNeeded` in damage-alerts.

`plugin-runtime/src/phases/sim.ts` also imports the pit-crew catalog to build a translator option.

## Decision

The catalog reads the sim only through injected dependencies. The wiring fills those dependencies only from `SimRuntime`, which becomes an interface declared member by member. Its payload types stay iRacing's until #714 replaces them, but the surface is now a list in one file.

### 1. `SimRuntime` is declared, not derived

`sim-runtime.ts` declares each member as a method signature, for example `getPaceLineup(): PaceLineup | null` and `getLiveCarPosition(carIdx: number): LiveCarPosition | null`. Payload types are imported type-only from `sim-events-iracing`. The file's only value imports are the getters `createIracingSimRuntime()` assembles, and that function is the one implementation. A type test pins the iRacing getters to the interface.

It gains the four reads listed above. Each read's no-translator value is what the translator returns today when it was never initialised (`translator.ts:386-388, 396-397, 488-491, 569-570`), so injecting nothing changes nothing:

| Member | No-translator value |
| --- | --- |
| `getLatestTelemetry(): TelemetryData \| null` | `null` |
| `getSessionType(): string` | `""` |
| `isStandingStart(): boolean` | `false` |
| `isDamageRepairNeeded(): boolean \| null` | `null` |

**Where the declared sim surface lives** (settled here so #1500 starts from it):

- `SimRuntime` is the Race Engineer's read surface. It stays in `race-engineer-wiring`, and nothing a deck host needs is added to it.
- #1500's session kind, tick subscription and sim-terminated signal go on a separate interface that `plugin-runtime` owns in `types.ts`, beside `PluginExtension`. The Stream Deck shell already depends on `plugin-runtime`, and widening the Race Engineer's interface for one host would make the shell import `race-engineer-wiring`.
- Once #1500 lands, `initSim` returns a record holding both interfaces.

### 2. `PitCrewDeps` carries the reads; families build over one deps closure

`PitCrewDeps` gains `getLatestTelemetry`, `getSessionType`, `getStandingStart` and `getDamageRepairNeeded`. `buildPitCrewDeps` returns `Required<PitCrewDeps>`, so the wiring cannot leave one out. `DEFAULT_DEPS` takes the no-translator values. So does each engine's own `DEFAULT_DEPS` (`spotter-engine.ts:218`, `pit-speeding-engine.ts:114`).

How each kind of family converts:

- **Constant-only families** (damage-alerts, start-lights) become builders that take a narrow `Pick<PitCrewDeps, …>`, following `rolling-start.ts`' `RollingStartContractDeps`.
- **Families where one predicate is both a vocabulary condition and a speak gate or `where`** (flag-alerts' furled gates, pit-limiter's `liveTelemetry`, pit-status' `still*` reads) get one builder per family. It returns `{ registerVocabulary(engine), contracts }` over a single deps closure. #1138 made each such predicate a single definition, and two separately injected calls could drift apart. The scenario-id lists are still derived from a default build, as `ROLLING_START_SCENARIO_IDS` and `CAUTION_SCENARIO_IDS` are. Flag-alerts' `furledRaisedSpoken` latch stays readable by `debug-state.ts`, either module-level or read from the newest build as #1387 does.
- **`liveRaceCar`** becomes a factory over `getSessionType`, built by the flag family. `RollingStartContractDeps` and the caution builder's deps gain `getSessionType` and use it.
- **Engines.** The spotter and pit-speeding engines take the reads through the deps objects they already have. `registerRadarEngine(bus, masterEnabledGetter?)` takes none, so it gets a `RadarDeps` object that follows the spotter's overwrite-on-re-register rule (`spotter-engine.ts:583-598`).
- **`TrackDirection`.** The catalog stops using the translator's enum as a value. `getSpotterTrackDirection` and `SpotterDeps.getTrackDirection` return a structural union the catalog owns (`"neutral" | "left" | "right"`), as `rolling-start.ts:97-99` declares its types structurally. `SimRuntime` keeps the enum, imported type-only. `buildPitCrewDeps` converts it, and a type test pins the enum onto the union.

### 3. A lint rule keeps the direct imports out

`eslint.config.js` sets `no-restricted-imports` for `packages/audio-scenarios/src/**`, test files excepted:

- `@iracedeck/sim-events-iracing` is allowed for type-only imports.
- `@iracedeck/deck-iracing` and `@iracedeck/iracing-native` are banned outright. Nothing imports them today, so the ban costs nothing.

Lint sees imports, not calls. A transitive read like `liveRaceCar`'s is caught only by the `Pick` types in §2, so the rule is a ratchet on direct imports and nothing more.

### 4. The translator options leave the composition root

`initSim` builds `initializeSimEventsIracing`'s six options from Race Engineer settings (`sim.ts:27-61`). One of them maps the bus's `OpponentPenaltyFlag` to a callout id, and it does so through the pit-crew catalog's `OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID`. The scenario harness passes no options at all (`scenario-harness/src/main.ts:66`), so all six run at their defaults there.

- The whole builder moves to `race-engineer-wiring` as `createIracingTranslatorOptions()`, beside `createIracingSimRuntime()`. `initSim` and the harness both call it.
- The opponent-flag part becomes an exported `isOpponentFlagCalloutEnabled(flag)`, typed against the bus enum (`event-catalog.ts:130`), not against `SimEventsIracingOptions`. A second translator's options take the same function. The fall-open rule for an unmapped flag is unchanged.
- In the plugin this changes nothing. In the harness it makes the six settings apply as they do in the plugin.
- Graph changes: a new edge `race-engineer-wiring` → `callout-settings`, and `plugin-runtime`'s `callout-settings` edge goes if nothing else uses it. The Architecture page's graph and its "Seams & where the abstraction leaks" counts change with them.
- `plugin-runtime/src/state-sections.ts` still imports the pit-crew catalog, `deck-iracing` and `sim-events-iracing`. That is out of scope here (see below).

### 5. The remainder, recorded on #714

What still makes the catalog iRacing-shaped after this, measured on the branch and posted as a comment on #714:

- Per family, the `TelemetryData` fields read through `getLatestTelemetry()` and through bus payloads. This is the list a second sim actually has to answer; without it that one member stays a grep.
- The `iracing-sdk` helpers and enums the catalog calls on telemetry: `Flags`, `hasFlag`, `isLiveOnTrack`, `isPreGreen`, `isPostRace`, `isPenaltyFlagActive`, `hasPitLimiter`, `PitSvStatus`, `TrkLoc`, `SessionState`.
- The unchecked `e.telemetry as TelemetryData` casts on bus payloads, with their count.
- The next leaks outside the catalog: `telemetry-control.ts` and `session-info.ts` calling translator getters, and `state-sections.ts`.

## Approaches weighed and rejected

- **Semantic reads instead of raw telemetry** (`isOnPitRoad()`, `getSessionNum()`, and so on). That is the read model #714 owns and gates on a second SDK; doing it here would design it against one sim. `getLatestTelemetry()` on the declared surface is the measured remainder, and the issue allows iRacing-shaped types.
- **Re-exporting `TrackDirection` for the catalog to import as a value.** It would keep iRacing's enum as the catalog's vocabulary and need a lint exception.
- **Two injected predicates per dual-use family** (one for the vocabulary, one for the gate). They could drift apart, undoing #1138, and would keep the "vocabulary before contracts" order a convention.
- **Moving only `isOpponentFlagCalloutEnabled`.** That leaves the harness running five Race Engineer settings at their defaults.
- **Putting #1500's session kind on `SimRuntime`, or moving `SimRuntime` to a new package now.** The first widens the Race Engineer's interface for one host, and the second has no second consumer to justify it (§1).
- **Folding #1500 into this change.** The two meet only at what `initSim` returns, and #1500 adds the Stream Deck shell, `app-constants` and a second manual-test domain. It runs next.

## Out of scope

- The sim-neutral read model, its payloads and encodings (#714).
- Actions calling translator getters directly (`telemetry-control.ts`, `session-info.ts`), and `plugin-runtime/src/state-sections.ts`. These are listed on #714 as the next leaks.
- The Stream Deck shell's session-kind reads and `PluginExtension.start`'s context (#1500).
- Splitting `ScenarioEngine` (#1514).
- The `iracing-sdk` helpers the catalog calls on telemetry, and the bus-payload casts.

## Testing

- **No behaviour change.** The existing catalog, wiring and harness suites pass. Catalog tests that drove the four reads by initialising the real translator now inject them through the deps, and keep their assertions. The scenario-id lists are unchanged, and a test compares them with the lists at `e876631a2`.
- **New unit tests:**
  - `buildPitCrewDeps` routes each new key to the matching `SimRuntime` member, and converts the track direction.
  - A type test pins `createIracingSimRuntime()` to the declared interface, and `TrackDirection` to the catalog's union.
  - `createIracingTranslatorOptions()` covers each of the six options. The opponent-flag case covers a mapped flag that is enabled, one that is disabled, and an unmapped flag (falls open).
  - `RadarDeps` has an overwrite-on-re-register test.
- **Lint rule, positive-controlled.** A value import planted in a catalog file must fail `pnpm lint`, and so must a `deck-iracing` import. A type-only import must pass.
- **Manual:**
  - The scenario harness's shortcut buttons for each touched family: flags, the caution, the rolling start, the pit limiter, pit status, race start and start lights, damage, the spotter and the radar.
  - Then a short in-sim smoke test by Niklas: a practice session for flags, pit lane and the limiter, then a race start for the start lights and the race-start brief.
  - QA writes the script.
