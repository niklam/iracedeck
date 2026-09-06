> **Issue:** [#474](https://github.com/niklam/iracedeck/issues/474) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: auto-fuel announced apart from a manual fuel toggle

## The problem

`diffPitServiceBit` turns every settled flip of the `PitSvFlags.FuelFill` bit into `pitService.toggled { service: "fuel", on }`, and `FUEL_TOGGLE_CONTRACTS` speaks it as a confirmation of something the driver did — acknowledgment ("Got it.") plus "We're refueling at the next pit stop." iRacing's auto-fuel owns that same bit and flips it on its own. During #467 testing on 2026-04-28 it cycled repeatedly, and the engineer confirmed a request nobody had made, over and over, masking everything else. The driver cannot tell by ear whether a line is their press or the sim's bookkeeping, and their only lever is `calloutEnabledPitServiceRequests`, which silences their own confirmations too.

## The sim signal

`dpFuelAutoFillEnabled` is "Pitstop auto fill fuel system enabled" — whether the car/series has the system at all. `dpFuelAutoFillActive` is "Pitstop auto fill fuel next stop flag" — auto-fuel will engage at the next stop. `Active` is the discriminator, matching deck-core's `isAutofuelActive` (absent field reads as not-active); `Enabled` only decides whether autofuel UI shows N/A. `@iracedeck/sim-events-iracing` does not depend on `@iracedeck/deck-core`, so the translator reads the field inline rather than importing that helper.

The repo holds no record of iRacing's frame sequencing between the bit and the flag, so the capture is the first implementation task — batched with #1108's tyre-change stop in the same Mustang GT3 road session.

## What ships

A fuel-bit flip that iRacing made gets its own event and its own two lines, said without the acknowledgment that marks a driver's request:

> "Auto fuel has us taking fuel at the next stop." / "Auto fuel says we don't need fuel next stop."

Manual presses keep the lines they have. One new opt-in, default on, under the Race Engineer master.

## Decisions

### 1. One event with a boolean payload, not a pair

`pitService.autoFuelChanged { refuel: boolean }`. Two contracts read it, one per direction, with the same one-line `where:` predicate `fuelContract(on)` already carries — so a pair buys nothing at the consumer and costs a second `SimEventMap` entry and a second `event-names.ts` entry whose only difference is a boolean. It also breaks the shape every sibling has (`pitService.toggled`, `carControl.drsToggled`, `tireService.changed`, `pitsOpen.changed` all carry their direction in the payload), which matters for the consumer that is not a callout: a key icon wanting "auto-fuel changed at all" would have to subscribe twice. The harness still gets two shortcut buttons — a shortcut carries a payload.

**Rejected: `pitService.toggled { service, on, auto }`.** The maintainer ruled it out and #951 is why: the existing manual contracts would each need an `auto === false` guard, so a new distinction would force a filter onto consumers that never asked for it. Separation belongs in the event name.

`refuel` rather than `on`, because the event is not a toggle the driver operated: it says what auto-fuel decided.

### 2. Attribution happens at the debounce, and ties resolve to auto

The fuel bit already runs through `PIT_SERVICE_DEBOUNCE_MS` (300 ms), so there are two candidate frames: the tick the pending flip was armed and the tick it fires. The translator latches `dpFuelAutoFillActive` at arming, reads it again at emit, and treats the flip as auto if **either** says so. Exactly one event is published per settled flip — auto or manual, never both — which is what keeps the manual contracts untouched and makes a double announcement structurally impossible rather than something the catalog has to suppress.

The tie-break direction is deliberate. A false "auto" on a manual press is a wording difference on a line the driver expected anyway; a false "manual" on a sim flip is the #467 noise coming back. Fail towards auto.

### 3. While auto-fill is active, every fuel-bit flip is announced as auto

Telemetry carries no source attribution: `dpFuelAutoFillActive` is a state, not an edge, so a press made while auto-fuel is armed is indistinguishable from the sim's own flip. Requiring the flag to have *just* turned on was rejected — that is exactly the repeated-cycling case, where the flag stays 1 across every flip, so it would restore the bug. The driver still hears a confirmation; it is phrased as auto-fuel.

**What the capture must confirm before the diff is trusted:** that `dpFuelAutoFillActive` reads 1 at both the arming and the emit tick of a sim-made flip (if it does not, the OR in decision 2 is load-bearing rather than belt-and-braces); that the flips reach the on-track path at all, since `diffToggles` reseeds silently while `PlayerCarInPitStall` is true; whether a manual press while the flag is 1 sticks or is overwritten by the sim, which is what decision 3 rests on; and that `Active` is never 1 while `Enabled` is 0.

### 4. No acknowledgment prefix, and two new clips

Every one of the twenty-four toggle confirmations is `pool:pit-actions/acknowledgment → pool:pit-actions/<line>`; the acknowledgment is the engineer answering a request. Auto-fuel is not a request, so the script entry is the bare line. That is the audible marker the issue asks for, at no clip cost, and it halves the airtime of a line the sim may repeat.

Clips join the existing `pit-actions` group and `TOGGLE_CONFIRMATION_CLIP_SOURCES` as `auto-fuel-on` / `auto-fuel-off`, beside `fuel-on` / `fuel-off`. The wording avoids "we're", which the manual lines use for the driver's decision.

### 5. Its own opt-in, independent of Pit service requests

`calloutEnabledPitServiceAutoFuel`, default `true` per the callout baseline, on the canonical `z.union([z.boolean(), z.string()]).transform(...).default(true)` pattern. One subject, two scenario ids: `AutoFuelCalloutId = "changed"`, a `AUTO_FUEL_CALLOUT_SETTING_KEYS` map and a `SCENARIO_ID_TO_AUTO_FUEL_ID` covering both — the pit-box shape, which is the precedent for a single-subject family.

Reusing `calloutEnabledPitServiceRequests` was rejected: it is precisely the choice the issue says users cannot make today. Subordinating the new key to it was rejected for the same reason in reverse — the two preferences are independent in both directions.

### 6. Same family, same cooldown, not queueable

The contracts take `family: "pit-service.fuel"` — shared with the manual pair, so a burst replaces its in-flight family-mate wholesale instead of stacking, and a manual press right after an auto flip replaces the auto line. Default `WEIGHT.NORMAL`, `interrupt: false`, `queueable: false`: a stale auto-fuel line replayed thirty seconds later is worse than silence. Wrapping is the toggles' own three layers — master gate, the new opt-in via `wrapCalloutScenario`, then `wrapPitActionScenario` — so the 4.5 s `pitLane.exited` and pre-grid cooldowns cover it. That last layer matters more here than for the manual lines: pit exit is where the sim re-arms the queue on its own.

### 7. Out of scope

Arming or disarming auto-fill itself (`dpFuelAutoFillActive` moving with the fuel bit unchanged) publishes nothing. It is a manual press like any other and would need its own subject, clips and opt-in. Auto-tire and auto-windshield remain the sibling analysis the issue defers.

## Verification

1. **The capture**, first: the `telemetry-snapshot` CLI across a road session in the Mustang GT3 with auto-fuel armed, answering the four questions in decision 3.
2. `sim-events-iracing`: a sim flip with the flag at both frames emits `autoFuelChanged` and no `toggled`; a manual flip with the flag clear emits `toggled` and no `autoFuelChanged`; the flag set at only one of the two frames emits `autoFuelChanged`; an absent field reads as manual; stall/off-track ticks still seed silently.
3. `audio-scenarios`: each contract fires on its direction only, the opt-in silences both without touching the manual pair, and family replacement holds on a rapid cycle. `bundled-scripts.test.ts` and `script-coverage.test.ts` cover the entries and clips.
4. `deck-core`: the new key in both `simhub-service.test.ts` literals.
5. Harness → Pit Service → Auto Fuel ON / OFF, then in-sim: arm auto-fuel and run a stop, listening for one line per flip, no acknowledgment, and the manual toggle still confirmed as before.

## Affected artifacts

`event-bus` (`event-catalog.ts`); `sim-events-iracing` (`diff/toggles.ts`, `state.ts` for the latched flag, tests); `audio-scenarios` (`catalog/pit-crew/toggle-confirmations.ts` — contracts, ids and clip sources — plus the family wiring and dep in `catalog/pit-crew/index.ts`); `audio-assets` (`configs/default.voice.json` group entries and the two `scenarios` entries, generated clips, `generate:callout-scripts`, `pack:voice default` → `catalog/default.json`); `deck-core` (`global-settings.ts`); `pi-components` (`race-engineer-callouts.ejs` row, label "Auto fuel changes"); all three `plugin.ts`; `scenario-harness` (`event-names.ts`, `scenario-shortcuts.ts`); `pnpm generate:pack-reference`; website (`docs/actions/audio-voice/pit-crew.md`, `changelog.mdx` + `pnpm generate:changelog-data`); `.claude/rules/race-engineer-callout-examples.md` on merge.
