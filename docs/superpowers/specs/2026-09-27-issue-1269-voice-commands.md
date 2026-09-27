# Talk to the Race Engineer by voice

> **Issue:** [#1269](https://github.com/niklam/iracedeck/issues/1269) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

This spec is larger than usual on purpose. #1269 was a research spike, and its desk research (engine survey, repo seams, external tools) would otherwise be lost once the conversation that produced it ends. So besides the decision it carries the plan: the phases, the sized engineering pieces, and which of them become their own issues. The plan part ages like any plan and may be edited freely until the work ships; the decisions are the durable part.

## The decision

Decided by the maintainer on 2026-09-27:

- **Go, in stages, with a measured gate first.** The spike's research is desk research: no number in it was measured on a rig. Phase 0 measures latency, accuracy and frame-time cost on the maintainer's rig with the chosen engine, and its results are the go/no-go comment the issue's exit criterion asks for. Phase 1 is useful even on a no-go, so it is not held behind the gate.
- **Voice can act, not only ask.** "Fuel on" does what pressing the fuel-on key does. Commands express a **desired state**, never a toggle: a command whose state already holds does nothing and the engineer says so.
- **One command registry.** Voice, SimHub (#1164) and any external tool call the same deck-core registry of named commands that #1164 decided. There is no second, voice-only dispatch path.
- **Answers are voice-pack lines.** There is no text-to-speech. Every answer, confirmation, refusal and "say again" is a scripted line with clips in every pack.
- **Recognition engine: sherpa-onnx in keyword-spotting mode** over a fixed, code-owned phrase list, fully offline. **Vosk in grammar mode** is the documented fallback if sherpa-onnx cannot be packaged for the three deck hosts on Windows.
- **Trigger: a deck key, held to talk.** A new **Talk to Engineer** mode in Pit Crew. Mirabox knobs, which cannot be held, get press to start with automatic end of speech. A wheel button, iRacing's own radio push-to-talk, and the SimHub bridge are deferred, with what would settle each recorded below.
- **Capture lives in `@iracedeck/audio-native`**, opened on press and closed after a short hang time on release, following the #849 rule that an idle stream must not exist.
- **The model and the recogniser runtime are downloaded** as a managed asset beside the voice packs, never shipped in a plugin.

## What the driver gets

The driver holds the **Talk to Engineer** key, speaks, and releases. The engineer answers on the radio like any other Race Engineer line:

> Driver: "How much fuel?" — Engineer: "Fuel is at thirty two point four liters."
>
> Driver: "Gap behind?" — Engineer: "Gap behind is one point five seconds."
>
> Driver: "Fuel on." — Engineer: "Got it. Fuel's on for the stop." (the existing pit-service confirmation)
>
> Driver: "Fuel on." (already on) — Engineer: "Fuel's already on."
>
> Driver: something the recogniser does not match — Engineer: "Say again?"

The phrases are a fixed list the driver can read in the settings window and on the website. Natural surroundings are tolerated, because a keyword spotter finds "how much fuel" inside "uh, how much fuel have we got".

Crew Chief's voice recognition is what the Discord requester could not get working, and its support history names the causes: a separate speech runtime and language pack to install by hand, per-microphone training, and the wrong recording device. This design avoids all three: the model installs itself, nothing is trained, the microphone is picked in the settings window, and a **Test microphone** control there shows what the recogniser heard.

## Recognition: sherpa-onnx keyword spotting

### Why keyword spotting

The feature is a closed set of short phrases, each mapping to one command. A keyword spotter is built for exactly that: it listens for a registered list of phrases and reports which one it heard, with a per-phrase threshold that trades false accepts against false rejects. It needs no free-text matching step and cannot hallucinate a phrase outside the list, which is the failure an open-vocabulary engine has on short clips.

sherpa-onnx (k2-fsa, Apache-2.0) was chosen over the other on-device options because it is the only one surveyed with a documented latency figure for this shape (160 ms for chunk-8 keyword-spotting models, 320 ms for chunk-16), its keyword models are a few MB, it runs on the CPU through onnxruntime with no GPU, it has a maintained native Node addon with Windows x64 binaries, and it needs no account, key or network. The same runtime also offers streaming ASR and a voice-activity detector (Silero VAD), which the later phases use: ASR for phrases with numbers, the VAD for end of speech on a knob.

### Model and phrases

- **Model.** The English zipformer keyword-spotting model from the sherpa-onnx model zoo (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, int8 if accuracy holds). Phase 0 confirms its licence permits redistribution: the model code is Apache-2.0, but it is trained on GigaSpeech, and the dataset's terms have to be read before we republish the weights. A second model is chosen in Phase 0 if this one fails that check or the accuracy bar.
- **The phrase list is code-owned.** A phrase table in the plugin maps each phrase (and its aliases) to a command id and parameters. The keyword file the engine reads is generated from it at build time with the model's tokenizer, committed, and guarded by a freshness test, the repo's usual pattern for generated artifacts. Phrases change with the plugin version, not with the model, so the keyword file ships in the plugin (it is a few KB) and the model does not.
- **Per-phrase tuning.** Each keyword line carries its own boost and trigger threshold. Action phrases get stricter thresholds than readout phrases, because a misheard readout costs a "say again" and a misheard action changes the pit stop. The shape of a line, illustratively (the tokens come from the model's BPE vocabulary):

```text
▁HOW ▁MUCH ▁FUEL :1.5 #0.25 @how-much-fuel
▁FUEL ▁ON :1.0 #0.40 @fuel-on
```

- **Phrase-set rules, enforced by a test on the table.** No phrase's token sequence may appear inside another's ("fuel" alone would fire inside "fuel on"), and each opposing pair ("fuel on" / "fuel off") also has a lexically distinct alias ("add fuel" / "no fuel"), because "on" and "off" are acoustically close. Phase 0 measures the confusion rate of every opposing pair specifically.

### From audio to a result

- **Streaming decode while the key is held.** Audio chunks are fed to the spotter as they arrive, so at release only the tail remains; the tail is padded with a short stretch of silence, which the model needs as trailing context, and the result is read.
- **A worker thread.** The spotter runs in a Node `worker_thread`. A decode call is synchronous native code, and the plugin's main loop also drives the 10 ms telemetry poll and the audio scheduling, so it must never block there. The main thread receives PCM from the capture callback and posts it to the worker; at 16 kHz mono float32 that is 64 KB/s.
- **Outcomes.** Exactly one detected phrase (or several detections of the same intent) is a match. No detection is "not understood". Two detections with different intents is "not understood" too, never a guess. A press shorter than about 250 ms with no detection is an accidental tap and gets no answer at all.
- **English only.** The voice packs speak English and the model is English. Other languages are out of scope; non-native English speakers are in scope and are part of the Phase 0 corpus.
- **Behind an interface.** The recogniser is a `SpeechRecognizer` interface (load, start, feed, finish → result) with sherpa-onnx as its one implementation. The Vosk fallback, or the ASR mode later, replaces the implementation and nothing else.

### The fallback: Vosk in grammar mode

If Phase 0 finds the sherpa-onnx addon cannot be loaded from a downloaded folder in one of the three deck hosts, or its accuracy misses the bar where Vosk's does not, the implementation switches to Vosk (Apache-2.0, official Node bindings with Windows prebuilds, a ~50 MB small English model) with a JSON grammar of the same phrases plus `[unk]`. What changes: the model asset, the keyword file generator becomes a grammar generator, and thresholds become a floor on Vosk's per-word confidence. The phrase table, capture, commands and answers do not change.

### Engines not chosen

Figures are from the spike's desk research and were not measured.

| Engine | Why not |
| --- | --- |
| Vosk (grammar mode) | Kept as the fallback. Mature and grammar-constrained, but a larger model, no documented latency, and a coarser per-phrase tuning knob than keyword thresholds. |
| whisper.cpp (tiny/base) | Open vocabulary the feature does not need, a documented hallucination hot spot on 1–2 s clips, 75–142 MB models, and only community Node wrappers. The upgrade path for free phrasing is sherpa-onnx's own ASR mode instead. |
| faster-whisper / CTranslate2 | A Python runtime to package; the Node port's Windows support is unconfirmed. |
| Windows.Media.SpeechRecognition | No Node path (a C++/WinRT addon from scratch), and it depends on an OS offline speech pack and language settings the user installs: Crew Chief's support burden. |
| SAPI 5 / System.Speech | Windows Speech Recognition was retired on Windows 11 and the engine's future there is unverified; reaching it from Node means a PowerShell or .NET host process; accuracy trails neural engines. |
| Picovoice Rhino | The closest semantic fit (speech to intent), but its free tier ended on 2026-06-30, every install validates an AccessKey online, and commercial pricing starts around $6,000. |
| Cloud STT (Azure, Google, Deepgram, AssemblyAI, OpenAI) | A key shipped in a free plugin can be neither protected nor cost-controlled, per-user accounts are a non-starter, the Race Engineer needs no network today, and the driver's voice would leave the PC. |
| Moonshine, Parakeet | No Node binding; Parakeet is ~600 MB; both are open-vocabulary. |

## Distribution: a managed speech asset

Neither the model nor the recogniser runtime ships in a plugin. Mirabox caps a plugin distributable at 20 MB, the reason the voices moved out, and the Windows runtime (onnxruntime plus the sherpa-onnx library and addon) is on the order of that cap by itself; Phase 0 measures it. Everything in `bin/` also ships three times, once per plugin.

- **A sibling asset kind, not a voice pack.** The voice-pack installer is reused where it is generic — `downloadVoicePack`'s timed, capped, hashing download, the catalog client, provenance and status reporting — and not where it is voice-specific. The archive extractor accepts only `.mp3` and `.json` (`voice-pack-archive.ts`, `ACCEPTED_EXTENSIONS`) and the download ceiling is 128 MiB (`VOICE_PACK_DOWNLOAD_CEILING_BYTES`). A speech asset gets its own root (`%LOCALAPPDATA%\iRaceDeck\Speech\<asset>\`), its own catalog entries, its own extension allow-list (`.onnx`, `.txt`, `.node`, `.dll`, `.json`, licence files) and its own ceiling.
- **Published like voice packs.** A committed catalog entry pins each archive's SHA-256; the tag workflow attaches the archive to its own release, and a mismatch fails the job before anything ships (the #1116 rules). The runtime archive is assembled from the pinned upstream Windows x64 package, with the upstream licences included.
- **The runtime is code, not data.** A voice pack's worst case is a wrong clip; a speech runtime's is arbitrary code in the plugin process. The trust is the same pinned hash, but the verify step for this asset kind is reviewed at `max`, since its failure mode is accepting a file that should have been refused.
- **Installed on demand, then kept current.** Most drivers will never use voice, so nothing downloads at startup until a **Talk to Engineer** key appears or the driver installs it from the settings window. Once installed it updates at startup like a catalog-installed pack. The folder is shared by the three ecosystems, so the #1034 install lock applies.
- **Loading from outside `bin/`.** The addon is required by absolute path from the asset folder. Its DLLs must resolve from that folder rather than from the host's executable folder; Phase 0 proves this in all three deck hosts before anything else is built.

## Capture

**Decision: capture is a new capability of `@iracedeck/audio-native`, not the recogniser's.** sherpa-onnx's Node addon has no capture of its own (its examples use a separate PortAudio binding), and using any engine's own capture would give up three things this design needs: a device picker, control over when the device exists (the #849 rule), and one native addon that is already built and shipped in all three plugins.

- **What exists.** miniaudio v0.11.25 is compiled with capture support already (`MINIAUDIO_IMPLEMENTATION`, no `MA_NO_*` defines). Enumeration passes `NULL, NULL` for the capture list in `GetAudioDevices`, `SetAudioDevice` and `SetAudioDeviceById`, and the same `ma_context_get_devices` call returns capture devices once they are asked for.
- **The device.** A separate `ma_device` of type capture on the shared `g_audioContext`, not through the playback engine. It asks for `ma_format_f32`, one channel, 16,000 Hz, and miniaudio's converter resamples from the endpoint's native format; no resampler is written. Shared mode only, so iRacing voice chat and Discord keep reading the same microphone; exclusive mode would break them.
- **PCM to JS.** The data callback copies each buffer into a preallocated ring and posts it through a `Napi::ThreadSafeFunction` with `NonBlockingCall`, the pattern `maEndCallback` already uses; like the reroute TSFN, it is `Unref`'d and has an env cleanup hook. The audio thread never blocks or allocates without bound.
- **Lifecycle, the #849 rule.** The #849 fix found that Windows holds the sleep-blocking power request for a WASAPI stream that is merely initialised, so the playback engine is torn down after 5 s of silence rather than stopped. Capture follows the same rule: `ma_device_init` on key down, `ma_device_uninit` after a short hang time following release (starting at 3 s, tuned in Phase 2), never a bare `ma_device_stop`. The hang time also keeps the device warm for a quick second question, so its first syllable is not lost to a WASAPI initialisation. Whether an open capture stream blocks sleep is unverified; it is assumed to, and `powercfg /requests` checks both that it does while held and that nothing remains after the hang time.
- **First syllable.** Opening a device on press can drop the first tens of milliseconds. Phase 2 times key down to first buffer on real hardware; if it is long enough to clip a word, the key's listening cue (below) is delayed until the first buffer arrives, so the driver learns to speak after the cue.
- **Failure modes the driver can see.** Windows' microphone privacy switch for desktop apps, an unplugged or missing device, and a device that delivers only silence are each detected and shown: on the key as a "mic" state, and in the settings window as a sentence saying what to do.
- **Input device picker.** **Microphone**, beside **Output Device** in the Race Engineer pane, using the generic `<ird-audio-device-select>` with a new run-scoped `_audioInputDeviceList` (published the way `pushAudioDevicesIfChanged` publishes `_audioDeviceList`) and a persisted `audioInputDevice` id, default **System Default**. `audioInputDevice` is declared in `GlobalSettingsSchema` properly, which makes it a published contract and puts that change in the `xhigh` review row. (`audioOutputDevice` is read by the plugins but not declared there today; whether it joins in the same change is an open question.)
- **Mixing with playback.** The engineer's answers still go through the playback engine as before; nothing about capture touches it.

## Trigger

### A deck key held to talk

**Talk to Engineer** is a new mode of **Pit Crew**, whose modes today are Race Engineer, Radar, Radar Volume and Corner Names. It is a Race Engineer interaction rather than a figure a key displays, which is why it does not go to Session Info the way #466's readouts did. The audio-controls **Push to Talk** mode is unrelated and stays as it is: it holds iRacing's own push-to-talk binding and talks to other drivers.

- Key down opens the microphone and plays a short listening cue; key up ends the utterance. The engineer's current line is not interrupted.
- The key shows its state: ready, listening, installing the speech model, microphone unavailable, and Race Engineer off. With the Race Engineer off the key does nothing, since no answer could be spoken, and no command runs.
- Every command runs only with the Race Engineer master on, for the same reason: an action the driver cannot hear confirmed is worse than one that did not happen.

### Dials and Mirabox knobs

Pit Crew is keypad-only today, so a dial surface for Talk to Engineer is its own later piece, and it changes the manifest's `Controllers` for Pit Crew in all three plugins.

- **Stream Deck+ dial:** press and hold, like a key; the host sends `dialDown` and `dialUp`.
- **Mirabox knob: press to start, speech end detected automatically.** A knob push is atomic: the host sends a lone `dialDown`, and the adapter synthesises the `dialUp` at once (#1013). So a press opens the microphone and the utterance ends when the VAD sees about 700 ms of silence after speech, when the knob is pressed again, or after a hard cap of 6 s. A second press with no speech detected cancels without an answer. Silero VAD comes with the sherpa-onnx runtime, so this adds a model file to the asset and no new dependency.

### Triggers deferred, and what settles each

| Trigger | What is known | What settles it |
| --- | --- | --- |
| Wheel button | iRaceDeck has no input listener outside the deck: nothing in `iracing-native`, `deck-core` or `iracing-sdk` reads RawInput, DirectInput or XInput. It needs a native listener that works unfocused (RawInput with `RIDEV_INPUTSINK`, or DirectInput background mode) and a "press the button to bind" control. Size L. | A prototype listener proven unfocused against the wheel bases and button boxes drivers own. |
| iRacing radio push-to-talk | The driver's existing wheel PTT would work with no new input code. Telemetry has `RadioTransmitCarIdx` ("the car index of the current person speaking"), read by nothing today. A solo race's session YAML lists a `@TEAM` frequency whose `CarIdx` is the player's own car, the plausible "transmits to nobody" channel. Unverified: whether the field shows the player's own transmission, whether it moves offline or in a test session with no voice server, whether a joined spotter would hear it, and how the driver tunes to `@TEAM`. Every running plugin sees the same telemetry, so it needs the single-listener rule below. | A telemetry capture holding PTT on `@TEAM`, online and offline, recording `RadioTransmitCarIdx`, `RadioTransmitRadioIdx`, `RadioTransmitFrequencyIdx` and `DriverCarIdx`. |
| SimHub | #1164's bridge. A voice trigger is a hold command, and #1164 leaves open whether SimHub plugin actions get a release event; without one, hold commands are out. Also open there: port and token discovery, which plugin receives, and the request guard (a `max` review). Size L. | #1164's split issues. |

**One microphone owner.** A deck key belongs to one plugin, so the plugin whose key was pressed opens the microphone and answers; a key trigger never needs arbitration. Every deferred trigger does: a wheel listener, radio PTT and a SimHub command are all seen by every running plugin. That is the same problem as #1164's "which of the three plugins receives a command", and the two are solved together: a machine-wide single-listener claim (a lock file under `%LOCALAPPDATA%\iRaceDeck\` or a named mutex through the native addon), taken by the first plugin to start listening and released when it exits. It is designed in the first deferred-trigger issue, not here.

### Always listening and wake words

Rejected. A driver shouts at traffic, swears at a spin and talks on voice chat; an open microphone turns every one of those into a candidate command, and a false accept of an action changes the pit stop. It would also keep a capture stream open for the whole session, which the #849 rule exists to prevent, and it is a privacy change the driver did not ask for.

## Command model

### Phrase, intent, command

```text
phrase ("add fuel") → intent (fuel-on) → command (pit-service.fuel { on: true }) → registry → handler → outcome → answer
```

- The **phrase table** maps each phrase and alias to an intent, and each intent to a command id and parameters. It is voice-only.
- The **registry** is #1164's: a deck-core module where a feature registers a named command with an id, a zod parameter schema and a handler. Nothing is exposed by default, a handler runs with no action context, and a command id and its parameters are a published contract. This work builds it, since #1164 decided the model and built nothing; #1164's SimHub transport then calls the same registry.
- Where a command and an action do the same thing, both call a shared service and neither calls the other (#1164's rule). That means extracting two services from the actions: the readout builder from Session Info, and the pit-service state setters from Fuel Service, Tire Service and Pit Quick Actions.

```typescript
type CommandOutcome =
  | { status: "done" } // the sim was asked to change; its own confirmation follows
  | { status: "spoken" } // a readout was published
  | { status: "already" } // the requested state already holds; nothing was sent
  | { status: "unavailable"; reason: "no-fast-repair" | "no-autofuel" }
  | { status: "refused"; reason: "not-connected" | "not-in-car" | "service-active" | "binding-missing" };

interface CommandDefinition<P> {
  id: string; // published contract, e.g. "pit-service.fuel"
  params: z.ZodType<P>;
  run(params: P): CommandOutcome | Promise<CommandOutcome>;
}
```

### Readout commands

`race-engineer.readout { kind, target? }` publishes `telemetryReadout.requested`, the #466 event, exactly as a Session Info press does. The value is captured when the command runs, the #466 rule. The figure-building moves out of Session Info (`readoutKindFor` takes Session Info settings; `resolveReadoutFigure` lives under `actions/session-info/`) into a shared readout builder in `iracing-actions`, which both Session Info and the command call. `sim-events-iracing` stays free of `deck-core`, so the builder does not go there. The voice path supplies the parameters a key would: the fuel-average window is Session Info's default, position is by class, and the gap target is named by the phrase.

### Action commands: desired state, checked first

Every action command reads the current state from telemetry before sending anything, and answers `already` when the state holds. This applies even to the SDK pit commands that are set-style already (`pit.fuel(0)` on a fueling request that is already on would do no harm), because the driver asked and is owed an answer that says what is true. For a toggle, a keyboard binding that flips a state, the check is what makes it safe at all: a blind press of a toggle whose state is unknown could turn off what the driver asked to turn on. A toggle whose state telemetry does not expose cannot be a voice command.

| Command | Current state from | Sends | Guards |
| --- | --- | --- | --- |
| `pit-service.fuel { on }` | `PitSvFlags.FuelFill` (`isFuelFillOn`) | on: `pit.fuel(0)`, arming the existing amount (Fuel Service's `arm`); off: `pit.clearFuel` (its `forceClearFuel`, past the dedup guard) | connected, in car, not `PitstopActive` (#831: a fuel broadcast mid-service interrupts fueling) |
| `pit-service.tires { set: "all" \| "none" }` | `PitSvFlags` LF/RF/LR/RR bits | all: `pit.allTires()`; none: `pit.clearTires()` | same |
| `pit-service.windshield { on }` | `PitSvFlags.WindshieldTearoff` | `pit.windshield()` / `pit.clearWindshield()` | same |
| `pit-service.fast-repair { on }` | `PitSvFlags.FastRepair`; `FastRepairAvailable` | `pit.fastRepair()` / `pit.clearFastRepair()` | same, plus `unavailable` with none left |
| `pit-service.autofuel { on }` (later phase) | `dpFuelAutoFillActive`; `dpFuelAutoFillEnabled` | the Fuel Service autofuel key binding, once, only when the state differs | same, plus `unavailable` on a car without autofuel and `refused: binding-missing`; iRacing must have focus, so the configured window-focus mode applies |

Pit commands only work with the driver in the car (`PitCommand`'s own note), which is the `not-in-car` refusal.

### How the engineer confirms

- **A change is confirmed by the sim, not by the command.** When a pit command changes the service flags, the translator publishes `pitService.toggled` or `tireService.changed`, and the existing toggle-confirmation contracts speak what was actually set ("Got it." plus the new state). A voice command therefore gets the same confirmation a key press gets, with no new code, and the confirmation describes the sim's state rather than what we asked for.
- **Everything else is answered by a new event.** The registry's caller can ask for a spoken outcome; voice always does. The dispatcher then publishes `command.answered { intent, outcome, reason }` for every outcome except `done` and `spoken`, and new contracts speak it: already, unavailable, refused, and not understood (`intent: null`). `intent` is a sim-agnostic catalog vocabulary (`fuel-on`, `tires-all`, …) so the contracts can pick the right "already" line. This also answers #1164's open question of how a command confirms itself without a deck, for any caller that wants it spoken.
- **The "Pit service requests" callout switch.** The toggle confirmations answer to it, and a driver may have turned it off. A voice command must never succeed silently, so with that switch off the dispatcher also publishes `command.answered` for `done`, and one contract speaks a bare acknowledgment ("Copy."). The two contracts are gated on the switch in opposite directions, so exactly one of them answers.

### No confirm-before-execute in the first set

No first-set command asks "are you sure?" first. Each one is undone by its opposite phrase before the car reaches the box, the confirmation says what was set, and the pit readback at pit entry recaps the whole service set again. A confirmation round trip costs a second recognition window and a pending-command state for every action, to protect against mistakes that are already cheap to undo.

The one command that is not cheap to undo is **clear all pit service** (`pit.clear()`): one misheard phrase silently discards fuel, tyres, windshield and fast repair choices together. It is left out of the voice set. The per-service "off" phrases cover the need, and the Pit Quick Actions key keeps it. If it is ever voiced, it comes with a confirm step, sized M.

### "Box this lap"

It has no SDK command, and cannot have one: iRacing has no "request a stop" broadcast, because a stop is the driver driving into the pit lane. So "box this lap" cannot be an action, and it is not in the phrase set, since an engineer who answers "copy" to it would imply something happened. Its useful reading, "what's set for the stop?", is a readout of the pit service already queued, and is listed below as a later readout that reuses the pit readback's clips.

## The first command set

"Exists" means the kind or contract is on `master` today; "#1267" means it lands with that issue.

| Phrase (aliases) | Intent → command | Kind | Status | Notes |
| --- | --- | --- | --- | --- |
| "how much fuel" ("fuel level") | `race-engineer.readout { kind: "fuel-now" }` | readout | new kind | #466 left Fuel → Now unspoken. `numbers-fuel` 0–120 and the unit-bearing tails are reused; only an intro clip is new. A tank above 120.9 aborts, per #836 |
| "laps of fuel" ("fuel laps") | `readout { kind: "fuel-laps" }` | readout | new kind | Session Info's Laps to Empty figure. `fuel-laps-left` covers only whole-line counts 10…0; needs a number form, `readout-laps/1…20` plus a range beyond it |
| "fuel last lap" | `readout { kind: "fuel-last-lap" }` | readout | exists | |
| "average fuel" | `readout { kind: "fuel-average" }` | readout | exists | Session Info's default window |
| "track temp" | `readout { kind: "track-temp" }` | readout | exists | |
| "air temp" | `readout { kind: "air-temp" }` | readout | exists | |
| "last lap" | `readout { kind: "last-lap", target: "self" }` | readout | #1267 | |
| "best lap" | `readout { kind: "best-lap", target: "self" }` | readout | #1267 | |
| "gap ahead" / "gap behind" | `readout { kind: "gap", target: "car-ahead" \| "car-behind" }` | readout | new kind | Reuses #1267's `target`. `gaps.ts` already has the "one point five seconds" fragment and vocabulary; mostly intros. Uses the canonical live order (`race-positions.md`) |
| "what position" ("position") | `readout { kind: "position" }` | readout | new kind | `position-readout.ts` clips reusable. An asked-for position is spoken even inside the shared position cooldown, and claims it, so an automatic line right after does not repeat it |
| "laps remaining", "time remaining" | `readout { kind: "laps-remaining" \| "time-remaining" }` | readout | new kinds | Numbers beyond 20 and a minutes form; later batch |
| "incidents" | `readout { kind: "incidents" }` | readout | new kind | `PlayerCarMyIncidentCount`; the existing `incident.points` var is one incident's points, so a count needs clips; later batch |
| "tyre wear" | `readout { kind: "tire-wear" }` | readout | new kind | Wear refreshes only in the pit stall (`tire-wear.ts`), so the answer is always "as of the last stop", with a line for no stop yet; reuses the `tire-wear` clips; later batch |
| "fuel on" ("add fuel") | `pit-service.fuel { on: true }` | action | new command | confirmation exists (`pit-crew.toggle-fuel-on`) |
| "fuel off" ("no fuel") | `pit-service.fuel { on: false }` | action | new command | confirmation exists |
| "four tyres" ("all tyres") | `pit-service.tires { set: "all" }` | action | new command | confirmation exists (`tireService.changed`, all four) |
| "no tyres" ("tyres off") | `pit-service.tires { set: "none" }` | action | new command | confirmation exists (skip tyres) |
| "tear off" ("windshield") | `pit-service.windshield { on: true }` | action | new command | confirmation exists |
| "no tear off" | `pit-service.windshield { on: false }` | action | new command | confirmation exists |
| "fast repair" | `pit-service.fast-repair { on: true }` | action | new command | confirmation exists; `unavailable` with none left |
| "no fast repair" | `pit-service.fast-repair { on: false }` | action | new command | confirmation exists |

Later candidates, each needing its own decision: fronts, rears, left or right side only (a desired set is a clear then a set, which the 300 ms tire debounce merges into one confirmation); autofuel on and off (the first keyboard-toggle command); a fuel amount by number ("fuel to thirty"), which needs number phrases and probably the ASR mode; and "what's set for the stop".

Every new readout kind extends the #466 catalog entry, a published contract (`xhigh`), and brings its contracts, clips in every pack, a scenario-harness shortcut and a regenerated pack reference. The Session Info items that show the same figures (Fuel → Now, Laps to Empty, Gaps, Position, …) gain **Speak value on press** for free once the kind exists.

## What the engineer says

All of these are scripted contracts with clips, in the Default pack and the Terse pack alike (the Terse spec's parity rule: every scenario Default speaks, Terse speaks). Ids keep the `pit-crew.` prefix.

| Contract | Fires on | Example line |
| --- | --- | --- |
| `pit-crew.command-not-understood` | `command.answered`, `intent: null` | "Say again?" (a small pool: "Didn't catch that.") |
| `pit-crew.command-already-<intent>` | `outcome: already`, one per intent | "Fuel's already on." / "Already on four tyres." / "No tear off already." |
| `pit-crew.command-unavailable-fast-repair` | `unavailable`, `no-fast-repair` | "No fast repairs left." |
| `pit-crew.command-unavailable-autofuel` | `unavailable`, `no-autofuel` | "No autofuel on this car." (with the autofuel command) |
| `pit-crew.command-refused-service` | `refused`, `service-active` | "Not while we're working on the car." |
| `pit-crew.command-refused-not-in-car` | `refused`, `not-in-car` | "Get in the car first." |
| `pit-crew.command-refused-binding` | `refused`, `binding-missing` | "That one isn't set up on the deck." (with keyboard toggles) |
| `pit-crew.command-done` | `done`, only with **Pit service requests** off | "Copy." |
| readout intros | `telemetryReadout.requested`, per new kind | "Fuel is at", "Gap ahead is", "We're P", … |

Scheduling follows the #466 readout: a weight between chatter and normal, queueable, a newer answer replacing a pending one, no family. They are gated by the Race Engineer master only; pressing the key is the opt-in. The listening cue is a short tone on the `Cue` channel #1272 adds, not a voice line, so a scriptless voice cannot silence it.

Pack authors get the new contracts through the generated pack reference (`pnpm generate:pack-reference`), `pnpm lint:pack` coverage, and a section on the website's voice-pack pages. A pack that lacks a line for a new contract simply says nothing for that outcome, which is why the not-understood and already lines ship in both first-party packs in the same change as the commands.

## External tools keep a way in

Because voice goes through the registry, anything that can reach the registry can drive the same commands and get the same spoken answers. Once #1164's local transport exists (token-authenticated loopback, the settings-window server's guard as prior art), a VoiceAttack plugin, a SimHub action, a Simulator Controller script or a tool nobody has written yet can send `race-engineer.readout { kind: "fuel-now" }` or `pit-service.fuel { on: true }` and hear the Race Engineer answer. That keeps "integrate instead of recognise" open for drivers who already run a voice tool, without tying anyone to one tool, and it is why there is one registry rather than two. Today, without any of this, a voice tool that sends keypresses can already reach every keyboard-bound iRaceDeck function, but it cannot ask for a readout or carry a parameter; the website says so.

## Plan

### Phase 0 — prove it on the rig (the go/no-go gate)

A throwaway prototype outside the shipped packages (under the gitignored `local/`), run on the maintainer's rig. Its results go on #1269 as the exit comment, and the thresholds below decide go or no-go.

1. **Record a corpus.** Every first-set phrase, ten or more takes each, through the headset microphones drivers use, recorded while driving: calm, mid-stint breathing hard, and spoken fast mid-corner. Include near-miss speech (voice-chat talk, swearing at traffic) as negatives. Ideally more than one speaker, including non-native English.
2. **Offline accuracy.** A Node script runs sherpa-onnx keyword spotting over the corpus: per-phrase accept and reject rates, a confusion matrix with the opposing pairs broken out, and a threshold sweep. Vosk in grammar mode runs over the same corpus as the comparison.
3. **Live cost with iRacing running.** Release-to-result latency and release-to-first-audio latency; `FrameRate`, `CpuUsageFG` and `CpuUsageBG` logged from telemetry before, during and after recognitions; the added process memory.
4. **Packaging.** Load the sherpa-onnx addon from a folder outside `bin/` inside each of the three deck hosts; measure the runtime's size; confirm which npm package is the native one and that its DLLs resolve from the asset folder.
5. **Model licence.** Confirm the chosen model may be redistributed.

Proposed thresholds, for the maintainer to confirm:

- Release to start of the answer: 700 ms or less at the 90th percentile.
- Correct intent on the driving corpus: 95 % or better, with "say again" counted as a miss, not an error.
- Wrong action executed (a false accept of an action phrase, including an opposing pair): 1 % or less. This is the number that matters most.
- No measurable change in average `FrameRate`, and no frame hitch attributable to a recognition.
- Added memory: 150 MB or less.

On a no-go, Phase 1 still ships, and voice becomes the external-tools route only. On a Vosk-only go, Phase 2 builds the fallback implementation.

### Phases 1–4

| Phase | Piece | Size | Own issue |
| --- | --- | --- | --- |
| 0 | Rig prototype: corpus, offline accuracy (sherpa-onnx and Vosk), live latency and frame-time, packaging probe in three hosts, licence check | M | #1269 itself |
| 1 | Command registry in deck-core: ids, zod params, handlers, outcomes; the dispatcher that publishes `command.answered` (`xhigh`: published command contract, new catalog event) | M | yes (a #1164 split) |
| 1 | Readout builder extracted from Session Info, `race-engineer.readout` command, voice defaults for per-key parameters | S/M | yes |
| 1 | Pit-service state setters extracted from Fuel Service, Tire Service and Pit Quick Actions; `pit-service.*` commands with state checks and guards | M | yes |
| 1 | Outcome contracts and clips in both packs, harness shortcuts, pack reference | M | with the registry |
| 1 | New readout kinds, batch A: fuel now, laps of fuel, gap ahead and behind, position (`xhigh`: catalog) | M | yes |
| 1 | New readout kinds, batch B: laps and time remaining, incidents, tyre wear | M/L | yes |
| 2 | audio-native capture: capture enumeration, open and close natives, f32 mono 16 kHz, PCM via TSFN, mock parity | M | yes |
| 2 | audio-service capture lifecycle: open on press, uninit after the hang time, `powercfg /requests` verified | S | with capture |
| 2 | Speech asset kind: root, catalog, allow-list, ceiling, publishing in the tag workflow, on-demand install, shared install lock (`max` for the runtime verify) | M | yes |
| 2 | Recogniser: `SpeechRecognizer`, sherpa-onnx implementation in a worker, phrase table, generated keyword file with its freshness test, the phrase-set rules test | L | yes |
| 2 | Pit Crew **Talk to Engineer** mode: hold to talk, key states, listening cue | S | with the recogniser |
| 2 | Settings: **Microphone** picker, **Test microphone** with what was heard, phrase list, speech model status and install (`xhigh`: schema) | S/M | yes |
| 2 | Website feature page, Pit Crew page, voice-pack docs, changelog, Architecture page (a new input path into the bus, a new package, the registry) | S | with the mode |
| 3 | Dial surface for Talk to Engineer: Stream Deck+ hold, Mirabox knob press-to-start with VAD end (manifest `Controllers` change in three plugins) | M | yes |
| 3 | Keyboard-toggle commands, autofuel first | S/M | yes |
| 3 | More tyre patterns; fuel amount by number (may need the ASR mode) | M | yes |
| 3 | Recognition sensitivity setting, if Phase 0 and field reports show one threshold does not fit all | S | if needed |
| 4 | iRacing radio push-to-talk trigger, after its capture | S + capture | yes, with a spec |
| 4 | Single-listener claim across plugins (shared with #1164) | M | yes |
| 4 | SimHub bridge (#1164) and the external-tool transport | L | #1164's splits |
| 4 | Wheel-button native listener with a bind control | L | yes, with a spec |

The package layout, provisionally: the recogniser (engine wrapper, worker, `SpeechRecognizer`, keyword-file generator) in a new sim-agnostic package, the phrase table and command registrations in `iracing-actions` beside the actions whose services they share, and the registry in `deck-core`.

## Out of scope

- Free speech, intent extraction from open dictation, and any LLM.
- Cloud recognition of any kind.
- Text-to-speech; every answer is a pack line.
- Languages other than English.
- Always-on listening and wake words.
- Talking to other drivers; that is iRacing's push-to-talk and Audio Controls' **Push to Talk** mode.
- Confirm-before-execute flows, and voicing **clear all pit service**.
- Anything that makes the car pit ("box this lap" as an action).
- Per-user voice training.
- Dictating chat messages.
- Interrupting a line the engineer is speaking when the key is pressed.
- The deferred triggers (wheel button, radio push-to-talk, SimHub), beyond recording what settles each.

## Testing

**Suite.**

- Phrase table: every phrase maps to a registered command with valid parameters; no phrase's tokens appear inside another's; every opposing pair has a distinct alias; the generated keyword file is fresh.
- Recogniser (against a fake engine behind `SpeechRecognizer`): one detection is a match, two intents are not understood, none is not understood, a short tap with nothing is silent, the worker never blocks the main loop.
- Registry: unknown id and invalid params are refused; handlers run with no action context; the dispatcher publishes `command.answered` for each non-`done` outcome, and for `done` only with **Pit service requests** off.
- Pit-service commands, per command: `already` without sending when the state holds; the right `PitCommand` call when it does not; `refused` when not connected, not in the car, or during `PitstopActive`; `unavailable` for fast repair with none left; the shared setters behave identically when called from the actions (the existing action tests stay green unchanged).
- Readouts: the command publishes the same payload a Session Info press does for the same kind; each new kind's contracts and resolvers, in metric and imperial, with the #466 rounding boundaries; the position cooldown rule.
- Capture (mock parity): enumeration lists capture devices; open, data and close in order; an uninit after the hang time; no data callback after close.
- Settings: `audioInputDevice` defaults to System Default and survives a round trip; the bundled script-coverage and pack-reference freshness tests pick up the new contracts.

**Manual (the PR gate for each phase).**

- Phase 0 is itself the measurement, recorded on #1269.
- In iRacing, with a headset: each first-set phrase answered correctly while driving; each action changes the pit menu and is confirmed; each "already" case answered without a change; "say again" on nonsense; nothing on a short tap; a command during a serviced stop refused.
- With **Pit service requests** off: a voice action is still confirmed ("Copy.").
- Race Engineer off: the key does nothing and shows why.
- Microphone: the picker lists the headset; unplugging it shows the mic state; Windows' microphone privacy switch off is reported; iRacing voice chat and Discord keep working while the key is held.
- Sleep: `powercfg /requests` shows the capture request while held and nothing after the hang time; the PC sleeps normally after a session with voice use.
- Frame time: no visible hitch while speaking mid-corner.
- Speech model: first install from a key appearing, and from the settings window; a second plugin running at the same time does not download it twice.
- Phase 3: a Mirabox knob ends on silence, on a second press, and at the cap.

## Open questions

1. **The Phase 0 thresholds.** Are 700 ms p90, 95 % correct, 1 % wrong action, no frame-rate change and 150 MB the right go bar?
2. **Pit Crew mode or its own action?** A mode costs no new UUID; its own action would give the talk key its own place in the action list and its own dial surface without widening Pit Crew's `Controllers`.
3. **The "Copy." fallback.** Is a bare acknowledgment when **Pit service requests** is off right, or should a voice-issued change always get the full toggle confirmation regardless of that switch?
4. **Clear all pit service.** Leave it out of voice (proposed), or include it with a confirm step?
5. **Keys: hold only, or also press-to-start?** Hold is proposed for keys and Stream Deck+ dials, press-to-start with automatic end only for Mirabox knobs. A per-key choice would help drivers who find holding a key mid-corner awkward.
6. **The speech asset.** Is downloading the recogniser runtime, native code, acceptable under the same pinned-hash trust as voice packs? And on demand (proposed) or at every start like the Default pack?
7. **`audioOutputDevice`.** Should it be declared in `GlobalSettingsSchema` in the same change that declares `audioInputDevice`?
8. **The listening cue.** A new short tone on the `Cue` channel (proposed), or the existing radio-open tick?
9. **Fuel above 120.9.** A fuel-now readout for a tank above 120.9 liters (or gallons) aborts today; should `numbers-fuel` grow, and to what?
10. **Position scope.** Class position for "what position" (Session Info's default), or overall, or both as two phrases?
11. **The radio push-to-talk capture.** Is it worth taking the `@TEAM` capture early, since that trigger would let the driver's existing wheel PTT button work with no new input code?
