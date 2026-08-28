> **Issue:** [#561](https://github.com/niklam/iracedeck/issues/561) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Car Control: state-aware Ignition and Starter keys

## The problem

Car Control's `ignition` and `starter` modes are stateless. Both send a key binding and render a fixed icon, so the key looks identical whether the ignition is live, the engine is off, or the engine is running. A driver cannot tell from the deck whether the last press achieved anything — which is exactly when they are least able to look away from the road.

Nothing about how these keys *act* is wrong. `ignition` taps `carControlIgnition`; `starter` holds `carControlStarter` while the key is held, which is how a real starter behaves. The gap is feedback, not dispatch.

## Decision

Both modes join `TELEMETRY_AWARE_CONTROLS` and render through the tri-state key style the other telemetry-driven Car Control keys already use — green `on`, red `off`, gray `na` — using the shared `ToggleState` vocabulary in `packages/iracing-actions/src/icons/status-bar.ts`.

| Key | `on` (green) | `off` (red) | `na` (gray) |
|-----|--------------|-------------|-------------|
| **Ignition** | Ignition circuit live | Ignition off | No live telemetry |
| **Starter** | Engine running | Engine not running — press to crank | No live telemetry |

Press behaviour is unchanged for both. No dual-press, no press-duration classification, no new bindings, no settings migration.

### Why Starter reports engine state, not starter engagement

The literal reading of a starter key is "is the starter motor turning", which `dcStarter` would answer. It was rejected: that is true for under a second per start, so the key would sit red almost always and tell the driver nothing. What a driver actually needs from this key is "do I still need to crank" — which is engine-running state. The key keeps its `ENGINE START` title, and green means the engine is alive.

### `na` means no live telemetry, and nothing else

`na` is reserved for "we do not know" — disconnected, in a replay, or not in the car. It is deliberately **not** overloaded to also mean "this car has no starter".

Gating `na` on `dcStarter` presence — the car-capability pattern `hasPitLimiter` uses for the pit limiter — was considered and deferred. A car that omits `dcStarter` may still be startable through the user's key binding, so capability-gating risks showing a permanent false `na` on a key that works. The pit limiter can do it safely because a car without a limiter genuinely cannot be limited; a starter binding has no such guarantee.

This distinction is the single most important correctness property here, and it is what #638 introduced `pitLimiterToggleState` for: missing telemetry must never render as a confident `off`.

## Detection

### Ignition — from `Voltage`

iRacing exposes no ignition field of any kind. Confirmed against `docs/reference/telemetry-vars.json`: across all 429 variables there is no `Ignition`, no `dcIgnition`, and no description mentioning ignition. Engine voltage is the only available proxy — it reads ~0 V with the ignition off and ~13.4 V with it live.

This rule is the one genuinely valuable idea in the contributor proposal (below) and is kept.

**It carries a validation risk that manual testing must close.** None of the 52 captured telemetry snapshots in `local/` shows `Voltage` below 12 V — the observed set is exactly `{12, 13.37, 13.4, 13.7, 13.8, 14.2, 14.4, 14.8}` — including the three captures where the engine is confirmed stalled, which read 14.2 / 14.2 / 13.4 V. Those captures were all taken in-car or in replay and never caught an ignition-off moment. The maintainer, as domain authority, confirmed that `Voltage` does drop to ~0 with the ignition off, and that ruling governs. But no data in this repo demonstrates it, so **the first thing manual testing must check is that switching the ignition off actually moves `Voltage`.** If it does not, the ignition tri-state is inert — permanently green — and that half of the design needs revisiting before the PR.

The threshold sits well clear of both ends rather than hugging zero, so sensor noise or a partially-energised bus cannot flip it.

### Engine running — from `EngineWarnings.EngineStalled`, RPM as fallback

`EngineWarnings.EngineStalled` (`0x0008`) is the primary signal. An RPM floor is the fallback for when `EngineWarnings` is unavailable.

Evidence from the same 52 captures: `EngineStalled` is set in exactly the three engine-off-while-in-car captures — all at RPM 300, all `IsOnTrack: true` — and clear in all 49 others. The lowest running idle observed is ~900 RPM, and RPM 300 appears to be the engine-off floor.

This replaces the contributor's `RPM > 400` constant, which carried the comment "tune per car if needed". A per-car magic number is a maintenance liability and a support-thread generator; an SDK bit is authoritative and needs no tuning. The RPM floor survives only as the fallback path, and sits above the observed 300 floor rather than at it.

Note the replay caveat the data shows: the five RPM-300 captures with `IsReplayPlaying: true` / `IsOnTrack: false` have `EngineStalled` **clear**. So `EngineStalled` alone does not identify "not in the car" — that is the `na` state's job, not something the running-state predicate should try to answer.

## Shape of the code

Four pure, individually testable pieces, following `pitLimiterToggleState` exactly:

- `isIgnitionOn(telemetry)` — the `Voltage` predicate.
- `isEngineRunning(telemetry)` — the `EngineStalled`-primary predicate with the RPM fallback.
- `ignitionToggleState(...)` / `starterToggleState(...)` — return `ToggleState` from already-derived booleans plus a live-telemetry flag, so `na` is decided in one place.

The tri-state functions are shared by **both** the icon renderer and the state-key builder. That is not a convenience: `pitLimiterToggleState`'s own doc comment records why it matters — if the dedupe key is computed from raw telemetry while the icon is computed from the resolved state, an input with no effect on the rendered state still churns the key. Computing both from one function makes that impossible.

Wiring, all inside `packages/iracing-actions/src/actions/car-control/car-control.ts`:

- add `"ignition"` and `"starter"` to `TELEMETRY_AWARE_CONTROLS`
- extend `CarControlTelemetryState` with the two resolved `ToggleState` values
- extend `getTelemetryState` and the state-key builder
- render both through `generateToggleStateSvg` (below), preserving the per-context `bindingMissing` overlay the current static path already passes

Re-render volume is handled by machinery that already exists: the per-context state-key dedupe plus the 10 Hz `IconUpdateThrottle`. Both tri-states change rarely, so neither needs tuning.

### Helpers stay local

`isIgnitionOn` and `isEngineRunning` live in `car-control.ts`, not in `@iracedeck/iracing-sdk`'s `telemetry-features.ts`. That module answers *car-capability* questions — "does this car have X", by field presence — and these are live-state predicates, a different question. They move only if a second consumer appears.

## Icons: reuse `generateToggleStateSvg`, do not hand-roll a fourth pipeline

`status-bar.ts` already exports `generateToggleStateSvg(inputs)`, added for the ABS and TC toggle keys (#827). It performs the entire pipeline — resolve colours, resolve title, resolve border with `borderColorForState(state)` as the state override, compose optional artwork above the status bar, apply the binding-missing warning, render, return a data URI.

`car-control.ts` currently contains **three** inline copies of that same pipeline (`pit-speed-limiter`, the `push-to-pass`/`drs` branch, and its neighbours). Ignition and Starter go through the shared helper instead. Adding a fourth copy is the outcome to avoid, and the contributor's diff added two more.

Each key needs a 144×144 dynamic template under `packages/iracing-actions/icons/`, following the DRS / Push-to-Pass template shape exactly (`{{borderDefs}}` outside the group; `rx="24"` background using `{{backgroundColor}}`; then `{{borderContent}}`, `{{titleContent}}`, `{{iconContent}}`):

- `car-control-ignition.svg` — `<desc>` title `ON/OFF\nIGNITION`
- `car-control-starter.svg` — `<desc>` title `ENGINE\nSTART`

Artwork passes through the helper's `artwork` parameter, which is the ABS Toggle pattern (artwork plus status bar) rather than the DRS pattern (locked title as the whole identity). Carry over the existing shapes from `packages/icons/car-control/ignition.svg` and `starter.svg` so the keys stay recognisable.

**The artwork must be state-neutral.** Today's `starter.svg` hardcodes `#e74c3c` / `#c0392b` for its circle, which would fight the state colour and show a red badge on a green key. The artwork is recoloured through `{{graphic1Color}}` like the ignition symbol already is, and the state is carried by the status bar and border alone — the two channels the tri-state language already owns. That also removes the contributor's approach of recolouring the artwork itself, which said the same thing twice and re-declared the palette to do it.

The existing static `packages/icons/car-control/ignition.svg` and `starter.svg` stay where they are: they remain the source of the artwork shapes, and the category icon path is unaffected.

Regeneration, from the actual scripts rather than from convention:

- `node scripts/generate-icon-defaults.mjs` **is required** — it scans `packages/iracing-actions/icons/` and will add `car-control-ignition` / `car-control-starter` keys (they do not collide with the existing `car-control` static-category key).
- `node scripts/generate-icon-previews.mjs` is **not** required — it scans `packages/icons/` only and has no concept of the dynamic-template directory.
- No freshness test guards `icon-defaults.json`, so running the generator is a discipline item, not something CI will catch.

## Consequences for documentation

**The per-action border colour picker becomes inert for these two modes**, because the border colour is state-driven — as it already is for DRS, Push-to-Pass, Toggle Fuel Fill, Windshield Tearoff and Fast Repair. Three places record that fact and all three go stale otherwise:

- `packages/website/src/content/docs/docs/features/border-indicator.md` — the "Toggle actions that support automatic border colors" list, plus the sentence that the colour picker is ignored.
- `.claude/rules/pi-templates.md` — the same list in the border-overrides section.
- `packages/website/src/content/docs/docs/actions/driving/car-control.md` — the Ignition and Starter mode sections, whose `Telemetry-aware icon:` bullet currently reads `No`. Pit Speed Limiter's section is the template to follow: tri-state described as sub-bullets under that bullet, with the colour mapping spelled out.

That `border-indicator.md` list omits **Pit Speed Limiter** today, even though its own action page documents exactly this behaviour — a pre-existing gap. Fixing it is a one-line accuracy correction in a list this change has to edit anyway.

No Property Inspector structure changes. `car-control.ejs` already renders the `ird-binding-status` line and already complies with the #1024 `action-settings-footer` placement rule.

No `comms-catalog.ts` work: `ignition` and `starter` already carry `keybind("carControlIgnition")` / `keybind("carControlStarter")` descriptors, because the modes already exist. The #612 surface listed on the issue was written when this was going to be a new action; the live requirement is only that the new render path keeps passing `bindingMissing`.

The changelog line goes under **Improvements** in the in-development `3.1.0` section, which already has that category. It carries **no** contributor credit: the proposal arrived privately rather than as a pull request, and the maintainer's decision is not to name its author.

## Testing

Unit tests mirror the `pitLimiterToggleState` block in `car-control.test.ts`:

- each predicate against `null` telemetry, `{}` (connected but field absent), and both sides of its boundary
- each tri-state function proving `na` wins over the on/off input — the case a two-state model cannot express
- `isEngineRunning` proving the fallback: `EngineStalled` decides when `EngineWarnings` is present, RPM decides when it is absent
- the state key differing across all three states, so the dedupe cannot mask a transition

Manual testing must cover, in the sim: ignition off → on (**the `Voltage` validation above**), crank to running, engine off again, and a disconnect showing gray rather than red. The scenario harness cannot substitute — it carries no `Voltage` in its mock telemetry and does not render deck keys.

## What the contributor proposal contributed, and what was rejected

A contributor supplied a working diff against `car-control.ts` plus two icon templates, privately rather than as a pull request. It reached the right destination — telemetry-aware ignition and starter on the existing modes — and the `Voltage` insight is kept.

Rejected from it:

- **Two-state `IgnitionState = "off" | "on"`.** No room for `na`, and both its predicates coalesce missing telemetry to zero (`telemetry?.RPM ?? 0`), so a disconnected sim renders a confident "ignition off / engine not running". That is precisely the failure the tri-state exists to prevent.
- **`RPM > 400`**, replaced by `EngineStalled` as above.
- **Re-declared palette constants** (`IGNITION_GREEN` / `IGNITION_RED` and the starter pair) duplicating the `#2ecc71` / `#e74c3c` that `status-bar.ts` already owns. Duplicated palette constants are the drift `.claude/rules/icons.md` exists to prevent.
- **Bespoke `ignitionBorderColor` / `starterBorderColor`**, superseded by `borderColorForState`.
- **Two more inline copies of the render pipeline**, superseded by `generateToggleStateSvg`.

It also omitted tests, documentation and the changelog entirely.

## Rejected alternatives

- **A new consolidated `engine-start` action**, as the issue was originally filed — one key cycling off → ignition-on → running. Rejected by the maintainer: the two modes already exist and already carry users' bindings, so improving them delivers the feedback to everyone who has those keys today, with no new action UUID, no manifest entry across three plugins, and nothing for existing users to migrate.
- **Short-press / long-press on one key** to choose between ignition and starter. Moot once the keys stay separate, and weaker regardless: a starter that engages only after a long-press threshold elapses fights the hold-to-crank behaviour the key already has.
- **Rendering live RPM on the key face.** Out of scope; the tri-state answers the question the request was actually about.
- **Refactoring the three existing inline render pipelines in `car-control.ts` onto `generateToggleStateSvg`.** Correct, and deliberately not done here — it touches three shipped keys this issue has no reason to risk. Worth its own issue.
