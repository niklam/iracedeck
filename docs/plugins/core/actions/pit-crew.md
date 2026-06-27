# Pit Crew

Multi-mode action covering the iRaceDeck pit-side audio framework. Modes available today: **Race Engineer Toggle** (gates the voice scenario engine), **Radar** (toggles the directional proximity tick loop), and **Radar Volume** (steps the radar volume up or down, deprecated and hidden from the PI). The Race Engineer voice catalog covers pit-service confirmations, pit-lane callouts, the full set of flag transitions described below, and the spotter side-awareness callout family (a Race Engineer voice family, not a separate mode — see [Spotter calls](#spotter-calls)).

## Properties

| Property | Value |
|----------|-------|
| Action ID | `com.iracedeck.sd.core.pit-crew` |
| Type | Multi-toggle / Incremental |
| SDK Support | No |
| Dial Support | No |

## Default state

`raceEngineerEnabled` and `radarEnabled` both ship **off** (issue #378). A fresh install — and any user who has never pressed a toggle — stays quiet until they explicitly enable the feature with a Race Engineer Toggle or Radar key press. The status bar on each toggle's icon paints red on first launch, flipping green only after the first press. The spotter side-awareness calls are part of the Race Engineer voice (gated by `raceEngineerEnabled` plus their own opt-ins — see [Spotter calls](#spotter-calls)), not a separate toggle.

## Behavior

### Button Press
- **Race Engineer Toggle mode**: Flips the plugin-global `raceEngineerEnabled` gate. When off (the default), both `AudioBus.Voice` (engineer messages, acks, toggle confirmations) and `AudioBus.Background` (pit ambient loop and walkie-talkie SFX) are zeroed synchronously, so any in-flight clip silences on the same key press. `AudioBus.Alerts` (radar) is intentionally untouched — radar has its own toggle. Re-enabling restores Voice to the configured `Race Engineer Volume` and Background to unity. The engineer plays a short voice acknowledgment on every press ("Okay, going silent." on disable, "Roger, resuming communication." on enable) — disable from **Race Engineer Callouts → Race Engineer Toggle** to keep the toggle silent.

### Telemetry-connect radio check

When iRacing telemetry first starts flowing into the plugin (false → true SDK connection transition), the Race Engineer announces "<name>, radio check. Standing by." so the driver has audible confirmation that the plugin is talking to iRacing. Gated on both the Race Engineer master gate AND a dedicated per-callout opt-in (**Race Engineer Callouts → Telemetry Connect**) so the user can keep the master ack but suppress the connect line, or vice versa. Module-level dedup across every visible Pit Crew instance ensures the line fires at most once per real connect; reconnecting (iRacing close + relaunch, transient SDK drop) replays it.
- **Radar mode**: Flips the plugin-global `radarEnabled` and stops/starts the directional proximity tick loop synchronously. Off by default — pressing the key once starts the loop. Used by Radar alongside the per-instance Radar Test button.
- **Radar Volume mode**: Steps the plugin-global `radarVolume` by ±5, clamped to 0–100. Takes effect immediately on `AudioBus.Alerts`. Direction is configured per button (Up or Down). Stepping to 0 mutes the radar without toggling the feature off. Deprecated (#590) — hidden from the PI Mode dropdown but kept functional for existing buttons.

### Race Engineer voice coverage

When the engineer is enabled, the Pit Crew catalog confirms every meaningful pit-service change made via the Tire Service / Pit Service actions:

- **Fuel** — separate on / off callouts.
- **Tire selection** — exhaustive across the 15 non-empty 4-corner combinations: the 5 standard preset patterns (all / fronts / rears / lefts / rights), all 4 single-corner picks, both diagonals (LF + RR, RF + LR), and all 4 three-corner combos (skip LF / RF / LR / RR). Clearing the selection plays a "skipping tires" callout.
- **Tire compound** — dry / wet switches play a dedicated compound line. iRacing forces all four tire bits on at the same instant the compound flips; the translator suppresses the cascading tire-set event so only the compound callout plays.
- **Windshield tearoff** — separate on / off callouts on each toggle.
- **Fast repair** — separate on / off callouts on each toggle.

Flag transitions are also voiced — every flag the iRacing translator publishes gets a dedicated engineer callout:

- **Yellow** — scope-aware: full-course yellow ("pace car deployed") and local sector yellow ("mind the slow cars") play different lines.
- **Yellow cleared** — engineer announces when the yellow drops.
- **Green** — race-restart / race-on callout.
- **Blue** — alternates between two recorded variants ("faster car approaching" / "check your mirrors").
- **White** — final-lap alert.
- **Red / Black / Debris** — single dedicated callout each.
- **Checkered** — session-aware: practice, qualifying, and race finishes get distinct lines.
- **Meatball** — the only flag callout marked **urgent + preempt**: it cancels in-flight engineer chatter mid-message, since failing to pit on a meatball costs a black-flag penalty. All non-meatball flag callouts share a `flag` family so a newer flag preempts an older one (no "yellow's clear" + "green flag" double-talk on race restart).

The engineer also reads a **session-start brief** around 3 seconds after a **practice or qualifying** session starts — even if you're still in the garage: a greeting by name, the session type, the pit speed limit, track and air temperature, and track wetness. It also fires when the plugin connects into a practice/qualifying session already in progress. Units follow iRacing's display setting; the pit speed limit is rounded to the nearest whole unit and is read out only when it matches a known iRacing pit limit the engineer has a clip for (otherwise that part is skipped). It can be toggled off independently in the **Race Engineer Callouts → Session Start** Property Inspector section.

In **race** sessions the brief is replaced by a dedicated **race-start callout** fired ~3 s after the session changes to a race (you can still be in the pit/garage). It greets the driver by name, reports the qualifying-finish (grid) position — "Starting from pole. Well done." for P1, "Qualifying put us to P*n*." for P2..P64, or skips the position clause entirely if the position isn't yet populated or is out of range — and reads the same track + air temperature + wetness brief as the session-start callout (no pit speed limit; you heard it during practice / qualifying). It's toggleable independently from the session-start brief in **Race Engineer Callouts → Race → Race start**.

After that intro — in qualifying and race sessions — the engineer adds a **setup warning** when the loaded setup's *name* looks wrong for the session: in qualifying on a race-looking name ("Our setup name suggests that we're on a race setup. Please double-check."), or in a race on a qualifying-looking name ("Our setup name suggests that we're on a qualifying setup. Please double-check."). It's a heuristic on `DriverInfo.DriverSetupName` only — it never changes anything, just asks you to verify. The match is two user-editable, case-insensitive regular expressions (one per session kind) under **Setup Warning Patterns**, each with a **Reset to default**; an invalid pattern is flagged in the PI banner and the warning is skipped until you fix it. Toggle the whole feature in **Race Engineer Callouts → Setup Warning**.

The engineer also reads a **pit-service readback** as you enter pit road — a coherent recap of the queued plan ("Don't forget your limiter. We're taking fuel, four tires, …"). When the callout fires is **track-type aware**: on a **dirt oval** iRacing usually teleports the car straight into the pit stall, bypassing the approach zone, so there the readback fires when the car genuinely **drives onto pit road** (the `OnPitRoad` false→true transition while the car is not being teleported straight to the stall) — a teleport or tow directly into the stall stays silent. On **all other track types** (road course, unknown, anything not special-cased) behaviour is unchanged: the readback fires the instant the car enters the approach zone (`TrkLoc.AproachingPits`). Cars **exiting** the pits never trigger it. There is no time delay involved.

The engineer also runs a **pit-box count-in** as you drive down pit road toward your box, counting the remaining distance down — "five" at 120 m, "four" at 100 m, "three" at 80 m, "two" at 60 m, "one" at 40 m, and "pit now" at 20 m — so you know when to stop without overshooting the stall. The box position comes from `DriverInfo.DriverPitTrkPct`, so it works on the first stop of a session; each mark fires once per pit-road visit and the count resets when you leave pit road. Toggle it in **Race Engineer Callouts → Pit Box**.

### Rolling start

On a **rolling start** the engineer calls out once the moment the pace car starts moving and the field begins to roll into the formation lap — "Pace car's rolling. Time to go, get moving and follow the car ahead." and four more variants (picked at random) — prompting you to get going and form up behind the car ahead. It fires only on rolling starts (standing starts get the light-gantry sequence and numeric countdown instead) and is distinct from the **One pace lap to go** flag call, which fires near the END of the formation lap as the field bunches up for the green. Toggle it in **Race Engineer Callouts → Rolling Start** ("Pace car moving"), on by default.

### Spotter calls

The spotter is a **Race Engineer voice callout family** — like flags, position, or lap time — not a separate Stream Deck mode or button. The Race Engineer voices spoken side-awareness as cars come and go alongside you, gated by the Race Engineer master (`raceEngineerEnabled`) plus the two per-callout opt-ins below. The calls are driven off the same `radar.changed` event that feeds the Radar tick (no new bus event), so the two coexist on the same proximity signal but are otherwise fully independent — the spotter speaks on `AudioBus.Voice`, Radar ticks on `AudioBus.Alerts`.

Each side transition is a single pre-recorded clip — one clip per transition, never sequenced — covering arrival, escalation, de-escalation, swap, three-wide, and clear:

- **Arrival** — "Car left." / "Car right." (one car) or "Two cars left." / "Two cars right." (two cars on one side).
- **Three wide** — "Three wide." when a car is on both sides.
- **Escalation** — a one-car side picking up a second car plays "Two cars left." / "Two cars right.".
- **De-escalation** — two cars dropping to one announces "One car left." / "One car right." (symmetric with the escalation wording).
- **Combined swap / clear-one-side** — when one side clears while the other still has cars, a single combined clip carries both cues: "Clear right. Car left.", "Clear left. Two cars right.", etc.
- **Clear** — once all cars are gone, "Clear." plays — but only after a short confirmation buffer: the engine holds the call until the gap to the nearest car (from `CarIdxLapDistPct` × `WeekendInfo.TrackLength`) has grown by ~0.5 m, so a car flickering at the lateral detection boundary doesn't stutter "Cle…car right…clear". A ~1.5 s fallback still clears if a car separates purely sideways (so the lap-distance gap never grows).
- **Still there** — for as long as a car stays alongside, a repeating reminder plays ("Still there." / "Hold your line."), at a user-configurable cadence (`spotterStillThereSeconds`, 1–10 s, default 3).

Road vs oval terminology is automatic. On a road course (no track rotation) the calls use **left/right**; on an oval the engineer uses **inside/outside**, mapped from `WeekendInfo.TrackDirection` (a left-going oval makes the physical left "inside"; a right-going oval reverses it). This is resolved per fire via `resolveTrackDirection`, so the same clip catalog covers both with no user configuration.

While any car is alongside, the spotter acquires an **exclusive focus floor** on the Voice bus at safety weight, holding back routine chatter (lap times, position updates, pit recaps) so the channel stays clear — but safety-critical flag callouts at or above the floor still break through. The floor releases the moment everything clears, draining any deferred chatter. The whole feature force-clears (focus released, loop stopped, no clip) when the Race Engineer master (`raceEngineerEnabled`) is off, when both opt-ins are off, when the car is on pit road, or in a Lone Qualify session.

Two opt-ins live under **Race Engineer Callouts → Spotter**, both enabled by default:

- **`calloutEnabledSpotterCars`** — every transition call (car / two cars / one car / three wide / clear / combined). Disabling silences the spoken calls while leaving the focus gate and loop logic operating.
- **`calloutEnabledSpotterStillThere`** — the "Still there." reminder loop. Disabling stops the loop without affecting the transition calls.
- **`spotterStillThereSeconds`** (1–10, default 3) — the "still there" reminder cadence in seconds, set by the "Reminder interval (s)" slider in the PI.

Both opt-ins (and the interval) are read live on every event/tick, so changing them mid-session takes effect on the next call without cutting one already playing.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Mode | Dropdown | Race Engineer Toggle | Selects what the key press does |
| Direction | Dropdown | Up | Up / Down step, visible only when Mode = Radar Volume |

### Mode Options
- **Race Engineer Toggle** - Toggles the engineer voice on/off
- **Radar** - Toggles the directional proximity ticks on/off
- **Radar Volume** - Steps the global Radar volume up or down (deprecated, hidden from the dropdown)

### Direction Options
- **Up** - Bumps Radar volume by 5 (max 100)
- **Down** - Reduces Radar volume by 5 (min 0)

### Plugin-global Audio Settings (in the Pit Crew accordion, not under Global Settings)

The Pit Crew Audio accordion in the action's Property Inspector hosts every plugin-wide audio control. Race Engineer settings appear first, Radar second, and the shared Output Device last.

- **Race Engineer Voice** - dropdown of voices available under `voice/<voice>/` in `@iracedeck/audio-assets`. Substituted into scenario `base: "voice/{voice}"` at clip-resolution time so a swap takes effect on the next scenario fire. Falls back to the first available voice if the persisted choice is gone.
- **Driver Name** - dropdown populated from clips under `voice/<voice>/names/` for the active voice. Picked into the welcome / test playback flows via the engine's variable resolver. Falls back to the first available name when the persisted choice is gone.
- **Race Engineer Volume** (range 0–100, default 50) - slider that controls the Voice bus volume. Mirrored by a **Test** button that auditions a chained sequence (opener → driver name → "Nice to meet you" → "Let's win some races") in the picked voice at the picked volume, so the user can verify the mix without leaving the PI.
- **Background Volume** (range 0–100, default 25) - slider that controls the Background bus volume (pit ambient loop + walkie-talkie open/close SFX). Mirrored by a **Test** button that previews a representative tick-open + ambient + tick-close sequence. Only takes effect while Race Engineer is enabled — when the engineer is off, Background is muted regardless of this value (issue #471).
- **Radar Volume** (range 0–100, default 50) - slider that controls the Alerts bus volume. Mirrored by its own **Test** button that fires a one-shot directional ping. Stepping to 0 mutes the radar without toggling the feature off.
- **Output Device** - audio device used for the iRaceDeck audio engine; shared globally across the plugin. Persisted by the platform-stable device id (WASAPI endpoint ID on Windows), so the selection survives device-list reordering, replug, and OS audio-preference changes.

## Keyboard Simulation

None. Pit Crew drives its own audio framework; it does not emit keyboard events.

## Icon States

The Radar mode paints a status bar on the lower third of the key (green when the feature is on, red when off). Radar Volume modes paint no status bar — the current volume shows as a percentage in the title.

| Mode / State | Icon |
|--------------|------|
| Radar — on | Radar-sweep glyph, status bar green |
| Radar — off | Radar-sweep glyph, status bar red |
| Radar Volume Up | Radar glyph + up arrow, title shows `VOL +` and current % |
| Radar Volume Down | Radar glyph + down arrow, title shows `VOL −` and current % |

## See also

- Audio architecture design: `docs/plans/2026-04-19-audio-architecture-design.md`.
- AI Spotter Controls (separate action wrapping iRacing's built-in AI spotter — different system, different audio source): `docs/plugins/core/actions/ai-spotter-controls.md` (if present).
