---
title: Pit Crew
description: Directional proximity radar driven by the iRaceDeck audio framework.
sidebar:
  badge:
    text: "3 modes"
    variant: tip
---

Pit Crew bundles iRaceDeck's pit-side audio into one Stream Deck action. It exposes **Race Engineer Toggle** (the default — flips the engineer voice on/off), **Radar** (directional proximity ticks when a car pulls alongside), and **Corner Names** (toggles the corner-name callouts in practice and test sessions). The Race Engineer voice also speaks **Spotter** side-awareness calls ("car left", "three wide", "clear") — these are a voice callout family, not a separate mode (see [Spotter (side-awareness calls)](#spotter-side-awareness-calls) below).

Radar volume (Up/Down stepping) now lives in the [Audio Controls](/docs/actions/audio-voice/audio-controls/) action under the **Radar** mode, alongside the new **Race Engineer** volume buttons. Existing Pit Crew buttons configured for Radar Volume keep working, but new buttons set up volume control from Audio Controls.

Both the Race Engineer and Radar gates ship **off by default** so a fresh install stays quiet until you opt in. The first press of each toggle is what enables it; the on/off state is plugin-wide, so two Pit Crew buttons (e.g. one on a Stream Deck, one on a Mirabox) always agree.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Race Engineer Toggle

The default mode. Pressing the button flips `raceEngineerEnabled` in plugin-global settings (off by default). When off, both the engineer voice (Voice bus — messages, acknowledgments, toggle confirmations) and the pit ambience (Background bus — pit ambient loop and walkie-talkie SFX) are silenced synchronously, so any in-flight clip cuts off on the same key press. Radar ticks are unaffected — they have their own toggle. Re-enabling restores Voice to the configured Race Engineer Volume and Background to the configured Background Volume.

The engineer plays a short voice acknowledgment on every press — *"Okay, going silent."* when you disable it and *"Roger, resuming communication."* when you re-enable. The disable line plays through after the gate flips off (every other Voice clip silences immediately so it's the only thing you hear), then Voice mutes once the line finishes. Disable from **Race Engineer Callouts → Race Engineer Toggle** in the Settings window to keep the toggle silent.

The Settings window's **Race Engineer → Enabled** checkbox flips this same state, with the same acknowledgment, and its **On startup** setting decides what the engineer comes up as after a restart — see [Now versus on startup](/docs/getting-started/settings/#race-engineer-and-radar-now-versus-on-startup).

When iRacing telemetry first starts flowing — typically a few seconds after you launch iRacing with Race Engineer already enabled — the engineer fires a short *"<name>, radio check. Standing by."* line so you have audible confirmation that the plugin is talking to iRacing. This is a separate opt-in (**Race Engineer Callouts → Telemetry Connect**) from the toggle acknowledgment, so you can keep one and silence the other. The line re-fires on a real reconnect (iRacing closed and reopened, or a transient SDK drop) but not on repeated telemetry ticks within the same connected session.

#### Details

- **Dial:** No rotation support
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

### Radar

Toggles the directional proximity tick loop on/off. Pressing the button flips `radarEnabled` in plugin-global settings (off by default) and synchronously stops or starts the tick loop on `AudioChannel.Radar` (so a tick can't fire after the user already muted it). The status bar flips green ↔ red.

The Settings window's **Radar → Enabled** checkbox flips this same state, and its **On startup** setting decides what the radar comes up as after a restart — see [Now versus on startup](/docs/getting-started/settings/#race-engineer-and-radar-now-versus-on-startup).

#### Details

- **Dial:** No rotation support
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

### Corner Names

Toggles the [corner-name callouts](#corner-names-practice--test) on/off. Pressing the button flips the same **Race Engineer Callouts → Corner Names** setting as the Settings window checkbox, so the key and the checkbox always mirror each other — and unlike the other two toggles, the callouts ship **enabled** by default. The status bar flips green ↔ red and follows the setting live, whichever surface changed it.

The engineer confirms each press with a short line — *"Roger that. Corner calls coming up."* when you enable, *"Copy that. Dropping the corner calls."* when you disable — as long as the Race Engineer master is on. Disable the confirmation under **Race Engineer Callouts → Corner Names → Toggle on/off acknowledgment**. With the Race Engineer master off, the toggle still flips the setting silently — but the corner names themselves stay quiet regardless of this key, because every engineer callout requires the master.

#### Details

- **Dial:** No rotation support
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

## Global Audio Settings (shared across every Pit Crew button)

These apply to every Pit Crew button at once, so they live in the [Settings window](/docs/getting-started/settings/#race-engineer) on the **Race Engineer** tab rather than in one button's Property Inspector. Open it with the **iRaceDeck Settings** button directly under any iRaceDeck key's own settings.

- **Race Engineer Voice** — dropdown of voices available under `voice/<voice>/` in `@iracedeck/audio-assets`. Substituted into scenario `base: "voice/{voice}"` at clip-resolution time so a swap takes effect on the next scenario fire. Falls back to the first available voice if the persisted choice is gone.
- **Your Name** — name the engineer addresses you by; resolves a clip from `voice/<voice>/names/`.
- **Race Engineer Volume** (0–100, default 50) — slider + Test button for the engineer voice (`AudioBus.Voice`). Sliding to 0 silences voice scenarios without disabling the Race Engineer feature.
- **Background Volume** (0–100, default 25) — slider + Test button for the pit ambience and walkie-talkie SFX (`AudioBus.Background`, which carries both the ambient loop and the radio open/close SFX). The Test button plays a representative tick-open + ambient + tick-close preview. Defaults to 25 so it sits under the engineer voice cleanly out of the box; turn it up if you want a louder pit-lane atmosphere. Only takes effect while Race Engineer is enabled — when the engineer is off, Background is muted regardless of this value.
- **Radar Volume** (0–100, default 50) — slider + Test button. Shared across every Pit Crew instance; the button lets you preview the left → right → both sequence without waiting for a live proximity event. Sliding to 0 mutes the radar without toggling the feature off.
- **Output Device** — the audio device used for the iRaceDeck audio engine; shared globally across the plugin. The selection is persisted by the platform-stable device id (WASAPI endpoint ID on Windows), so it survives replug and Windows audio-preference changes — no need to re-pick after rebooting or moving the headset to a different USB port.

## Race Engineer voice coverage

When the engineer is enabled, the Pit Crew catalog calls out every flag transition the iRacing translator publishes:

- **Yellow** — scope-aware: full-course yellow ("pace car deployed") and local sector yellow ("mind the slow cars") play different lines.
- **Yellow waving (local)** — a separate, more urgent line ("Local yellow waving — slow, hazard ahead!") for a waving local yellow, distinct from the static local yellow above.
- **Caution waving** — a separate, more urgent line ("Caution coming out!") for a waving full-course caution, distinct from the static full-course yellow above.
- **Yellow cleared** — engineer announces when the yellow drops. It fires only when every yellow-ish flag (static and waving, local and full) has cleared — escalating a static yellow to its waving variant never triggers a false "all clear".
- **Green** — race-restart / race-on callout. Suppressed at the race start itself (the Start Lights family below owns the start); it still fires on restarts (caution → green).
- **Blue** — alternates between two recorded variants ("faster car approaching" / "check your mirrors").
- **White** — a two-stage final-lap alert in races: a heads-up when the white flag comes out (iRacing shows it while the leader is closing on the line to start the final lap — *"White flag. We're about to start the final lap."*), then *"This is the last lap."* as you cross start/finish and begin yours — leader included. If you cross while the heads-up is still playing, you keep just the heads-up (the two lines never talk over each other). Practice and qualifying keep their single raise-time line. A third stage covers everyone else in the field: when the OVERALL race leader starts their final lap — detected from lap counting, or in a timed race from the leader's first start/finish crossing after the clock expires — the engineer announces *"The leader is about to start their final lap."*, so you have advance notice even while your own white flag is still a lap or more away. It fires once per race (a new green flag — overtime, a restart — re-arms it) and stays silent if you ARE the leader or your own white flag is already up, since you'll hear your own heads-up instead. All three stages share the White callout toggle.
- **Crossed** — "Crossed flags." (leaders and tail-enders sharing the track at the halfway point).
- **One pace lap to go** — a heads-up that one pace lap remains on a rolling start, given as the pace car crosses start/finish to begin the final pace lap (the engineer assumes at most two pace laps). The engineer rotates through several recorded variants.
- **Green held** — the green is being held a moment longer: a "green any second, get ready" heads-up as the field bunches up (several recorded variants).
- **Ten to go** — "Ten to go!" (ten laps remaining).
- **Five to go** — "Five to go." (five laps remaining).

The four race-formation / progression callouts above (Crossed, One pace lap to go, Green held, Ten/Five to go) fire **in race sessions only, and only while you are in the car** — iRacing raises the grid flags while forming the race grid at the end of a qualifying session, so gating them to the race (and to being on track, not watching a replay or spectating the grid) keeps them from firing at the qualifying checkered. They are also silenced **after the race finishes** (the checkered / cool-down phases), so a late "pace lap" or progression flag can't blurt out once the race is over.

"One pace lap to go" is specific to a **rolling start**: it fires **once, at the moment one pace lap remains** — the engineer assumes a rolling start runs at most two pace laps, so the callout lands as the pace car crosses the line to begin the final pace lap, the moment the field is committed to another lap (your own crossing is the fallback when the pace car can't be tracked). It stays **silent on standing starts** (a standing start has no pace lap — the Start Lights family below owns that lead-in) and on single-pace-lap formations (there's no earlier lap to anchor against, so nothing fires before the green). **"Green held"** remains the green lead-in itself — the engineer's heads-up (several recorded variants) that the field is bunching up and the green is seconds away.

- **Red / Black / Debris** — single dedicated callout each.
- **Disqualify** — its own "Disqualified. Pull off." line, split out from the generic Black callout so a DQ reads distinctly.
- **Furled** — "Black flag furled." (a furled black flag — a warning, not yet a penalty). Announced only after the flag has stayed up for a full second — a brief off-track excursion flashes iRacing's furled bit for about half a second, and that flicker stays silent. And if the call gets queued behind other radio traffic and the warning is withdrawn before it can play, it stays silent too — the engineer never announces a flag that's already gone.
- **Furled cleared** — "Black flag cleared." when an announced furled warning is withdrawn. It fires only if the furled callout actually played, so a transient flicker triggers neither callout.
- **DQ scoring invalid** — "DQ — scoring's off." (disqualification because scoring is invalid).
- **Checkered** — session-aware: practice, qualifying, and race finishes get distinct lines. In qualifying and races it's spoken as you take the flag at the start/finish line, not the moment the session ends — so on your final qualifying lap the call comes when you actually cross the line. In practice it's spoken immediately when the flag rises (the flag there just means the session is over). (In qualifying, if you're in the pits or out of the car when the checkered flies, it's spoken right away; driving into the pits after the flag also counts as done. In a race you take the flag at the line — even from pit lane.)
- **Meatball** — the only flag callout marked **urgent + preempt**: it cancels in-flight engineer chatter mid-message, since failing to pit on a meatball costs a black-flag penalty. All non-meatball flag callouts share a `flag` family so a newer flag preempts an older one (no "yellow's clear" + "green flag" double-talk on race restart).

Pit-service confirmations (fuel on/off, every tire-set selection, dry/wet compound switch, windshield-tearoff on/off, fast-repair on/off) continue to fire on the relevant Tire Service / Pit Service action presses.

The engineer also calls out every iRacing-reported pit-service status transition during the stop itself — "crew working", "all done", positioning corrections ("too far left, line it up", etc.), and "crew can't fix that this stop" — so you can keep your eyes on the windscreen and react by ear.

## Start Lights

On a **standing start** the Race Engineer walks you through the gantry sequence so you can keep your eyes on the lights and your hands on the wheel. The moment the gantry shows its ready state the engineer says *"Lights. Get ready to go."*, and *"Go, go, go!"* the instant the lights drop and the race is live. Both calls are **critical and interrupt** any chatter in progress so nothing buries them at the most time-sensitive moment. (Nothing is spoken when the lights go solid red — by then the start is moments away and a callout would land too late to act on.)

During the pre-start countdown the engineer also speaks the numeric marks — *"Ninety seconds to race start."*, *"Sixty seconds to race start."*, *"Thirty seconds to race start."*, *"Ten seconds to race start."* — as the clock crosses each threshold. The countdown plays **even while you're out of the car** — in the garage, the session screen, or the in-session replay view — since it's exactly the "get in the car" reminder (watching a saved standalone replay stays silent). The gantry lines above stay in-car only: if you're not in the car when the lights come up, you've missed the start. The countdown is **standing-start only** and announces only the marks that genuinely fall inside the live countdown window, so a compressed procedure (a short pre-start, an AI race) that starts below a mark simply skips the higher numbers rather than blurting a stale burst.

On a **rolling start** there's no light gantry and no numeric countdown — the lead-in comes from the race-progression flags instead: **One pace lap to go**, spoken once when one pace lap remains (the engineer assumes at most two pace laps, so it lands as the pace car begins the final pace lap), then **Green held** as the field bunches up, followed by the green flag.

Two opt-ins live under **Race Engineer Callouts → Start Lights** in the Settings window, both on by default:

- **Start lights** — the two gantry lines (get ready / go).
- **Start countdown** — the four numeric marks (ninety / sixty / thirty / ten).

## Rolling Start

On a **rolling start** the Race Engineer calls out once the moment the pace car starts moving and the field begins to roll into the formation lap — *"Pace car's rolling. Time to go, get moving and follow the car ahead."* and four more variants (picked at random) — so you know to get going and form up behind the car ahead. It fires only on rolling starts (a standing start gets the light gantry and numeric countdown above instead) and is distinct from the **One pace lap to go** call, which fires near the *end* of the formation lap as the field bunches up for the green.

One opt-in lives under **Race Engineer Callouts → Rolling Start** in the Settings window, on by default:

- **Pace car moving** — the start-of-formation call when the pace car begins rolling the field away.

## Pit Service Readback

Per-toggle confirmations alone fall short when several services are queued back-to-back — only the most recent one is heard in full and you lose the holistic picture of what's queued. The pit-service readback fixes that with a coherent recap at two key moments:

- **Pit entry** — as you roll onto pit road the engineer reads the queued plan: *"Don't forget your limiter. We're taking fuel, four tires, and cleaning the windshield."* The limiter pre-opener only plays when the limiter isn't already engaged. When this fires is track-type aware: on a **dirt oval** iRacing usually teleports the car straight into the pit stall and skips the approach zone, so there the readback fires when the car genuinely **drives onto pit road** — a teleport or tow straight into the stall stays silent. On **every other track type** (road course, and anything not special-cased) behaviour is unchanged: the readback fires the instant the car enters the approach zone. Cars exiting the pits never trigger it, and there is no time delay involved.
- **Pit exit** — a few seconds after you leave pit road the engineer plays a short *"To confirm: …"* recap of what was serviced. The settle delay keeps the line from colliding with the limiter / pit-exit chatter.

The readback is composed from per-slot clips (opener, fuel, tires-or-compound, fast repair, windshield, closer) so the catalog stays bounded. While you're still on pit road, toggling a service refires the readback so the recap reflects the latest plan — the running readback is preempted and replaced wholesale, distinct from the per-toggle confirmations which merge live.

When nothing is queued, the engineer plays a dedicated *"Not changing tires, not refueling."* line instead of stitching a series of negatives.

The fast-repair line in both readbacks is **damage-aware**: the engineer stays silent about repairs on a clean car (regardless of whether you happened to queue fast-repair). When iRacing reports damage on the car, the readback speaks the appropriate line — *"We're doing fast repairs to any damage you might have."* if fast-repair is queued, or *"We're not doing fast repair."* as a heads-up if it isn't. This stops the engineer blurting fast-repair status during routine green-flag stops while still flagging when you've forgotten to queue a repair on a damaged car.

## Damage Heads-Up

Drivers focused on the racing line can miss small impacts — a tap on the wall, an inside-line bump. The Race Engineer fires a spoken heads-up the first time iRacing reports damage that requires repair, so you know to consider a pit stop without having to look away from the track. The callout fires once on each clean → damaged transition (after a short debounce window that filters frame-rate flicker), and re-fires after a repair if you pick up new damage later.

## Incident callouts

When iRacing charges you with an incident, the Race Engineer tells you what it saw and what it cost — one line per incident category, spoken a moment after the sim reports it (a quick multi-stage crash collapses into a single call with the worst outcome):

- **Off track** — the track-limits nudge ("Watch the curbs.") when four wheels leave the racing surface. No point count — you felt it.
- **Out of control** — a composure line after a spin. No point count.
- **Contact (wall)** — a light brush against the wall or an object; it carries no penalty points, so no count is spoken.
- **Collision (wall)** — a proper wall hit, with the point count spoken: *"That cost us two penalty points."*
- **Contact (car)** — light car-to-car contact; no points, no count.
- **Collision (car)** — heavy car-to-car contact, with the point count spoken.

The spoken count is **the value iRacing actually scores for the incident** — the Sporting Code value of the detected incident category, resolved per discipline, so heavy car contact is announced as four points on pavement but two points in dirt racing. iRacing scores a multi-stage crash as one incident that escalates to its worst outcome: go off track and end up in the wall a few seconds later and the whole thing is a single two-point incident, not one plus two. The engineer follows that model — each escalation announces the incident's full current value, and a worse outcome that lands after an earlier stage was already announced corrects it, cutting the earlier line off mid-sentence if it's still playing. If no matching count line exists for the active voice, the engineer describes the contact without naming a number.

## Pit Service Status

Once the car is in the box, iRacing's status display tells you whether the crew is working, whether you're parked correctly, and whether the queued damage repair is actually feasible. The Race Engineer reads each of those state transitions out loud so you don't have to glance at the status box mid-stop:

- **In progress** — the crew is working on the car (*"Pit stop in progress."*).
- **Complete** — service finished, ready to leave the box (*"Done. Go."*).
- **Too far left / right / forward / back** — positioning correction; line the car up so the crew can reach the wheels (*"Car's too far forward, back it up."*).
- **Bad angle** — the car is parked at an angle the crew can't reach properly.
- **Can't fix that** — iRacing has decided the queued damage repair won't actually be performed this stop. This is the only iRacing-exposed signal that fast-repair / damage repair will fail, and it has no other audio surface.

The eight callouts share a single family so a positioning correction (e.g. *"too far left"* → *"too far right"* while you wiggle into the box) cleanly preempts the previous one without queueing. Closing transitions back to the idle state are silent.

### Repeated positioning corrections

A positioning error is the one status that needs saying twice. iRacing announces it **once** — its own spotter says *"You are too far forward, back up!"* and then goes quiet — so a driver who backs up but stops with the wheels still short of the box sits there getting no service, with nothing to tell them they're still in the wrong spot.

While one of the five positioning errors is still uncorrected, the Race Engineer therefore keeps nudging you with a short follow-up roughly **every two seconds** — *"Still too far forward."*, *"Back it up."*, *"Back up, you're too far."* — until the car is in the box or iRacing reports a different error. These are terse and deliberately have no radio beeps around them, since at that cadence the beeps would drown the words.

Four things keep it from becoming noise:

- **It goes quiet while you're moving.** As soon as the car is rolling — even at the inch-by-inch crawl a box correction takes — the repeats stop, because you're already fixing it. They pick up again about half a second after the car comes to rest, if the error is still there.
- **A different error starts over.** Over-correct from *too far forward* into *too far back* and you get the new error's full call, spoken in the usual conversational form, and the repeat cycle restarts from there. A repeat never talks over that full call.
- **It stops when you leave the pit lane.** Give up on the stop and drive out and the corrections stop with you — they'll never follow you onto the track and start up again the next time you happen to come to a stop.
- **It won't tell you something that's stopped being true.** Each correction re-checks how the car is actually parked in the moment before it speaks, so one that had to wait behind a longer message is dropped rather than telling you to back up when you're already sitting correctly in the box.

The corrections also survive the plugin restarting mid-stop — an automatic Stream Deck update in the middle of a pit stop won't leave you parked wrong in silence for the rest of it.

There is **no separate setting** for the repeats — they're part of the same callout, so turning off e.g. **Too far forward** under Pit Service Status silences both its initial call and its follow-ups. *In progress*, *Complete*, and *Can't fix that* never repeat: they state a fact rather than an error waiting to be fixed.

## Session Start

Around 3 seconds after a **practice or qualifying** session starts — even if you're still in the garage — the Race Engineer greets you by name and reads a short situational brief — *"Ok, Niklas, it's time to qualify. The pit speed limit is 80 kilometers per hour. Track temperature is 28 degrees Celsius, air temperature is 20 degrees Celsius, and the track is mostly dry."* The session-type line varies between practice and qualifying. The brief also fires when you connect into a practice or qualifying session that is already in progress.

Units follow iRacing's own display setting — metric drivers hear km/h and degrees Celsius, imperial drivers hear mph and degrees Fahrenheit. The pit speed limit is rounded to the nearest whole unit before it's spoken, and is only read out when it matches one of the known iRacing pit limits the engineer has a clip for — otherwise the pit-speed part of the brief is simply skipped rather than guessing a number.

In **race** sessions the session-start brief is suppressed entirely — the dedicated **Race Start** callout below takes its place.

## Race Start

Around 3 seconds after iRacing changes to a race session — even if you're still in the pit or garage — the Race Engineer greets you by name, reports your grid position, and reads the same temperature + wetness brief as the session-start callout (without the pit speed limit, since you already heard it during practice / qualifying).

- **P1** — *"Time to race, Adam. Starting from pole. Well done. Track temperature is twenty-eight degrees Celsius, air temperature is twenty degrees Celsius, and the track is mostly dry."*
- **P2..P64** — *"Time to race, Niklas. Qualifying put us to P seven. Track temperature is thirty-two degrees Celsius, air temperature is twenty-four degrees Celsius, and the track is dry."*
- **Position unknown or above P64** — the grid-position clause is skipped entirely; the engineer still speaks the greeting and conditions.

In a multi-class race the grid position is your **class** grid slot, not your overall qualifying rank — so a GT3 racer who qualified P15 overall but third in class hears *"Qualifying put us to P three,"* and leading your class off the line plays *"Starting from pole."* This matches how the rest of the race callouts focus on your class.

Because the callout fires off the session-change event, it arrives in time to be useful during grid prep — even if you sit in the garage. Practice and qualifying sessions get the same treatment from the session-start brief above, which fires the same way at session start.

## Setup Warning

Right after the qualifying or race intro, the Race Engineer adds a quick "double-check your setup" nudge when the loaded setup's **name** looks wrong for the session — *"Our setup name suggests that we're on a race setup. Please double-check."* in qualifying, or *"Our setup name suggests that we're on a qualifying setup. Please double-check."* in a race. It's an easy, costly mistake to line up for the race still trimmed out on the qualifying setup (or qualify on a heavy race setup), and a name-based heads-up catches it before it matters.

This is a **heuristic on the setup name only** — it never reads the setup's actual contents and never changes anything, so it only ever asks you to verify. Matching is done by two **case-insensitive regular expressions** you can edit under **Setup Warning Patterns** — one applied during qualifying (default flags a race-looking name), one during a race (default flags a qualifying-looking name). By default a word is matched when it's bounded by the start or end of the name, a space, a period, a hyphen, or an underscore, so `qualifying.sto`, `Q.spa`, `quali-fast`, and `VRS_quali_v2` all match while `race.sto` and `baseline` don't. Each pattern has a **Reset to default** button, and if you enter a pattern that isn't valid regex the Settings window shows a warning banner and the callout is simply skipped until you fix it.

Toggle the whole feature from **Race Engineer Callouts → Setup Warning**. It fires once at session entry (a mid-session setup reload doesn't re-trigger it), and practice sessions never warn.

## Lap Time (Best Lap)

A couple of seconds after you cross the start/finish line, the Race Engineer announces your lap time if you just set a new personal best — *"That was your best lap yet. One minute, twenty-three point four seconds."* The first valid lap of a session uses a different intro since there's no prior best to beat — *"That lap was one minute, twenty-three point four seconds."*

Sub-1-minute laps skip the minute clip — *"That was your best lap yet. Thirty-four point eight seconds."* The lap time is announced to one decimal place (rounded to the nearest tenth). Lap times of 11 minutes or longer stay silent — the engineer never speaks a partial readout, and the minute-clip range stops at 10 for now. The minute coverage will expand in follow-up releases.

On the final lap of a race the best-lap callout is suppressed — the race-end result takes the floor instead.

## Qualifying Lap Invalidation

When you pick up an incident during a qualifying lap — an off-track, contact, anything iRacing counts — the Race Engineer tells you right away that the lap is gone: *"This lap will be invalidated."* In a lap-limited qualifying he follows up with how many attempts remain after this one:

- **Out of laps** — *"We're out of qualifying laps, so that's it for now."* (the incident happened on your final counted lap)
- **1–5 laps left** — a per-count line with its own encouragement, e.g. *"One lap left. Make sure to have a flying start for the last lap."* or *"Two laps left. Take a breath, reset, and go again."*
- **6 or more** — *"We still have plenty of laps left. Take your time to settle in."*

In a time-limited qualifying only the core line plays — a lap count would be meaningless there.

Multiple incidents on the same lap collapse into a single callout. The engineer also stays quiet on laps that aren't timed attempts: the out-lap (and any lap that started from pit exit), and the extra laps after your counted attempts are done — in a lap-limited qualifying iRacing lets you keep circulating once your attempts are used up, but an incident there invalidates nothing, so nothing is announced.

Toggle it from **Race Engineer Callouts → Qualifying → Lap invalidated**. Race and practice sessions never fire this callout.

## Position Change (qualifying + race)

After each completed lap in qualifying or race, the engineer announces your current position when it changed since the previous lap.

In qualifying the wording follows the standings-after-lap-time model: *"That puts us to pee three."* on a gain, *"We're currently pee five."* on a loss. The engineer also speaks the status line on a slow lap where position holds, and an improvement to P1 gets a dedicated *"That puts us on pole."*

In race the wording is always *"We're currently pee N."* regardless of direction — race standings come from overtakes and pit stops, not lap times, so "that puts us to" reads wrong there. The pole call doesn't apply in race either. The every-3-laps race-status callout below handles hold-position updates, and the final lap stays silent so the race-end result has the floor. Practice and test sessions stay silent entirely.

When iRacing flags the just-completed lap as invalid (track-limits cut, pit-lane violation, etc.) the engineer prefixes the readout with *"That lap didn't count."* and always uses the "currently" framing — *"That lap didn't count. We're currently pee five."* — so you know the time was thrown out. The invalid-lap prefix overrides the pole and "puts us to" branches even if standings shifted on paper from other drivers' laps.

## Race Position Status (every 3 laps)

During race sessions, the Race Engineer announces your current position every 3 laps as long as your position holds — *"We're currently pee five."* The lap counter resets every time your effective position changes, so a gain or loss restarts the cadence cleanly. When you're running first, you get a dedicated line — *"We're still leading the race. Keep it up."* — instead of the generic status. In a multi-class race this tracks your **class** position, so leading your class plays *"We're still leading our class. Keep it up."*

The status is suppressed on the final lap; the race-end callout speaks the result there instead. Qualifying, practice, and test sessions stay silent — the qualifying position-change callout already covers those.

## Race End (final result)

When you cross start/finish under the checkered flag in a race session, the Race Engineer greets you by name and speaks the result once per session:

- **P1** — *"Niklas, we won! We won! Well done. Amazing job. You deserved this win."*
- **P2** — *"Niklas, that's second place. Very well done."*
- **P3** — *"Niklas, we made it to the podium. We're third. Well done."*
- **P4 and below** — *"Niklas, the race is over. The final result for us is pee seven."*

In multi-class series the engineer reads your class position, not the overall — winning your class always plays the *"we won!"* line even if you crossed the line behind faster cars from another class. Disabling this in the Settings window silences only the final-result line; the periodic status callout above remains independent.

## Overtakes (gained / lost during a race)

Mid-race position swaps fire as they happen, in **two parts**: a reaction, then the current position. When you pass someone and hold the new spot for about three seconds, the engineer reacts — *"Nice pass."* — and then, a beat later, reads your position — *"We're currently pee five."* Taking the lead gets a single dedicated line instead — *"Nice pass! We're now leading race. Let's keep it that way!"* — with no position follow-up (it already says you're leading). When someone passes you and the new (worse) spot sticks for the same window, the engineer says *"Come on, Niklas. Don't give up positions like that."* and then *"We're currently pee five."*

The position in that second part is read from **live telemetry at the moment it's spoken**, so it's accurate even if you've gained or lost another spot in the second or two since the pass settled. Every "We're currently P[n]" line works this way — the mid-race overtake readout, the per-lap position update, and the every-3-laps status all read your live position when they speak. **The position is announced on every overtake** — in a sustained battle you'll keep hearing where you are, even when the reaction catchphrase is throttled.

The catchphrase itself ("Nice pass." / "Come on…") has its own **20-second per-direction cooldown** so it doesn't repeat on every pass — make three passes in quick succession and you'll hear "Nice pass." once, then just the position on the next two. Taking the lead is exempt: that line always plays. A separate 20-second cooldown stops the per-lap and every-3-laps position updates from piling on right after an overtake already told you where you are.

The engineer stays quiet about a swap that wasn't a clean racing move. The whole callout — both the catchphrase and the position — is suppressed when:

- **a car is alongside** (the proximity radar shows someone immediately left or right) — wheel-to-wheel, the position is unstable;
- **you're off-track**, **crawling below 50 km/h**, or **on pit road** — you weren't racing for that spot;
- **you just had an incident** (within the last 10 seconds) — the drop or gain is a consequence of the moment, not a clean fight;
- the race has **already ended**.

A 10 m physical-gap check on top of the three-second sustainment also filters the "clean but still side-by-side" case where the swap could easily reverse, and sim-glitch position jumps (more than three places in a single tick — a tow or teleport) are ignored.

In multi-class series the engineer reads your class position, not the overall — including the leader line: taking your **class** lead plays *"Nice pass! We're now leading our class. Let's keep it that way!"* (the overall-leader wording is reserved for single-class races). The gain and loss callouts have independent opt-outs in the Settings window — disable one without affecting the other.

## Opponent pit entries (races)

Knowing who is diving into the pits is strategically valuable: it tells you when track position is about to change, whether to stay out or react, and when the leader has handed you the lead. In **race sessions** the Race Engineer announces when the drivers that matter enter the pits — the race leader, and same-lap competitors within **two positions** of you. The wording follows the car's relation to you: *"The leader is pitting."*, *"The car ahead is pitting."*, *"The car behind is pitting."*, and for a car two positions away, *"The car in, P4, is pitting."* — the position number is read live at the moment the line is spoken, from the same live race order the position callouts use. In multi-class races everything is read in **your class**: only class rivals are announced, and "the leader" means your class leader.

The trigger is the car **entering the pit-approach zone** (the same track-surface state your own approaching-pits callout uses), so the call lands as the car commits to pit entry — earlier than waiting for it to be on pit road. Cars three or more positions away, lapped cars, and cars far ahead (other than the leader) are never announced, and each car announces at most once per stop.

On ovals, a full-course caution can send half the field down pit road at once — enumerating every car would be unbearable. When **three or more** eligible cars enter the pits within a short window, the engineer collapses the calls into a single *"And it seems there are other cars pitting as well."* after the first two individual announcements, then stays quiet until the rush is over. The leader is always announced individually, even during such a pit train (and ahead of same-moment pit entries).

Nothing is announced in practice or qualifying, before the green flag, or while watching a replay. Two opt-ins live under **Race Engineer Callouts → Opponent Pits**, both enabled by default — see [the opt-in list below](#race-engineer-callouts-per-subject-opt-inout).

## Opponent penalty flags (races)

iRacing flags other cars for the same penalties you can pick up yourself, and hearing about them is often as useful as hearing your own — a black flag or meatball explains why a rival's suddenly slower, and a flag on the car you're closing on is worth knowing about before you arrive. In **race sessions** the Race Engineer announces four penalty flags on other cars — the furled black flag (a warning), the black flag, the meatball (mandatory repairs), and disqualification — but only for cars that actually matter to you: a same-class, same-lap rival up to **three positions ahead**, the car directly behind you in class, or **any** car within roughly ten seconds ahead of you on track, regardless of class or lap — slow traffic you're about to catch is worth a heads-up even if it's a lapped car from another class. The wording follows the relation: *"The car in, P4, has a black flag. They'll be serving a penalty."* for a rival ahead (the position read live, the same way the opponent-pit callout above does), *"The car behind has a meatball. They'll be coming in for repairs."* for the car right behind you, and *"The car ahead on track has a furled black flag."* for slow traffic you're catching. In multi-class races the ahead/behind relations are computed in your class; the on-track slow-traffic case ignores class and lap entirely since it's about physical proximity, not standings.

Two different moments trigger the same lines: the flag going up on a car that's already in range, or a car that's already carrying the flag entering range (catching up to a flagged rival, or a flagged car dropping back into your window). Either way you hear the same wording — what matters is that the flag is relevant to you right now. Each car only announces once per flag until that flag actually drops (a fresh episode), and once a flag has been announced about a car it won't repeat about that same car and flag for at least 30 seconds — but an escalation always gets through: a furled warning turning into a full black flag on the same car is per-car news with its own cooldown, and it plays individually even while a burst has collapsed into the combined call below.

As with opponent pits, a burst of flags — a full-course caution catching out several cars at once — collapses into a single *"Several cars around us have penalty flags."* once a third distinct car joins the rush in quick succession (one car collecting several flags never counts as "several cars"), then stays quiet until the rush has been over for about 12 seconds. Only flags you've left enabled ever count toward, or are described by, the combined call.

Nothing is announced in practice or qualifying, before the green flag, after the race finishes, or while watching a replay. Four opt-ins live under **Race Engineer Callouts → Opponent Flags**, all enabled by default — see [the opt-in list below](#race-engineer-callouts-per-subject-opt-inout).

## Gap callouts (car ahead / car behind)

In race sessions the Race Engineer watches the time gaps to the cars one position ahead and behind you in your **class** standings — the same crossing-time measurement as Session Info's [Gaps display](/docs/actions/display-session/session-info/#gaps). What he says is decided by **relevance**, not by raw change: the question he keeps asking is *will this development actually reach us, and how soon?* Everything is evaluated continuously from a smoothed gap rate — mid-lap, with no waiting for the start/finish line.

- **Closing in (either side)** — with a sustained closing rate, the engineer projects when contact would happen (the gap divided by how fast it's shrinking). The first call comes when that projection drops inside roughly **8 laps**, and never for a catch that would only complete after the race ends — someone eating 2 seconds a lap out of a 30-second gap with 5 laps to go stays unmentioned. A rival steadily grinding down a 10-second gap does get called: *"The car behind is closing in on us."* / *"We're gaining on the car ahead."* As the situation develops, he follows up roughly each time the projected laps-to-contact halve, so the calls naturally get more frequent as it gets serious. Once the threat fades (they stop closing), the episode resets.
- **Breaking away** — escaping a battle is announced once, as it happens: a small gap (up to ~10 seconds) being opened hard (half a second per lap or more) fires *"We're pulling away from the car behind."* / *"The car ahead is pulling away from us."* the moment the rate is established — on lap one if that's when it happens. Stretching an already broken gap is never news: opening 30 seconds into 36 says nothing. A new breakaway is only announced again after the pair has first closed back into battle range (under ~5 seconds).
- **Threshold crossing** — a gap first drops under your alert threshold (0.5–3 s, default 1.0 s): *"We've caught the car ahead."* / *"The car behind is right with us."* Each crossing announces once; it re-arms only after the gap has opened about half a second beyond the threshold again, so a nose-to-tail battle doesn't repeat the alert every corner.

When the live gap is under a minute, the engineer follows the line with the number — *"Gap is one point five seconds."* — read at the moment it's spoken, not at the moment the event fired. If the call was queued behind another one and you have swapped places with that car in the meantime, he gives you the line without a number rather than reading a different car's gap.

The engineer keeps quiet when there's nothing worth saying: a shared **cooldown** (1–360 s, default 30) spaces all gap callouts; a **consistency gate** (0–10 s, default 1.5; set it to 0 to turn the gate off and hear every development) requires each new call about the same car to agree with the story so far — "closing in" only once the gap is down that much from its highest point since the previous call, "pulling away" only once it's up that much from its lowest — so a hovering gap can't ping-pong and a sector where your rival is always briefly quicker can never fake "they're catching us" while the gap is actually growing; on the **opening lap** the engineer assumes the grid put your neighbors about 0.7 s away — being close off the start is expected, so nothing (including "right with us") is announced until a gap has genuinely moved from that spacing; and a **stability guard** ignores telemetry glitches — a gap reading only counts toward a callout after it has evolved plausibly for a fraction of a second, so a frame or two of bad data can never fire a call; nothing is announced about a neighbor a lap or more away, while either car is on pit road or off track (a rival serving a pit stop is not a battle), during messy moments (a car alongside, you're crawling, a recent incident), or after the race has ended. A neighbor change — someone pits, you get passed — resets the measurement so the trend never mixes two different cars.

Both callouts are individually toggleable under **Race Engineer Callouts → Gaps**, enabled by default, with the threshold and cooldown sliders right below them.

## Pit-box count-in

As you drive down pit road toward your box, the Race Engineer counts the remaining distance down so you know exactly when to stop without overshooting the stall: *"Five… four… three… two… one… pit now."* The marks are spoken by distance to the box — five at 120 m, four at 100 m, three at 80 m, two at 60 m, one at 40 m, and "pit now" at 20 m remaining — so the count tracks your approach regardless of pit-lane speed.

The box location comes straight from iRacing (`DriverInfo.DriverPitTrkPct`), so the count-in works on your very first stop of a session — no need to have visited the box before. Each mark is spoken once per pit-road visit and the count resets when you leave pit road, so a second stop counts down again. If you join pit road already within range, only the marks still ahead of you are spoken, and once you've passed the box the count stops. The six marks share a `pit-box` family, so a quick approach that crosses two marks in close succession cleanly preempts the in-flight clip.

The count-in fires whenever you're on pit road approaching your box, so it isn't tied to having requested pit service — a drive-through will count down too.

## Pit road speeding

Go over the pit lane speed limit and a short tick starts repeating, about three times a second, for as long as you're over it — a beeper, like a road car's over-speed chime. It stops as soon as you're back at or under the limit, with the beep already sounding allowed to finish; a brief hold keeps a momentary dip across the limit from chopping the tone into pieces. Sitting right on the limit is silent, and you never have to drive under it to earn quiet. Unlike everything else the engineer says this isn't a spoken line and it doesn't wait its turn on the radio: it plays straight away, because a warning that arrives after the penalty is no warning at all.

**Driving without the pit limiter, it starts the moment you exceed the posted limit, with no grace margin.** That is deliberate: you are the one holding the speed, so the tick has to tell you the instant you drift over — if you're hearing it you are genuinely over.

**With the pit limiter engaged, it allows about 0.3 km/h before it speaks.** The limiter parks your car right on the limit rather than under it, and while it's holding you there you have nothing left to do about it — you can't lift, the car is already doing the only thing available. A tick in that situation would be nagging about something you've already handled. It still sounds if a limiter car is genuinely speeding, so a limiter that isn't holding is not silently ignored.

The cue fires on **every car**, whether or not yours has a pit limiter. Pit-road speeding penalties apply to everyone, and a car with no limiter is the one whose driver has no dashboard cue to fall back on.

It also starts if you're **already speeding when the engineer starts listening** — reconnecting to iRacing, or the plugin restarting mid-session after a deck software update. The tick describes what your car is doing right now rather than announcing a moment that has passed, so there's no sense in which it can be "too late to mention".

Two things are worth knowing about how it's mixed. The tick plays on the same channel as the [Radar](#radar) proximity ticks, so it follows your **Radar volume** — turning radar volume to zero silences this too. And it doesn't duck under spotter calls: if a car pulls alongside while you're speeding on pit road you'll hear both, which is deliberate, since both are telling you something you need at that moment.

### The spoken warning

Stay over the limit and the tick is joined by a spoken line. The tick is the reflex signal — it tells you *that* you are over — and the line is the escalation that tells you what to do about it. What it says depends on the car, because the remedy does:

- **A car with a pit limiter** hears *"You are speeding. Slow down."*
- **A car without one** hears *"Over the limit. Lift."*

A limiter car is almost always speeding because the limiter is off, so the useful instruction is to reach for the button. A car with no limiter has no button to reach for and has to lift instead. The line is chosen from whether your car **has** a limiter at all, not from how it is behaving, so neither one reaches the car it was not written for.

The tick itself is unchanged and still sounds on every car — the spoken line rides on top of it rather than replacing it.

Three opt-ins in the Settings window cover pit-road speeding, all on by default:

- **Race Engineer Callouts → Pit Speeding → Pit road speeding** — the repeating tick. Turning it off silences the cue entirely.
- **Race Engineer Callouts → Pit Limiter → Speeding (limiter car)** — the spoken line on cars that have a limiter.
- **Race Engineer Callouts → No Pit Limiter → Speeding (no limiter)** — the spoken line on cars that do not.

Turning the Race Engineer master off silences all three.

## Pit limiter reminders

Speeding is only half of what can go wrong with a pit limiter, and what the engineer can usefully say about it depends on whether your car has one at all. So these callouts come in two groups that never both apply — the plugin checks for the limiter control itself rather than inferring it from how the car is behaving, and stays quiet when it cannot tell.

### Cars with a pit limiter

Three reminders, one for each state worth flagging:

- **Limiter off on pit road** — you came in without engaging it: *"The pit limiter is off. Please, turn it on."*
- **Limiter dropped** — it was on and has come off again while you are still between the cones: *"Your limiter dropped. Turn it back on."* This is worded differently from the one above on purpose: "dropped" tells you it *was* engaged, which changes what you go looking for.
- **Limiter on out on track** — you have left the pits with it still engaged, quietly capping your speed: *"Your pit limiter is on. Turn it off."*

These are the lines that would be nonsense on a car with no limiter, which is exactly why they are gated on having one.

### Cars without a pit limiter

A car with no limiter has nothing holding it under the limit and no dashboard cue to glance at, so instead of limiter reminders it gets the number itself on the way in:

*"Pit entry. Mind the limit. The pit speed limit is sixty kilometers per hour."*

The second half of that line is literally the [session-start briefing](#session-start) clip — the same recording of the limit, in the same units, rather than a second wording of the same fact. At a track whose limit has no recorded number the callout plays its opening line and stops there rather than reaching for a nearby one, so you may hear only *"Pit entry. Mind the limit."*

Every callout in both groups is individually switchable under **Race Engineer Callouts → Pit Limiter** and **→ No Pit Limiter**, all on by default.

## Laps of fuel left

In race sessions the Race Engineer estimates how many full laps of fuel you have left and calls the count out once per lap, around the middle of the lap: *"We're estimating that we have about 3 laps of fuel left after completing this lap."* The count means full laps **after** you finish the current one, so when the tank won't cover another full lap the engineer switches to the dedicated *"Box this lap for fuel."* call.

The estimate comes from the same validated fuel-consumption tracker as Session Info's **Laps to Empty** display — clean laps only, no out-laps, in-laps, tow laps, or refuel laps polluting the average — so the spoken number tracks what the display shows. On top of that, a configurable **safety margin** (0–3 laps in 0.1 steps, default 0.3) is subtracted before the count is derived, making the spoken estimate deliberately conservative: with the display reading 3.05 laps and the default margin, mid-lap you'll hear *"about 2 laps"*. The engineer stays silent until the tracker has at least one clean lap to average.

Each count announces at most once per stint, and only on the way down — saving fuel and raising the estimate never re-announces a higher count, and a count already spoken stays spoken. When the estimate drops several counts between laps you hear only the current one, never a stale burst. A refuel re-arms every count for the new stint. The eleven callouts share a `fuel` family, so a fresher count cleanly preempts one still playing; the 1-lap warning and the box call are treated as must-hear (they cut lesser chatter mid-sentence), 2–3 laps rank with the safety callouts, and 4–10 laps are ordinary commentary.

The engineer also stays quiet when refueling wouldn't help — and says so, once. When the estimate covers what's left of the race, no count is announced; instead, once the race is inside its last 10 laps and the tank covers them **with at least a lap to spare**, you hear a one-time *"We have enough fuel to finish the race. No need to box for fuel."* confirmation, which stays latched until a refuel or a later real warning re-opens the fuel callouts. A tank that only just covers the distance stays silent both ways — no warning, but no promise either at the estimate's precision. (In a race of 10 laps or fewer the confirmation effectively becomes a strategy brief near the start: no fuel stop needed.) The consumption and lap-time averages behind all of this exclude caution laps, so slow laps behind the pace car can't skew the estimate toward a false all-clear. This works in **every race format**: a lap-limited race compares the count against the laps left, a **timed race** estimates the laps still to run from the session clock and recent lap times — yours for your pace, the leader's for when the race actually ends, since the clock expires on the leader's race — and a race with both limits uses whichever ends the race sooner. The reassurance re-arms after a refuel, and if a consumption spike later shrinks the estimate below the race distance the warnings come back (coverage is re-evaluated every lap — suppression never eats a genuine emergency), followed by a fresh reassurance if you save your way back to coverage. Everything only suppresses on a positive "the fuel covers the race" determination: if neither the lap count nor the clock and lap times can be read, the callouts keep coming.

Your own final lap and everything after the checkered are always quiet, though, even when the estimate says the tank is short: at that point the estimate isn't precise enough to tell a real shortage from a scare, so the engineer leaves the last lap to you. The final-lap silence latches when you take the white flag and holds even if a caution replaces the white mid-lap — but a new green flag (overtime, or a restarted race) re-opens the fuel callouts, so an extended race never goes without its warnings.

Which counts you hear — and the reassurance — is configurable per callout under **Race Engineer Callouts → Fuel** — see [the opt-in list below](#race-engineer-callouts-per-subject-opt-inout).

## Corner names (practice & test)

When you're learning a track, coaching videos, setup guides, and community references name corners — *"brake later into Eau Rouge"* — rather than cite distances. In **practice and test sessions** the Race Engineer announces each named corner as you approach it: just the bare name — *"Eau Rouge."*, *"Turn five."* — timed to land **before** the corner, not in it. The lead scales with your speed: the call fires when your projected position a configurable number of seconds ahead (default **1 second**, tunable 0–5 s under **Race Engineer Callouts → Corner call lead**) crosses the corner's entry marker, so a fast approach announces earlier down the road than a slow one. Keep the lead short — through a sequence of consecutive corners a long lead blurs the calls together; a fresher corner always preempts one still being spoken.

Each corner announces once per lap. Resetting to the pits or getting towed starts a fresh run — the corners announce again on your next pass. Nothing is announced while you drive down pit road, in race or qualifying sessions, while watching a replay, or when you're out of the car.

Corner data © 2025 [Lovely Sim Racing](https://github.com/Lovely-Sim-Racing/lovely-track-data) (lovely-track-data, modified: pruned and normalized for iRaceDeck), corner names by Racing Circuits — [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), used with permission — thank you! The dataset covers roughly 68 iRacing track configurations with named turns; tracks outside it simply stay silent, and dataset updates ship with plugin releases.

Two opt-ins live under **Race Engineer Callouts → Corner Names** — the corner-name announcement itself and the toggle acknowledgment, both enabled by default — see [the opt-in list below](#race-engineer-callouts-per-subject-opt-inout). The Pit Crew action's [**Corner Names** mode](#corner-names) flips the announcement setting from a deck key, with a spoken confirmation.

## Spotter (side-awareness calls)

The Race Engineer voices spoken side-awareness as cars come and go alongside you — "Car left.", "Two cars right.", "Three wide.", a de-escalation "One car left.", combined swaps like "Clear right. Car left.", and a final "Clear." — plus a short repeating "Still there." reminder for as long as a car stays beside you. This is a **Race Engineer voice callout family** (like flags, position, or lap time), not a separate Stream Deck mode or button: it's gated by the Race Engineer master (the **Race Engineer Toggle** button) plus two Settings window opt-ins, both on by default. With the engineer off, the spotter is silent.

The wording adapts to the track. On a **road course** (no track rotation) the calls use left/right. On an **oval** the engineer uses inside/outside, derived from `WeekendInfo.TrackDirection` — a left-going oval makes your left "inside", a right-going oval reverses it. You don't configure this; it follows the loaded track automatically.

A proximity call is **always heard, immediately**: when a car pulls alongside (or the picture changes — a second car arrives, sides swap, it goes three wide), the call cuts whatever the engineer is saying mid-sentence, no matter how important — even a meatball or fuel-critical line loses the microphone to "Car left.". Critical calls aren't lost, though: a meatball, fuel-critical, or start-gantry line that gets cut (or that arrives while a spotter call is speaking) plays again as soon as the proximity call ends. The informational lines ("Clear." and the "Still there." reminder) are politer: they interrupt routine chatter but never cut a critical call — or a proximity call still being spoken.

While a car is alongside, the spotter also holds an exclusive focus on the engineer's Voice bus, so routine chatter (lap times, position updates, pit recaps) is held back to keep the channel clear — but safety-critical flag callouts still break through. The moment the car clears, the floor releases and any held chatter resumes.

"Clear" is buffered so it doesn't stutter when a car sits right on the detection boundary. Instead of calling clear the instant the proximity signal blinks off, the spotter waits until the car has actually pulled away — the gap to the nearest car (computed from each car's lap-distance and the track length) has to grow by about half a metre before "Clear" plays. If a car somehow separates purely sideways so that gap never grows, a short timeout clears anyway.

The spotter reads the **same proximity signal as the Radar mode** but is otherwise independent: Radar is the non-vocal proximity tick on the Alerts bus, the spotter is a spoken voice call on the Voice bus. Run either, both, or neither — with both enabled you'll hear a tick *and* a spoken call when a car pulls alongside.

Two callout opt-ins live under **Race Engineer Callouts → Spotter** in the Settings window, both on by default, plus one timing setting:

- **Announce cars around you** (`calloutEnabledSpotterCars`) — every transition call (car / two cars / one car / three wide / clear / combined). Turning this off silences the spoken calls while leaving the focus gate and the "still there" reminder logic intact.
- **Repeat reminder while alongside** (`calloutEnabledSpotterStillThere`) — the "Still there." / "Hold your line." loop that repeats for as long as a car stays beside you.
- **Reminder interval (s)** (`spotterStillThereSeconds`, 1–10, default 3) — how often that reminder repeats. Read live, so a change takes effect on the next reminder without a restart.

## Race Engineer Callouts (per-subject opt-in/out)

Some sessions throw the same flag over and over — debris that goes on/off every lap, rolling local yellows in a busy multi-class race. The **Race Engineer Callouts** section on the [Settings window](/docs/getting-started/settings/#race-engineer)'s **Race Engineer** tab lets you switch off any individual callout while keeping the rest. The choice is plugin-global (every Pit Crew button agrees) and takes effect **live**: unchecking a callout stops new ones of that subject on the next event, but does **not** cut a callout already playing.

Under **Flags**, all 22 flag callouts are toggleable, all enabled by default:

- **Yellow (local)**, **Yellow (full course)**, **Yellow waving (local)**, **Caution waving**, **Yellow cleared**
- **Green**, **Blue**, **White**, **Red**, **Black**
- **Disqualify**, **Furled**, **Furled cleared**, **DQ scoring invalid**
- **Crossed**, **One pace lap to go**, **Green held**, **Ten to go**, **Five to go**
- **Checkered**, **Debris**, **Meatball**

Disabling a flag also disables its preemption — a disabled callout can't interrupt one already playing. When **Meatball** is disabled, no meatball callout fires; the flag itself is still active in iRacing and you'll still see the on-screen indicator.

Under **Start Lights**, two callouts are toggleable independently, both enabled by default (see [Start Lights](#start-lights) above for the full behavior):

- **Start lights** — the two standing-start gantry lines (get ready / go). Disabling silences the gantry calls without affecting the numeric countdown.
- **Start countdown** — the four numeric marks (ninety / sixty / thirty / ten) spoken during the standing-start countdown window. Disabling silences the numbers without affecting the gantry lines.

Disabling either does not affect the other. Both are moot on rolling starts, where the lead-in comes from the **One pace lap to go** / **Green held** flag callouts instead.

Under **Opponent Pits**, two callouts are toggleable, both enabled by default (see [Opponent pit entries (races)](#opponent-pit-entries-races) above for the full behavior):

- **Leader pitting** (`calloutEnabledOpponentPitLeader`) — the race/class leader entering the pits.
- **Nearby competitor pitting** (`calloutEnabledOpponentPitNearby`) — same-lap cars within two positions of you (ahead / behind / numbered), including the aggregate "other cars pitting as well" call.

Under **Opponent Flags**, four callouts are toggleable, all enabled by default (see [Opponent penalty flags (races)](#opponent-penalty-flags-races) above for the full behavior):

- **Furled black flag (warning)** (`calloutEnabledOpponentFlagFurled`) — a furled black flag on a car that matters to you.
- **Black flag** (`calloutEnabledOpponentFlagBlack`) — a black flag on a car that matters to you. (The combined "several cars around us have penalty flags" call isn't tied to any one of these toggles — it only ever describes flags you've left enabled.)
- **Meatball (repairs)** (`calloutEnabledOpponentFlagMeatball`) — a meatball (mandatory repair) flag on a car that matters to you.
- **Disqualified** (`calloutEnabledOpponentFlagDisqualify`) — a disqualification on a car that matters to you.

Under **Pit Service**, three callouts are toggleable independently:

- **Pit entry readback** — the "Don't forget your limiter. We're taking fuel, …" recap that fires as you roll onto pit road (and refires on any toggle while you're still on pit road).
- **Pit exit readback** — the "To confirm: …" recap that plays after a short delay once you've left pit road.
- **Pit service requests** — every per-toggle confirmation (fuel on/off, tire-set selection, compound switch, windshield-tearoff on/off, fast-repair on/off). Switching this off silences the engineer on every Stream Deck pit-service press while leaving the readbacks intact.

Disabling any one of the three does not affect the others.

Under **Pit Service Status**, eight callouts are toggleable independently — one per non-idle `PlayerCarPitSvStatus` value, all enabled by default:

- **In progress**, **Complete**
- **Too far left**, **Too far right**, **Too far forward**, **Too far back**
- **Bad angle**, **Can't fix that**

Disabling a status only suppresses future events of that subject; an in-flight callout completes naturally. Disabling all eight silences the in-stop status family while leaving readbacks, flag callouts, and damage heads-ups intact. Each of the four positioning statuses and **Bad angle** also covers its [repeated correction](#repeated-positioning-corrections) — one checkbox governs both the initial call and the follow-ups.

Under **Damage**, one callout is toggleable, enabled by default:

- **Repair needed** — the spoken heads-up the engineer plays the first time iRacing reports damage that requires repair (rising edge of `EngineWarnings & (MandRepNeeded | OptRepNeeded)`). Disabling this only silences the live damage callout; the pit-service readback's damage-aware fast-repair line is unaffected.

Under **Incidents**, six callouts are toggleable — one per incident category, all enabled by default (see [Incident callouts](#incident-callouts) above for the full behavior):

- **Off track** (`calloutEnabledIncidentOffTrack`), **Out of control** (`calloutEnabledIncidentOutOfControl`)
- **Contact (wall)** (`calloutEnabledIncidentContactWorld`), **Collision (wall)** (`calloutEnabledIncidentCollisionWorld`)
- **Contact (car)** (`calloutEnabledIncidentContactCar`), **Collision (car)** (`calloutEnabledIncidentCollisionCar`)

Under **Session Start**, one callout is toggleable, enabled by default:

- **Session start conditions** — the greeting + situational brief (session type, pit speed limit, track and air temperature, track wetness) the engineer reads when a **practice or qualifying** session starts (~3 seconds in, whether or not you leave the garage). Race sessions are covered by **Race → Race start** below — disabling this checkbox does not affect the race readout.

Under **Race Engineer Toggle**, one callout is toggleable, enabled by default:

- **Toggle on/off acknowledgment** — the *"Okay, going silent." / "Roger, resuming communication."* line the engineer plays on every Pit Crew Race Engineer Toggle press. Disabling it keeps the toggle visually silent (only the button's status bar and border indicate the new state).

Under **Telemetry Connect**, one callout is toggleable, enabled by default:

- **Confirm Race Engineer on telemetry connect** — the *"<name>, radio check. Standing by."* line the engineer plays the first time iRacing telemetry starts flowing in a session. Also fires on a real reconnect (iRacing close + relaunch, transient SDK drop) but not on every telemetry tick. Gated on Race Engineer being enabled as well — if the master gate is off, no radio check fires regardless of this opt-in.

Under **Lap Time**, one callout is toggleable, enabled by default:

- **New best lap** — the post-S/F announcement of your lap time when you set a new personal best (or complete the first valid lap of the session). Disabling this silences only the best-lap callout; future lap-related callouts will be independently toggleable.

Under **Position**, one callout is toggleable, enabled by default:

- **Position changed** — the qualifying / race per-lap callout that fires when your effective position changes (improvement, worsening, or first-fix), plus the qualifying-only pole call and hold-position status. Disabling this silences only the per-change announcement; the every-3-laps race-status callout below stays independent.

Under **Qualifying**, one callout is toggleable, enabled by default (see [Qualifying Lap Invalidation](#qualifying-lap-invalidation) above for the full behavior):

- **Lap invalidated** — the *"This lap will be invalidated."* announcement (plus the laps-remaining tail) the engineer plays when you pick up an incident on a counted qualifying lap. Disabling this doesn't change how iRacing scores the lap — it only silences the announcement.

Under **Race**, three callouts are toggleable, all enabled by default:

- **Race start** — the greeting + grid-position + conditions brief the engineer reads ~3 s after the session changes to a race ("Time to race, Niklas. Qualifying put us to P seven. …"). Replaces the session-start callout in race sessions, so there's no double-greeting.
- **Position status (every 3 laps)** — the periodic *"We're currently pee five."* status (or *"We're still leading the race. Keep it up."* when you're P1) the engineer reads every 3 laps while your effective position holds. Race sessions only.
- **Final result** — the *"Niklas, we won!"* / *"second place"* / *"podium"* / *"the race is over. The final result for us is pee seven."* line that fires once when you cross the line under the checkered. Race sessions only.

Under **Overtakes**, two callouts are toggleable, both enabled by default:

- **Gained position** — the *"Nice pass. That puts us to pee five."* line on a sustained mid-race gain, including the dedicated *"Nice pass! We're now leading race."* variant when the pass takes you to P1.
- **Lost position** — the *"Come on, &lt;name&gt;. Don't give up positions like that. We're now in pee five."* line on a sustained mid-race loss.

Each direction is independent — drivers who want the congratulations but not the chastisement (or vice versa) get per-direction control.

Under **Gaps**, two callouts are toggleable, both enabled by default (see [Gap callouts](#gap-callouts-car-ahead--car-behind) above for the full behavior):

- **Gap trend (gaining/losing)** (`calloutEnabledGapTrend`) — the closing-in projections and breakaway announcements against the class-standings neighbors.
- **Gap under threshold** (`calloutEnabledGapThreshold`) — the once-per-episode alert when a gap first drops under the configurable threshold.
- **Gap alert threshold (s)** (`gapAlertThresholdSeconds`, 0.5–3, default 1.0) — the crossing point for the threshold alert. Read live.
- **Gap callout cooldown (s)** (`gapCalloutCooldownSeconds`, 1–360, default 30) — minimum quiet time between any two gap callouts. Read live.
- **Gap change to re-announce (s)** (`gapCalloutMinChangeSeconds`, 0–10, default 1.5) — a new call about the same car requires the gap to have moved at least this much in the announced direction, measured from its best/worst point since the previous call. 0 disables. Read live.

Under **Pit Box**, one callout is toggleable, enabled by default:

- **Count-in to pit box** — the *"five… four… three… two… one… pit now"* distance countdown to your pit box as you drive down pit road. Disabling this silences the whole count-in.

Under **Pit Speeding**, one callout is toggleable, enabled by default:

- **Pit road speeding** — the repeating tick that sounds while you're over the pit lane speed limit (see [Pit road speeding](#pit-road-speeding) above). It plays at your Radar volume.

Under **Pit Limiter**, four callouts are toggleable, all enabled by default. They only ever fire on a car that has a pit limiter (see [Pit limiter reminders](#pit-limiter-reminders) above):

- **Limiter off on pit road** — you entered the pits without engaging the limiter.
- **Limiter dropped** — the limiter came off again while you are still on pit road.
- **Limiter on out on track** — you left the pits with the limiter still engaged.
- **Speeding (limiter car)** — the spoken line that follows the tick when you are over the limit.

Under **No Pit Limiter**, two callouts are toggleable, both enabled by default. These are the mirror group, and only ever fire on a car with no pit limiter:

- **Speeding (no limiter)** — the spoken line that follows the tick, worded for a car that has to lift rather than press a button.
- **Pit entry speed reminder** — the pit lane speed limit, spoken as you enter.

Under **Fuel**, each laps-of-fuel-left count has its own checkbox (see [Laps of fuel left](#laps-of-fuel-left) above for the full behavior). **5, 3, 2, 1, Box this lap, and Enough fuel to finish are enabled by default**; 10–6 and 4 ship off so a fresh install hears a short, escalating sequence rather than a count every lap:

- **10 … 1 laps of fuel left** — the per-count mid-lap estimation callouts.
- **Box this lap** — the *"Box this lap for fuel."* call when the tank won't cover another full lap.
- **Enough fuel to finish** (`calloutEnabledFuelLapsLeftRaceCovered`) — the one-time *"We have enough fuel to finish the race. No need to box for fuel."* confirmation, spoken once the race is inside its last 10 laps and the tank covers what's left of it with a lap to spare.
- **Fuel margin (laps)** (`fuelCalloutMarginLaps`, 0–3 in 0.1 steps, default 0.3) — the safety margin subtracted from the estimate before it is spoken. Higher values make the engineer call you in earlier. Read live, so a change takes effect on the next lap's announcement.

Under **Corner Names**, two callouts are toggleable, both enabled by default (see [Corner names (practice & test)](#corner-names-practice--test) above for the full behavior):

- **Corner names (practice/test)** (`calloutEnabledCornerNames`) — the per-corner name announcement in practice and test sessions. Disabling silences the whole family. The Pit Crew action's [**Corner Names** mode](#corner-names) flips this same setting from a deck key.
- **Toggle on/off acknowledgment** (`calloutEnabledToggleCornerNames`) — the spoken confirmation when the Corner Names key is pressed. Disabling keeps the toggle silent (the status bar still updates).
- **Corner call lead (seconds)** (`cornerCalloutLeadSeconds`, 0–5 in 0.5 steps, default 1) — how far before the corner the name is spoken, scaled by your speed. Read live, so a change takes effect on the next corner.

Under **Spotter**, two callouts are toggleable, both enabled by default (see [Spotter (side-awareness calls)](#spotter-side-awareness-calls) above for the full behavior):

- **Announce cars around you** (`calloutEnabledSpotterCars`) — every transition call (car / two cars / one car / three wide / clear / combined). Disabling silences the spoken calls while leaving the focus gate and "still there" reminder logic intact.
- **Repeat reminder while alongside** (`calloutEnabledSpotterStillThere`) — the "Still there." reminder loop. Disabling stops the loop without affecting the transition calls.
- **Reminder interval (s)** (`spotterStillThereSeconds`, 1–10, default 3) — how often the "still there" reminder repeats while a car is alongside. Read live.

## Notes

- "AI Spotter Controls" is a separate action that wraps iRacing's own built-in AI Spotter voice. It uses iRacing SDK commands and a different audio source. Pit Crew's Radar (non-vocal proximity tick) and the Race Engineer's spotter side-awareness calls (iRaceDeck's own voice family) are both iRaceDeck-owned and do not overlap with — or control — iRacing's built-in spotter voice.
