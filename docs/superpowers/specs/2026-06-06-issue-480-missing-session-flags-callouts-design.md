# Issue #480 — Race Engineer callouts for missing `SessionFlags`

Start lights (with numeric countdown), driver black flags, race-progression flags, and caution-waving variants. Adds opt-in Race Engineer voice callouts for the `irsdk_Flags` bits the engineer currently ignores.

## Scope & decisions (locked with the user)

- **Start-light family — INCLUDED, with the numeric countdown.** Driven by the `SessionTimeRemain` signal validated against the 2026-06-04 captures (see Telemetry findings). Discrete single-clip callouts; **no compounding** (each number / light state is its own clip).
- **Caution variants — separate callouts.** `YellowWaving` and `CautionWaving` become their own (more urgent) callouts; the yellow detection is reworked so a base yellow and its waving variant never double-fire, and `yellow.cleared` does not mis-fire on a static→waving escalation.
- **Disqualify — split.** `Disqualify` gets its own "Disqualified. Pull off." line and no longer triggers the generic `black` callout. `Furled` and `DqScoringInvalid` are new callouts.
- **Go vs green — green suppressed at race starts.** When `StartGo` is set, the diff does **not** emit `flag.green.raised`; the start-light family owns the start. The green callout still fires at restarts (caution→green, no `StartGo`).
- **Start-light opt-ins — two grouped toggles:** `calloutEnabledStartLights` (the 3 gantry lines) and `calloutEnabledStartCountdown` (the 5 numbers). Mirrors the pit-box/track-conditions "many scenarios → one subject opt-in" precedent.
- **`GreenHeld` line — "Green's coming — get ready."** (one bit → one clip).
- **Audio clips — Claude runs the ElevenLabs generator** (paid) after wiring, scoped by `--group`.
- **Scheduling — current #652 model** (`weight`/`interrupt`/`queueable`), not the stale `priority`/`preempt` in the issue.

All callouts **default ON** (per `project_re_new_functionality_default_on` — RE functionality defaults on; no standalone off master).

## Telemetry findings (validated from `local/` captures)

`SessionState`: `0 Invalid · 1 GetInCar · 2 Warmup · 3 ParadeLaps · 4 Racing · 5 Checkered · 6 CoolDown`.

**Standing AI race (2056 series, `StandingStart=1`):**

| t | state | `SessionFlags` decoded | `SessionTimeRemain` |
|---|---|---|---|
| 0.0 | GetInCar | `StartHidden｜OneLapToGreen` | 262 (get-in-cars buffer) |
| +1.4 | GetInCar | `StartHidden｜Servicible｜OneLapToGreen` | **1.0 (collapse)** |
| +2.8 | Warmup | `StartReady｜…｜OneLapToGreen` | −1 |
| +4.0 | Warmup | `StartReady` | **4.38 → 3.13 → 1.83 → 0.48** (real countdown) |
| +9 | Warmup | `StartSet｜…` (red) | **0** |
| +13 | Racing | `StartGo｜Green｜Servicible` | 86399 (race clock) |

→ The **real pre-start countdown** runs in `SessionState=Warmup` while `StartReady` is lit, and counts down **to the red lights (`StartSet`)**. The inflated get-in buffer (262) and the −1 reset both occur OUTSIDE that window, so gating on `Warmup ∧ StartReady ∧ SessionTimeRemain>0` isolates the trustworthy countdown. This AI race compressed the window to ~4 s, so 60/30/15 never fired — exactly the window-gate behavior.

**Rolling AI race (2112 series, `StandingStart=0`):** same get-in collapse, then `StartReady` held through `Warmup`→`ParadeLaps`, **no `StartSet`, `SessionTimeRemain=−1` throughout** → no numeric countdown; the lead-in cue is `OneLapToGreen` / `GreenHeld` / green.

Both captures are **AI races** (all opponents `CarIsAI=1`). The bit sequence and `StandingStart`/`SessionTimeRemain` mechanics are validated; AI compresses the timing, which the window-gate + AI-guard handle.

`irsdk_Flags` bits in scope (TS `Flags` enum already defines all of them): `Crossed 0x80 · YellowWaving 0x100 · OneLapToGreen 0x200 · GreenHeld 0x400 · TenToGo 0x800 · FiveToGo 0x1000 · CautionWaving 0x8000 · Disqualify 0x20000 · Furled 0x80000 · DqScoringInvalid 0x200000 · StartReady 0x20000000 · StartSet 0x40000000 · StartGo 0x80000000`. Skipped: `RandomWaving 0x2000` (cosmetic), `Servicible 0x40000` (not a flag), `StartHidden 0x10000000` (default).

## Callout inventory (18 callouts — all discrete single-clip)

### Start-light family (`family: "start-light"`, `startLight.*` events) — 8 callouts, 2 opt-ins

| Callout | Line | Trigger | Weight |
|---|---|---|---|
| `start-ready` | "Get ready — lights coming up." | `StartReady` rising **∧ standing** | `SAFETY` |
| `start-set` | "Lights are red. Focus." | `StartSet` rising | `CRITICAL` + `interrupt` |
| `start-go` | "Go, go, go!" | `StartGo` rising | `CRITICAL` + `interrupt` |
| `start-countdown` ×5 | "Sixty seconds." / "Thirty." / "Fifteen." / "Ten." / "Five." | `SessionTimeRemain` crosses 60/30/15/10/5 in the standing pre-start window, window-gated + AI-guarded | `SAFETY`, `queueable:false` |

- `start-ready` is **standing-only** (`StandingStart=1`) — in rolling, `StartReady` is held through the whole parade, so the lead-in there comes from `one-lap-to-green` / `green-held` instead.
- Countdown uses **one event** `startLight.countdown.raised { seconds }` (mirrors pit-box's `pitBox.countdown { mark }`) with **5 per-second scenarios** filtering `where: seconds===N`, all under the single `calloutEnabledStartCountdown` opt-in.

### Driver-black (`family: "flag"`, `flag.*`) — 3 callouts

| Callout | Line | Bit |
|---|---|---|
| `disqualify` | "Disqualified. Pull off." | `Disqualify` (split out of `black`) |
| `furled` | "Black flag furled." | `Furled` |
| `dq-scoring-invalid` | "DQ — scoring's off." | `DqScoringInvalid` |

### Race-progression (`family: "flag"`, `flag.*`) — 5 callouts

| Callout | Line | Bit |
|---|---|---|
| `crossed` | "Crossed flags." | `Crossed` |
| `one-lap-to-green` | "One pace lap to go." | `OneLapToGreen` |
| `green-held` | "Green's coming — get ready." | `GreenHeld` |
| `ten-to-go` | "Ten to go!" | `TenToGo` |
| `five-to-go` | "Five to go." | `FiveToGo` |

### Caution variants (`family: "flag"`, `flag.*`) — 2 callouts

| Callout | Line | Bit |
|---|---|---|
| `yellow-waving` | "Local yellow waving — slow, hazard ahead!" | `YellowWaving` |
| `caution-waving` | "Caution coming out!" | `CautionWaving` |

## Architecture changes (by layer, per `race-engineer-callouts.md`)

### 1. Bus events — `packages/event-bus/src/event-catalog.ts`

Add to `SimEventMap` (after the existing `flag.*` block):

- `flag.crossed.raised`, `flag.one-lap-to-green.raised`, `flag.green-held.raised`, `flag.ten-to-go.raised`, `flag.five-to-go.raised`, `flag.disqualify.raised`, `flag.furled.raised`, `flag.dq-scoring-invalid.raised`, `flag.yellow-waving.raised`, `flag.caution-waving.raised` — all `EmptySimEventPayload`.
- `startLight.start-ready.raised`, `startLight.start-set.raised`, `startLight.start-go.raised` — `EmptySimEventPayload`.
- `startLight.countdown.raised` — payload `{ seconds: StartCountdownSeconds }` where `export type StartCountdownSeconds = 60 | 30 | 15 | 10 | 5;` defined alongside `FlagScope`.

Export `StartCountdownSeconds` as a **type** from `packages/event-bus/src/index.ts` (it's a literal union, no runtime value needed — like `FlagScope`).

### 2. Translator — `packages/sim-events-iracing`

**`diff/flags.ts` (extend):**
- `FlagKey` gains `"disqualify" | "furled" | "dq-scoring-invalid" | "crossed" | "one-lap-to-green" | "green-held" | "ten-to-go" | "five-to-go" | "yellow-waving" | "caution-waving"`.
- Split black: `if (Black) add "black"` and separately `if (Disqualify) add "disqualify"` (remove `|| Disqualify` from the black line).
- Add the simple rising-edge bits (`Furled`, `DqScoringInvalid`, `Crossed`, `OneLapToGreen`, `GreenHeld`, `TenToGo`, `FiveToGo`) + their emit cases.
- **Yellow rework:**
  - `localStatic = Yellow ∧ ¬YellowWaving`; `fullStatic = Caution ∧ ¬CautionWaving`. `"yellow"` (with `scope` = full if `fullStatic` else local) is added when `localStatic ∨ fullStatic` — same `flag.yellow.raised {scope}` event, so the existing YELLOW_LOCAL/YELLOW_FULL scenarios are untouched.
  - `"yellow-waving"` added when `YellowWaving`; `"caution-waving"` added when `CautionWaving`. New emits.
  - **`yellow.cleared` fix:** fire only when **all** yellow-ish bits (`Yellow｜YellowWaving｜Caution｜CautionWaving`) clear after at least one was set — NOT when a static yellow escalates to waving. Track an `anyYellow` boolean across ticks (new behavior; do not key the cleared check on the `"yellow"` static key).
- **Green suppression:** when `"green"` is a new transition, skip `flag.green.raised` if `hasFlag(sessionFlags, Flags.StartGo)` — a standing/rolling race-start go is owned by the start-light family. Stateless; restarts (no `StartGo`) keep firing green normally. (Blue suppression when green active is unchanged — note the existing rule runs before this.)

**`diff/start-lights.ts` (new, stateful) + `start-lights.ts` helpers (new, pure, sim-events root):**
- Pure helpers (mirror `track-type.ts`): `resolveStandingStart(sessionInfo): boolean` (`WeekendInfo.WeekendOptions.StandingStart === 1`) and `resolveIsAiRace(sessionInfo): boolean` (any `DriverInfo.Drivers[i].CarIsAI === 1`). Unit-tested independently.
- `diffStartLights(state, telemetry, sessionInfo, emit)`:
  - **Gantry rising edges** off `SessionFlags` vs `state.lastStartLightBits`: `start-ready` (gated `resolveStandingStart`), `start-set`, `start-go`.
  - **Countdown state machine:** window = `standing ∧ SessionState===Warmup ∧ StartReady set ∧ SessionTimeRemain>0`.
    - On the first in-window tick with `SessionTimeRemain>0`, seed `startCountdownCeiling = SessionTimeRemain` (the highest eligible threshold).
    - On each in-window tick, the candidate thresholds are `T ∈ {60,30,15,10,5}` with `T ≤ ceiling ∧ SessionTimeRemain ≤ T ∧ ¬fired(T)`. Mark all candidates fired; **emit only the smallest** (most-recent crossing) `startLight.countdown.raised { seconds: T }` — so a dropped tick never produces a stale burst.
    - **AI guard:** when `resolveIsAiRace` is true, suppress the numeric countdown entirely (no `countdown` events). The window-gate already handles short non-AI procedures; the AI guard is the explicit "never 5 s+ in an AI race" belt-and-suspenders.
  - Reset countdown state (`ceiling=null`, `fired` cleared) on exit from the pre-start window (`StartGo`, `SessionState→Racing`) and on session change. Seed-without-firing on first tick (`startLightInitialized`).
- Wire `diffStartLights(...)` into `translator.ts` `handleTick` next to `diffFlags`, passing `sessionInfo` (already resolved there). It sits after the main replay guard (like `diffFlags`), so replay-only viewing doesn't leak start callouts.

**`state.ts` — new `TranslatorState` fields (update BOTH the type AND `createInitialState`):**
`startLightInitialized: boolean` (false), `lastStartLightBits: number` (0), `lastAnyYellow: boolean` (false — for the cleared fix), `startCountdownCeiling: number | null` (null), `startCountdownFired: Set<number>` (new Set).

### 3. Audio scenarios — `packages/audio-scenarios/src/catalog/pit-crew`

- **`flag-alerts.ts`:** add 10 scenarios (3 black + 5 progression + 2 caution) via the existing `flagScenario(...)` helper (`family:"flag"`, `WEIGHT.SAFETY`, radio frame), each `when:{event}`. Append to `FLAG_ALERTS`.
- **`start-lights.ts` (new):** export `START_LIGHT_ALERTS` (8 scenarios), `START_LIGHT_SCENARIO_IDS`, `START_LIGHT_POOL_NAMES` (keys `startsWith("start-light-")`). All `family:"start-light"`, radio frame. `start-set`/`start-go` are `WEIGHT.CRITICAL`+`interrupt:true`; `start-ready` `WEIGHT.SAFETY`; the 5 countdown scenarios `WEIGHT.SAFETY`+`queueable:false`, each `when:{ event:"startLight.countdown.raised", where:(e)=>e.data.seconds===N }`.
- **`pools.ts`:** add `flag-crossed`, `flag-one-lap-to-green`, `flag-green-held`, `flag-ten-to-go`, `flag-five-to-go`, `flag-disqualify`, `flag-furled`, `flag-dq-scoring-invalid`, `flag-yellow-waving`, `flag-caution-waving` (auto-picked by `FLAG_POOL_NAMES`); and `start-light-ready`, `start-light-set`, `start-light-go`, `start-light-countdown-60/30/15/10/5`. Clip paths: flags → `voice/{voice}/flags/<name>-01.mp3`; start → `voice/{voice}/start-lights/<name>-01.mp3`.
- **`index.ts` family wiring:**
  - Extend `FlagCalloutId` with the 10 new flag ids; extend `FLAG_CALLOUT_SETTING_KEYS` and `SCENARIO_ID_TO_FLAG_ID`.
  - Add `StartLightCalloutId = "lights" | "countdown"`, `START_LIGHT_CALLOUT_SETTING_KEYS = { lights:"calloutEnabledStartLights", countdown:"calloutEnabledStartCountdown" }`, `SCENARIO_ID_TO_START_LIGHT_ID` (ready/set/go→`lights`; the 5 countdowns→`countdown`).
  - Add `getStartLightCalloutEnabled` param to `registerPitCrew` (default `()=>true`), **before** the master-gate param. Register `START_LIGHT_ALERTS` with `wrapWithMaster(wrapCalloutScenario(...))` and define `START_LIGHT_POOL_NAMES` pools.

### 4. Opt-ins — `packages/deck-core/src/global-settings.ts`

Add 12 fields with the canonical `z.union([z.boolean(), z.string()]).transform(v=>v===true||v==="true").default(true)`: `calloutEnabledFlagDisqualify`, `…Furled`, `…DqScoringInvalid`, `…Crossed`, `…OneLapToGreen`, `…GreenHeld`, `…TenToGo`, `…FiveToGo`, `…YellowWaving`, `…CautionWaving`, `calloutEnabledStartLights`, `calloutEnabledStartCountdown`.

### 5. Property Inspector — `packages/iracing-actions/src/actions/pit-crew/pit-crew.ejs`

- Append the 10 new flag subjects to the `flagCallouts` array (auto-balancing 2-col grid scales automatically).
- Add a new `sdpi-item label="Start Lights"` in the Race Engineer Callouts accordion with 2 checkboxes (`calloutEnabledStartLights` "Lights & go", `calloutEnabledStartCountdown` "Countdown"), `global default="true"`.

### 6. Plugin closures — BOTH `iracing-plugin-stream-deck` & `iracing-plugin-mirabox` `plugin.ts`

- The existing flag closure already covers the new `FlagCalloutId`s (live-read via `FLAG_CALLOUT_SETTING_KEYS`).
- Add the start-light closure passed to `registerPitCrew`: `(id: StartLightCalloutId) => (getGlobalSettings() as Record<string,unknown>)[START_LIGHT_CALLOUT_SETTING_KEYS[id]] !== false`, at the new param position (before master gate). Import `START_LIGHT_CALLOUT_SETTING_KEYS` + `StartLightCalloutId`.

### 7. Scenario harness — `packages/scenario-harness/src`

- `event-names.ts`: add all 14 new event names (compile-time completeness check enforces this — `pnpm build` fails otherwise).
- `scenario-shortcuts.ts`: add buttons for the new events (categories: "Flags" for progression/black/caution; "Start" for the start-light + countdown — the countdown shortcut fires `startLight.countdown.raised` with a chosen `seconds`).

### 8. Test fixtures

- `packages/deck-core/src/simhub-service.test.ts`: add the 12 new `calloutEnabled*` keys to the exhaustive `getGlobalSettings()` mock (tsc-only failure otherwise — run `pnpm build`, and `--force` since turbo caches deck-core).
- `packages/audio-scenarios/src/catalog/pit-crew/register-pit-crew.test.ts`: the new `getStartLightCalloutEnabled` param shifts the positional master-gate arg — insert a stub at the new position.

### 9. Docs

- `packages/website/src/content/docs/docs/actions/audio-voice/pit-crew.md` — add the new flags to the flag list + a **Start Lights** subsection (gantry lines + countdown; note standing-only `start-ready`, AI-guarded countdown).
- `packages/audio-scenarios/CLAUDE.md` — document the new `start-light` family if it documents the catalog shape.
- `.claude/rules/race-engineer-callout-examples.md` — add an issue #480 entry (the start-light countdown state machine: window-gated `SessionTimeRemain` countdown + AI guard + green-suppression-at-start; the caution-waving split with the escalation-safe `yellow.cleared`).
- `iracedeck-actions` skill — **no change** (it doesn't enumerate individual callouts).

## Tests (TDD)

- **`diff/flags.test.ts`:** each new bit emits its `flag.*.raised` on rising edge; first-tick seeding silent; stable tick no re-fire. Disqualify emits `flag.disqualify.raised` and NOT `flag.black.raised`. Black still fires for the `Black` bit. Green suppressed when `StartGo` set; green still fires at a restart (`Green` rising, no `StartGo`). Yellow rework: static local→`yellow{local}`; static full→`yellow{full}`; `YellowWaving`→`yellow-waving` (and NOT `yellow{local}`); `CautionWaving`→`caution-waving`; static→waving escalation fires the waving line and does NOT fire `yellow.cleared`; full clear of all yellow bits fires `yellow.cleared` once.
- **`start-lights.ts` helper tests:** `resolveStandingStart`/`resolveIsAiRace` over present/absent/malformed session YAML.
- **`diff/start-lights.test.ts`:** gantry rising edges (ready standing-only, set, go); first-tick seed silent; countdown window-gate seeds ceiling and fires only ≤-ceiling thresholds; smallest-of-multiple emit; AI guard suppresses all numbers; reset on `StartGo`/`Racing`/session change. Replays the 2056 standing capture sequence (ceiling≈4 → no numbers; ready→set→go fire) and the 2112 rolling sequence (no `start-ready` would be wrong — assert standing gate: rolling does NOT fire `start-ready`; no countdown).
- **scenario tests** (`flag-alerts.test.ts`, new `start-lights.test.ts`): each new event fires its clip; start-go is CRITICAL+interrupt; family preemption (`start-set`→`start-go` cancels in-flight `start-set`); each opt-in suppresses only its own callout; `calloutEnabledStartCountdown` gates all 5 numbers, `calloutEnabledStartLights` gates the 3 gantry lines.
- **register-pit-crew.test.ts:** start-light scenarios registered + wrapped by master gate.

## Verify

`pnpm install` → `pnpm build --force` (turbo caches deck-core; schema change needs force) → `pnpm test` → `pnpm lint:fix` → `pnpm format:fix`. Then Claude generates clips: `pnpm --filter @iracedeck/audio-assets generate --group flags` and `--group start-lights`, then `generate:manifest` (requires `ELEVENLABS_API_KEY` in `.env.local`). Manual QA via the scenario harness; then user's in-iRacing test before any push/PR.

## Out of scope

Per-flag variant pools (defer to #470); series-specific phrasing; visual Stream Deck indicators; non-AI standing-start re-capture (mechanics validated; AI guard + window-gate make production-safe — user confirmed "we know enough").
