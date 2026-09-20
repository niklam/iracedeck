> **Issue:** [#474](https://github.com/niklam/iracedeck/issues/474) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Race Engineer: auto-fuel announced apart from a manual fuel toggle

## The problem

`diffPitServiceBit` turns every settled flip of the `PitSvFlags.FuelFill` bit into `pitService.toggled { service: "fuel", on }`, and `FUEL_TOGGLE_CONTRACTS` speaks it as a confirmation of something the driver did — acknowledgment ("Got it.") plus "We're refueling at the next pit stop." iRacing's auto-fuel writes that same bit. During #467 testing on 2026-04-28 the engineer confirmed a request nobody had made, over and over, masking everything else. The driver cannot tell by ear whether a line is their press or the sim's bookkeeping, and their only lever is `calloutEnabledPitServiceRequests`, which silences their own confirmations too.

## Rewritten on 2026-09-20 — the callout is auto-fuel being switched on or off

This spec first designed the callout around the fuel BIT: attribute each settled flip to the sim or the driver, and give the sim's flips their own two lines. It was built that way, reviewed, and then rewritten after the maintainer heard the plan. The old design's decisions are kept below, marked, because the reasoning that survived is load-bearing and the reasoning that did not is the reason this section exists.

What changed, and why:

- **A flip of the fuel bit while auto-fuel is armed now says NOTHING, in either direction.** Decision 3 already conceded that telemetry cannot tell the sim's flip from the driver's press in that window. Announcing it anyway meant choosing a wording for a moment whose cause is unknown — which is how the first attempt shipped a line ("Auto fuel says we don't need fuel next stop.") that the capture then contradicted. Silence removes the phantom confirmation the issue was filed about, which was always the point, and it cannot be wrong about a cause.
- **What auto-fuel does IS announced, at the moment it is switched on or off**, with the fuel request it leaves behind. That moment has an unambiguous meaning, and it carries the fact the maintainer actually wants stated: auto-fuel having fuelling switched on leaves the ORDINARY fuel request set, so switching auto-fuel off leaves the car queued to refuel with nothing saying so.

> "Auto fuel is on. We're refueling at the next pit stop." / "Auto fuel is on. We're not refueling at the next pit stop." / "Auto fuel is off. The plan is still to refuel during the next pit stop." / "Auto fuel is off. We're not refueling at the next pit stop."

Manual presses made with auto-fuel off keep the lines they have. One opt-in, default on, under the Race Engineer master, covering all four.

## The sim signal

`dpFuelAutoFillEnabled` is "Pitstop auto fill fuel system enabled". `dpFuelAutoFillActive` is "Pitstop auto fill fuel next stop flag" — auto-fuel will engage at the next stop. `@iracedeck/sim-events-iracing` does not depend on `@iracedeck/deck-core`, so the translator reads the fields inline rather than importing `isAutofuelActive`.

**What the capture established** (`local/telemetry-watch-20260919-193233-855.jsonl` in the master checkout, a Mustang GT3 road session batched with #1108's tyre-change stop, plus the maintainer's account of it):

- `Enabled` went 0 → 1 on the first lap with no input from the driver, so it is the sim reporting that the car has auto-fuel, as deck-core's `isAutofuelEnabled` documents.
- `Active` is the "auto-fuel at the next stop" switch. The driver's presses moved it three times on track (293.7, 307.9, 357.4 s) with the fuel bit untouched, and each stop CONSUMED it: 1 → 0 as the stop began, at 447.27 s and 597.77 s — both with `OnPitRoad` true, and roughly 200 ms before `PlayerCarInPitStall`.
- After auto-fuel had been armed once in the session, the SIM re-armed it on the pit approach (what exactly makes it do so is not established): `Active` 0 → 1 thirty milliseconds after `PlayerTrackSurface` reached the approach, and in that same tick it cleared the manual fuel request — the `FuelFill` bit, `dpFuelFill` and `dpFuelAddKg` all went to 0. `OnPitRoad` was still false.
- Auto-fuel fuels only what the car needs, which at the first stop was nothing because the tank was too full.
- That pit-approach takeover was the only sim-made flip of the fuel bit in the session; `dpFuelFill` mirrors the bit exactly, so it is no second discriminator. The repeated on-track cycling of the BIT that #467 reported did not reproduce.

## Decisions

### 1. One event carrying both facts: `pitService.autoFuelSwitched { on, refuel }`

`on` is the new state of auto-fuel; `refuel` is what the fuel request is LEFT at once the change has settled. Two facts in one event because the line says both, and because the pair belongs to one moment: a consumer that had to join an "auto-fuel switched" event to a separate "fuel request is now" event would be reconstructing what the translator already knows.

**Rejected: a pair of events** (`autoFuelArmed` / `autoFuelDisarmed`), for the reason the first design gave and which still holds: two `SimEventMap` entries and two `event-names.ts` entries whose only difference is a boolean, against every sibling's shape (`pitService.toggled`, `carControl.drsToggled`, `tireService.changed` all carry their direction in the payload).

**Rejected: a flag on `pitService.toggled`.** The maintainer ruled it out and #951 is why: existing consumers would each need a guard for a distinction they never asked for. Separation belongs in the event name.

**Replaces `pitService.autoFuelChanged { refuel }`**, the first design's event. Nothing had shipped, so it was renamed rather than deprecated.

### 2. The change waits out the fuel debounce, and folds a coincident flip into itself

An auto-fuel change is debounced with the SAME `PIT_SERVICE_DEBOUNCE_MS` (300 ms) window the fuel bit already uses. Two things fall out of that, and both are the point rather than a side effect:

- `refuel` is read when the window closes, so it is the SETTLED plan rather than whatever the bit read on the tick the switch moved.
- A fuel-bit flip settling inside that window is folded into this one event instead of being announced separately. The capture's takeover is exactly that shape — `Active` 0 → 1 and the bit cleared in the same tick — and it must produce exactly one line, `{ on: true, refuel: false }`.

A change that reverts inside the window publishes nothing, like every other debounced bit here.

**Superseded:** the first design's decision 2 attributed each fuel-bit flip by reading `dpFuelAutoFillActive` at the tick the flip was armed AND at the tick it settled, treating either reading as enough ("fail towards auto"). The capture showed the settle read sufficed, and the code review showed the arming-tick latch changed the verdict only when auto-fuel was switched OFF inside the window — the one case where "auto-fuel" is the wrong word. The latch was dropped before this rewrite; the whole attribution went with the rewrite.

### 3. A fuel-bit flip while auto-fuel is armed publishes nothing

Telemetry carries no source for a flip: `dpFuelAutoFillActive` is a state, not an edge, so a press made while auto-fuel is armed is indistinguishable from the sim's own flip. The first design announced it anyway, as auto-fuel's, on the grounds that a driver still hears a confirmation. The rewrite drops it: the driver's own press going unconfirmed in that window is the price, and it buys never speaking a cause we cannot know. The plan the press produced is still stated the moment auto-fuel is switched off, which is the moment it matters.

The manual path is untouched — auto-fuel not armed, a settled flip, `pitService.toggled`, the acknowledged confirmation.

### 4. No acknowledgment prefix, four clips, and the first two retired

Every one of the twenty-four toggle confirmations is `pool:pit-actions/acknowledgment → pool:pit-actions/<line>`; the acknowledgment is the engineer answering a request. Auto-fuel is not a request, so each script entry is the bare line. That is the audible marker the issue asks for, at no clip cost.

Clips join the existing `pit-actions` group as `auto-fuel-on-refuel` / `auto-fuel-on-no-refuel` / `auto-fuel-off-refuel` / `auto-fuel-off-no-refuel`, and are listed in their own `AUTO_FUEL_CLIP_SOURCES` rather than in `TOGGLE_CONFIRMATION_CLIP_SOURCES`: each clip-source list is tested against exactly its own contracts' scripts. Four whole lines rather than a switched opener plus a shared plan clause, because a single recorded take carries the sentence's prosody and the composition would save one clip.

The first design's `auto-fuel-on` / `auto-fuel-off` clips are deleted with their entries.

### 5. Its own opt-in, independent of Pit service requests

`calloutEnabledPitServiceAutoFuel`, default `true` per the callout baseline, on the canonical `z.union([z.boolean(), z.string()]).transform(...).default(true)` pattern. One subject, four scenario ids: `AutoFuelCalloutId = "changed"`, an `AUTO_FUEL_CALLOUT_SETTING_KEYS` map and a `SCENARIO_ID_TO_AUTO_FUEL_ID` covering all four — the pit-box shape, which is the precedent for a single-subject family. One checkbox, labelled "Autofuel changes", the spelling the site and settings already use.

Reusing `calloutEnabledPitServiceRequests` was rejected: it is precisely the choice the issue says users cannot make today. Subordinating the new key to it was rejected for the same reason in reverse — the two preferences are independent in both directions.

### 6. Same family, same cooldown, not queueable

The contracts take `family: "pit-service.fuel"` — shared with the manual pair, so a burst replaces its in-flight family-mate wholesale instead of stacking. Default `WEIGHT.NORMAL`, `interrupt: false`, `queueable: false`: a stale auto-fuel line replayed thirty seconds later is worse than silence. Wrapping is the toggles' own three layers — master gate, the opt-in via `wrapCalloutScenario`, then `wrapPitActionScenario`.

### 7. Silent from pit road onward

Auto-fuel changes made while `OnPitRoad` is true, in the stall, or off track seed the baseline silently, exactly as the other pit-service bits do. The capture is the reason: the stop CONSUMES auto-fuel, dropping the flag as the stop begins, and announcing "Auto fuel is off" there would be the engineer reporting the sim's bookkeeping at the busiest moment of the lap. The pit APPROACH still announces, and must: that is where the sim re-arms and wipes a manual request, which is the one moment a driver would otherwise arrive at the box with a plan they did not choose.

The pit-road readback is therefore out of reach of this event by construction. `diff/pit-readback.ts` re-fires the entry recap on a changed plan while ON PIT ROAD, and no auto-fuel change is published there.

**Superseded:** the first design debated whether `pitService.autoFuelChanged` belonged in `USER_TOGGLE_EVENTS` (it was first excluded, then added on review, because a driver's own fuel press on pit road lost its refreshed recap). With fuel-bit flips while armed no longer published at all, and auto-fuel changes silent on pit road, the question is moot.

### 8. Out of scope

Auto-tire and auto-windshield remain the sibling analysis the issue defers. Making the entry readback anticipate a takeover that lands one tick after it fires is a separate change: on a road course the recap is expanded on the approach tick and can still name fuel the sim clears immediately afterwards, and the auto-fuel line that follows corrects it.

## Verification

1. **The capture**, first: `telemetry-watch` across a road session in the Mustang GT3 with auto-fuel armed (done 2026-09-19; what it established is recorded under *The sim signal*).
2. `sim-events-iracing`: a fuel flip with auto-fuel armed publishes nothing; the captured takeover publishes exactly one `autoFuelSwitched { on: true, refuel: false }` and no `toggled`; switching off with the bit left set gives `{ on: false, refuel: true }`; a change that reverts inside the window publishes nothing; changes on pit road / in the stall / off track publish nothing and reseed; a flip with auto-fuel never armed still publishes `toggled`; windshield and fast repair are unaffected.
3. `audio-scenarios`: each contract fires only on its own `(on, refuel)` pair, the opt-in silences all four without touching the manual pair, `calloutEnabledPitServiceRequests` silences the manual pair without touching these, and family replacement holds on a burst. `bundled-scripts.test.ts` and `script-coverage.test.ts` cover the entries and clips.
4. `deck-core`: the key in both `simhub-service.test.ts` literals.
5. Harness → Pit Service → the four buttons, and the "Autofuel takeover (replay)" telemetry sequence, which drives the real translator off the capture. Then in-sim: switch auto-fuel on and off on track and hear the fuel plan it leaves; queue fuel by hand, drive to the pit approach, and hear the sim's re-arm announced once; run a stop and hear nothing as it consumes auto-fuel.

## Affected artifacts

`event-bus` (`event-catalog.ts`); `sim-events-iracing` (`diff/toggles.ts`, `state.ts`, `diff/pit-readback.ts`, tests); `audio-scenarios` (`catalog/pit-crew/toggle-confirmations.ts` — contracts, ids and clip sources — plus the family wiring and dep in `catalog/pit-crew/index.ts`); `audio-assets` (`configs/default.voice.json` group entries and the four `scenarios` entries, generated clips, two clips deleted, `generate:callout-scripts`, `pack:voice default` → `catalog/default.json`, at pack version 1.1.0 per the maintainer's ruling); `deck-core` (`global-settings.ts`); `pi-components` (`race-engineer-callouts.ejs` row, label "Autofuel changes"); all three `plugin.ts`; `scenario-harness` (`event-names.ts`, `scenario-shortcuts.ts` — four buttons plus the capture replay); `pnpm generate:pack-reference`; website (`docs/actions/audio-voice/pit-crew.md`, `changelog.mdx` + `pnpm generate:changelog-data`, and `pnpm capture:settings` for the What's New shot); `.claude/rules/race-engineer-callout-examples.md` on merge.
