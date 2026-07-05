---
title: Pit Crew
description: Directional proximity radar driven by the iRaceDeck audio framework.
sidebar:
  badge:
    text: "2 modes"
    variant: tip
---

Pit Crew bundles iRaceDeck's pit-side audio into one Stream Deck action. It exposes **Race Engineer Toggle** (the default — flips the engineer voice on/off) and **Radar** (directional proximity ticks when a car pulls alongside). The Race Engineer voice also speaks **Spotter** side-awareness calls ("car left", "three wide", "clear") — these are a voice callout family, not a separate mode (see [Spotter (side-awareness calls)](#spotter-side-awareness-calls) below).

Radar volume (Up/Down stepping) now lives in the [Audio Controls](/docs/actions/audio-voice/audio-controls/) action under the **Radar** mode, alongside the new **Race Engineer** volume buttons. Existing Pit Crew buttons configured for Radar Volume keep working, but new buttons set up volume control from Audio Controls.

Both the Race Engineer and Radar gates ship **off by default** so a fresh install stays quiet until you opt in. The first press of each toggle is what enables it; the on/off state is plugin-wide, so two Pit Crew buttons (e.g. one on a Stream Deck, one on a Mirabox) always agree.

## Modes

Select the mode from the **Mode** dropdown in the Property Inspector.

### Race Engineer Toggle

The default mode. Pressing the button flips `raceEngineerEnabled` in plugin-global settings (off by default). When off, both the engineer voice (Voice bus — messages, acknowledgments, toggle confirmations) and the pit ambience (Background bus — pit ambient loop and walkie-talkie SFX) are silenced synchronously, so any in-flight clip cuts off on the same key press. Radar ticks are unaffected — they have their own toggle. Re-enabling restores Voice to the configured Race Engineer Volume and Background to the configured Background Volume.

The engineer plays a short voice acknowledgment on every press — *"Okay, going silent."* when you disable it and *"Roger, resuming communication."* when you re-enable. The disable line plays through after the gate flips off (every other Voice clip silences immediately so it's the only thing you hear), then Voice mutes once the line finishes. Disable from **Race Engineer Callouts → Race Engineer Toggle** in the Property Inspector to keep the toggle silent.

When iRacing telemetry first starts flowing — typically a few seconds after you launch iRacing with Race Engineer already enabled — the engineer fires a short *"<name>, radio check. Standing by."* line so you have audible confirmation that the plugin is talking to iRacing. This is a separate opt-in (**Race Engineer Callouts → Telemetry Connect**) from the toggle acknowledgment, so you can keep one and silence the other. The line re-fires on a real reconnect (iRacing closed and reopened, or a transient SDK drop) but not on repeated telemetry ticks within the same connected session.

#### Details

- **Dial:** Not supported
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

### Radar

Toggles the directional proximity tick loop on/off. Pressing the button flips `radarEnabled` in plugin-global settings (off by default) and synchronously stops or starts the tick loop on `AudioChannel.Radar` (so a tick can't fire after the user already muted it). The status bar flips green ↔ red.

#### Details

- **Dial:** Not supported
- **Default binding:** None — button-driven feature, no keyboard binding
- **Telemetry-aware icon:** Yes — the status bar reflects the current global flag

## Global Audio Settings (shared across every Pit Crew button)

The Pit Crew accordion in the Property Inspector exposes these plugin-global settings alongside the Mode selector (not under the generic Global Settings section):

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
- **White** — final-lap alert.
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
- **Checkered** — session-aware: practice, qualifying, and race finishes get distinct lines.
- **Meatball** — the only flag callout marked **urgent + preempt**: it cancels in-flight engineer chatter mid-message, since failing to pit on a meatball costs a black-flag penalty. All non-meatball flag callouts share a `flag` family so a newer flag preempts an older one (no "yellow's clear" + "green flag" double-talk on race restart).

Pit-service confirmations (fuel on/off, every tire-set selection, dry/wet compound switch, windshield-tearoff on/off, fast-repair on/off) continue to fire on the relevant Tire Service / Pit Service action presses.

The engineer also calls out every iRacing-reported pit-service status transition during the stop itself — "crew working", "all done", positioning corrections ("too far left, line it up", etc.), and "crew can't fix that this stop" — so you can keep your eyes on the windscreen and react by ear.

## Start Lights

On a **standing start** the Race Engineer walks you through the gantry sequence so you can keep your eyes on the lights and your hands on the wheel. The moment the gantry shows its ready state the engineer says *"Lights. Get ready to go."*, and *"Go, go, go!"* the instant the lights drop and the race is live. Both calls are **critical and interrupt** any chatter in progress so nothing buries them at the most time-sensitive moment. (Nothing is spoken when the lights go solid red — by then the start is moments away and a callout would land too late to act on.)

During the pre-start countdown the engineer also speaks the numeric marks — *"Ninety seconds to race start."*, *"Sixty seconds to race start."*, *"Thirty seconds to race start."*, *"Ten seconds to race start."* — as the clock crosses each threshold. The countdown is **standing-start only** and announces only the marks that genuinely fall inside the live countdown window, so a compressed procedure (a short pre-start, an AI race) that starts below a mark simply skips the higher numbers rather than blurting a stale burst.

On a **rolling start** there's no light gantry and no numeric countdown — the lead-in comes from the race-progression flags instead: **One pace lap to go**, spoken once when one pace lap remains (the engineer assumes at most two pace laps, so it lands as the pace car begins the final pace lap), then **Green held** as the field bunches up, followed by the green flag.

Two opt-ins live under **Race Engineer Callouts → Start Lights** in the Property Inspector, both on by default:

- **Start lights** — the two gantry lines (get ready / go).
- **Start countdown** — the four numeric marks (ninety / sixty / thirty / ten).

## Rolling Start

On a **rolling start** the Race Engineer calls out once the moment the pace car starts moving and the field begins to roll into the formation lap — *"Pace car's rolling. Time to go, get moving and follow the car ahead."* and four more variants (picked at random) — so you know to get going and form up behind the car ahead. It fires only on rolling starts (a standing start gets the light gantry and numeric countdown above instead) and is distinct from the **One pace lap to go** call, which fires near the *end* of the formation lap as the field bunches up for the green.

One opt-in lives under **Race Engineer Callouts → Rolling Start** in the Property Inspector, on by default:

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

## Pit Service Status

Once the car is in the box, iRacing's status display tells you whether the crew is working, whether you're parked correctly, and whether the queued damage repair is actually feasible. The Race Engineer reads each of those state transitions out loud so you don't have to glance at the status box mid-stop:

- **In progress** — the crew is working on the car ("Crew working.").
- **Complete** — service finished, ready to leave the box ("All done, ready to roll.").
- **Too far left / right / forward / back** — positioning correction; line the car up so the crew can reach the wheels.
- **Bad angle** — the car is parked at an angle the crew can't reach properly.
- **Can't fix that** — iRacing has decided the queued damage repair won't actually be performed this stop. This is the only iRacing-exposed signal that fast-repair / damage repair will fail, and it has no other audio surface.

The eight callouts share a single family so a positioning correction (e.g. *"too far left"* → *"too far right"* while you wiggle into the box) cleanly preempts the previous one without queueing. Closing transitions back to the idle state are silent.

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

This is a **heuristic on the setup name only** — it never reads the setup's actual contents and never changes anything, so it only ever asks you to verify. Matching is done by two **case-insensitive regular expressions** you can edit under **Setup Warning Patterns** — one applied during qualifying (default flags a race-looking name), one during a race (default flags a qualifying-looking name). By default a word is matched when it's bounded by the start or end of the name, a space, a period, a hyphen, or an underscore, so `qualifying.sto`, `Q.spa`, `quali-fast`, and `VRS_quali_v2` all match while `race.sto` and `baseline` don't. Each pattern has a **Reset to default** button, and if you enter a pattern that isn't valid regex the Property Inspector shows a warning banner and the callout is simply skipped until you fix it.

Toggle the whole feature from **Race Engineer Callouts → Setup Warning**. It fires once at session entry (a mid-session setup reload doesn't re-trigger it), and practice sessions never warn.

## Lap Time (Best Lap)

A couple of seconds after you cross the start/finish line, the Race Engineer announces your lap time if you just set a new personal best — *"That was your best lap yet. One minute, twenty-three point four seconds."* The first valid lap of a session uses a different intro since there's no prior best to beat — *"That lap was one minute, twenty-three point four seconds."*

Sub-1-minute laps skip the minute clip — *"That was your best lap yet. Thirty-four point eight seconds."* The lap time is announced to one decimal place (rounded to the nearest tenth). Lap times of 11 minutes or longer stay silent — the engineer never speaks a partial readout, and the minute-clip range stops at 10 for now. The minute coverage will expand in follow-up releases.

On the final lap of a race the best-lap callout is suppressed — the race-end result takes the floor instead.

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

In multi-class series the engineer reads your class position, not the overall — winning your class always plays the *"we won!"* line even if you crossed the line behind faster cars from another class. Disabling this in the Property Inspector silences only the final-result line; the periodic status callout above remains independent.

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

In multi-class series the engineer reads your class position, not the overall — including the leader line: taking your **class** lead plays *"Nice pass! We're now leading our class. Let's keep it that way!"* (the overall-leader wording is reserved for single-class races). The gain and loss callouts have independent opt-outs in the Property Inspector — disable one without affecting the other.

## Pit-box count-in

As you drive down pit road toward your box, the Race Engineer counts the remaining distance down so you know exactly when to stop without overshooting the stall: *"Five… four… three… two… one… pit now."* The marks are spoken by distance to the box — five at 120 m, four at 100 m, three at 80 m, two at 60 m, one at 40 m, and "pit now" at 20 m remaining — so the count tracks your approach regardless of pit-lane speed.

The box location comes straight from iRacing (`DriverInfo.DriverPitTrkPct`), so the count-in works on your very first stop of a session — no need to have visited the box before. Each mark is spoken once per pit-road visit and the count resets when you leave pit road, so a second stop counts down again. If you join pit road already within range, only the marks still ahead of you are spoken, and once you've passed the box the count stops. The six marks share a `pit-box` family, so a quick approach that crosses two marks in close succession cleanly preempts the in-flight clip.

The count-in fires whenever you're on pit road approaching your box, so it isn't tied to having requested pit service — a drive-through will count down too.

## Spotter (side-awareness calls)

The Race Engineer voices spoken side-awareness as cars come and go alongside you — "Car left.", "Two cars right.", "Three wide.", a de-escalation "One car left.", combined swaps like "Clear right. Car left.", and a final "Clear." — plus a short repeating "Still there." reminder for as long as a car stays beside you. This is a **Race Engineer voice callout family** (like flags, position, or lap time), not a separate Stream Deck mode or button: it's gated by the Race Engineer master (the **Race Engineer Toggle** button) plus two Property Inspector opt-ins, both on by default. With the engineer off, the spotter is silent.

The wording adapts to the track. On a **road course** (no track rotation) the calls use left/right. On an **oval** the engineer uses inside/outside, derived from `WeekendInfo.TrackDirection` — a left-going oval makes your left "inside", a right-going oval reverses it. You don't configure this; it follows the loaded track automatically.

While a car is alongside, the spotter holds an exclusive focus on the engineer's Voice bus, so routine chatter (lap times, position updates, pit recaps) is held back to keep the channel clear — but safety-critical flag callouts still break through. The moment the car clears, the floor releases and any held chatter resumes.

"Clear" is buffered so it doesn't stutter when a car sits right on the detection boundary. Instead of calling clear the instant the proximity signal blinks off, the spotter waits until the car has actually pulled away — the gap to the nearest car (computed from each car's lap-distance and the track length) has to grow by about half a metre before "Clear" plays. If a car somehow separates purely sideways so that gap never grows, a short timeout clears anyway.

The spotter reads the **same proximity signal as the Radar mode** but is otherwise independent: Radar is the non-vocal proximity tick on the Alerts bus, the spotter is a spoken voice call on the Voice bus. Run either, both, or neither — with both enabled you'll hear a tick *and* a spoken call when a car pulls alongside.

Two opt-ins live under **Race Engineer Callouts → Spotter** in the Property Inspector, both on by default:

- **Announce cars around you** (`calloutEnabledSpotterCars`) — every transition call (car / two cars / one car / three wide / clear / combined). Turning this off silences the spoken calls while leaving the focus gate and the "still there" reminder logic intact.
- **Repeat reminder while alongside** (`calloutEnabledSpotterStillThere`) — the "Still there." / "Hold your line." loop that repeats for as long as a car stays beside you.
- **Reminder interval (s)** (`spotterStillThereSeconds`, 1–10, default 3) — how often that reminder repeats. Read live, so a change takes effect on the next reminder without a restart.

## Race Engineer Callouts (per-subject opt-in/out)

Some sessions throw the same flag over and over — debris that goes on/off every lap, rolling local yellows in a busy multi-class race. The **Race Engineer Callouts** accordion in the Property Inspector lets you switch off any individual callout while keeping the rest. The choice is plugin-global (every Pit Crew button agrees) and takes effect **live**: unchecking a callout stops new ones of that subject on the next event, but does **not** cut a callout already playing.

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

Under **Pit Service**, three callouts are toggleable independently:

- **Pit entry readback** — the "Don't forget your limiter. We're taking fuel, …" recap that fires as you roll onto pit road (and refires on any toggle while you're still on pit road).
- **Pit exit readback** — the "To confirm: …" recap that plays after a short delay once you've left pit road.
- **Pit service requests** — every per-toggle confirmation (fuel on/off, tire-set selection, compound switch, windshield-tearoff on/off, fast-repair on/off). Switching this off silences the engineer on every Stream Deck pit-service press while leaving the readbacks intact.

Disabling any one of the three does not affect the others.

Under **Pit Service Status**, eight callouts are toggleable independently — one per non-idle `PlayerCarPitSvStatus` value, all enabled by default:

- **In progress**, **Complete**
- **Too far left**, **Too far right**, **Too far forward**, **Too far back**
- **Bad angle**, **Can't fix that**

Disabling a status only suppresses future events of that subject; an in-flight callout completes naturally. Disabling all eight silences the in-stop status family while leaving readbacks, flag callouts, and damage heads-ups intact.

Under **Damage**, one callout is toggleable, enabled by default:

- **Repair needed** — the spoken heads-up the engineer plays the first time iRacing reports damage that requires repair (rising edge of `EngineWarnings & (MandRepNeeded | OptRepNeeded)`). Disabling this only silences the live damage callout; the pit-service readback's damage-aware fast-repair line is unaffected.

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

Under **Race**, three callouts are toggleable, all enabled by default:

- **Race start** — the greeting + grid-position + conditions brief the engineer reads ~3 s after the session changes to a race ("Time to race, Niklas. Qualifying put us to P seven. …"). Replaces the session-start callout in race sessions, so there's no double-greeting.
- **Position status (every 3 laps)** — the periodic *"We're currently pee five."* status (or *"We're still leading the race. Keep it up."* when you're P1) the engineer reads every 3 laps while your effective position holds. Race sessions only.
- **Final result** — the *"Niklas, we won!"* / *"second place"* / *"podium"* / *"the race is over. The final result for us is pee seven."* line that fires once when you cross the line under the checkered. Race sessions only.

Under **Overtakes**, two callouts are toggleable, both enabled by default:

- **Gained position** — the *"Nice pass. That puts us to pee five."* line on a sustained mid-race gain, including the dedicated *"Nice pass! We're now leading race."* variant when the pass takes you to P1.
- **Lost position** — the *"Come on, &lt;name&gt;. Don't give up positions like that. We're now in pee five."* line on a sustained mid-race loss.

Each direction is independent — drivers who want the congratulations but not the chastisement (or vice versa) get per-direction control.

Under **Pit Box**, one callout is toggleable, enabled by default:

- **Count-in to pit box** — the *"five… four… three… two… one… pit now"* distance countdown to your pit box as you drive down pit road. Disabling this silences the whole count-in.

Under **Spotter**, two callouts are toggleable, both enabled by default (see [Spotter (side-awareness calls)](#spotter-side-awareness-calls) above for the full behavior):

- **Announce cars around you** (`calloutEnabledSpotterCars`) — every transition call (car / two cars / one car / three wide / clear / combined). Disabling silences the spoken calls while leaving the focus gate and "still there" reminder logic intact.
- **Repeat reminder while alongside** (`calloutEnabledSpotterStillThere`) — the "Still there." reminder loop. Disabling stops the loop without affecting the transition calls.
- **Reminder interval (s)** (`spotterStillThereSeconds`, 1–10, default 3) — how often the "still there" reminder repeats while a car is alongside. Read live.

## Notes

- "AI Spotter Controls" is a separate action that wraps iRacing's own built-in AI Spotter voice. It uses iRacing SDK commands and a different audio source. Pit Crew's Radar (non-vocal proximity tick) and the Race Engineer's spotter side-awareness calls (iRaceDeck's own voice family) are both iRaceDeck-owned and do not overlap with — or control — iRacing's built-in spotter voice.
