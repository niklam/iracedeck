# A Hear example button for each Race Engineer callout

> **Issue:** [#1701](https://github.com/niklam/iracedeck/issues/1701) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The Callouts card in the settings window renders one checkbox per `calloutEnabled*` key from the `@iracedeck/callout-settings` registry (#1350). A driver can read a label but not hear the call. Every call worth hearing is already composed at fire time by the active voice's `callouts.json` script against the code's vocabulary (#1064, #1065), so an example composed the same way covers every installed pack, third-party ones included, and follows every script change with no clip to regenerate.

Four facts in the code shape the design:

- **A row is a registry key, not a contract.** Contracts map to keys many-to-one through the `SCENARIO_ID_TO_*` maps (`callout-settings-coverage.test.ts`). Five families have no such map: `pit-service-requests` gates all 24 toggle-confirmation contracts through one wrapper, `setup-warning` is a clause inside the session-start and race-start briefs (`setupWarning.qualifyingMismatch` / `setupWarning.raceMismatch`), and `race-engineer-toggle`, `corner-names-toggle` and `telemetry-connect` are clips the deck actions in `@iracedeck/iracing-actions` play by path (`toggle/resuming-01`, `toggle/corner-names-on-01`, the driver-name clip plus `toggle/radio-check-01`). Two more rows, `pit-speeding/cue` and `pit-exit/cue`, are sound effects on the Radar and Cue channels with no voice line at all.
- **A fire's words come from two sources.** A var, condition or case resolver reads the fire's own event payload (`ctx.data`), live sim state through a `PitCrewDeps` closure (`getLivePosition`, `getLiveGaps`, the session-start snapshot, the spotter's stashed clip), or both. With no sim connected every live read is `null`, so a payload alone would compose a truncated line or nothing. Since #1138 no condition records anything and a var resolver only stashes a decision for its contract's `speakGate` to commit, so expanding a script without running the gate leaves no trace.
- **Every gate is outside the expansion.** The master gate, the per-callout opt-in, the session-type and caution checks and the cooldown checks live in `when.where`; cooldown claims and speak-time re-checks live in `speakGate`. An expansion that skips both is a composition, not a fire.
- **The Voice channel has direct players outside the engine.** The Voice Test (`voice-test.ts`), the toggle acknowledgments (`audio-toggles.ts`) and, until #1696 lands, the radio check play by path with `playVoiceSequence`; a fire's `playOnChannel` over one of them, or one of them over a fire, replaces the clip and the channel's single completion callback. #1696 (radio check) and #1698 (acknowledgments) move those into the engine in 3.9.0, which leaves the Voice Test as the last direct play; this change moves it too.

## Decisions

### 1. Examples are declared per registry key, beside the family that speaks the call

Each catalog family module in `audio-scenarios/src/catalog/pit-crew/` exports `<PREFIX>_EXAMPLES`, an object keyed by that family's callout ids and checked with `satisfies CalloutExamples<typeof <PREFIX>_CALLOUTS>`, which is `Record<CalloutIdOf<F>, CalloutExampleFactory>`. A family that gains an id without an example fails `pnpm typecheck`. The five registry families no scenario reads get the same map in the module nearest to what plays them (`toggle-confirmations.ts` for pit-service requests, `session-start.ts` for the setup warning, a new `plugin-played-clips.ts` for the three acknowledgments). The catalog barrel aggregates them into `CALLOUT_EXAMPLES: Readonly<Record<CalloutSettingKey, CalloutExampleFactory>>`.

The shape:

```typescript
/** What the user's settings contribute to an example. */
export type ExampleEnv = {
  /** `resolveActiveDriverName(_driverNames, "driver")`, the Voice Test's read. */
  driverName: string | null;
  /** The voice the engineer's plugin-played lines use, `resolveActiveRaceEngineerVoice`, the deck actions' read. */
  engineerVoice: string | null;
};

/** The trigger payload, typed by its event name. */
export type ExampleEvent = { [E in SimEventName]: { name: E; data: SimEventOf<E>["data"] } }[SimEventName];

export type CalloutExample =
  | {
      kind: "contract";
      /** The registered contract whose script the example composes. */
      contract: string;
      /** The trigger payload the real resolvers read; absent for a contract only `fire()` triggers. */
      event?: ExampleEvent;
      /** Resolved values for vocabulary that reads live state, keyed by registered name. */
      vars?: Readonly<Record<string, string | null>>;
      conds?: Readonly<Record<string, boolean>>;
      cases?: Readonly<Record<string, string | null>>;
      /** Optional groups the bundled script is expected to drop for this example (default 0). */
      optionalSkips?: number;
    }
  | {
      kind: "clips";
      /** Voice-relative clips from `plugin-played-clips.ts`; `"driver-name"` is the name clip. */
      clips: readonly (PluginPlayedClip | "driver-name")[];
    }
  | { kind: "none"; reason: "sound-effect" };

export type CalloutExampleFactory = (env: ExampleEnv) => CalloutExample;
```

- **The payload is the preferred carrier.** An example sets the trigger payload first, because the contract's own resolvers then compose it: a gap example carries a `gap.trendChanged` payload (ahead, closing, car index 12), a lap-time example a `lap.completed` payload with a 1:32.418 lap, a position example a race lap finished in P4. The envelope is `{ event, timestamp: now, telemetry: null, data }`.
- **Overrides cover only what reads live state,** in the var's own currency: a clip path or a `pool:` reference built with the family's own helper (`poolRef(POSITION_GROUP_NUMBER, "4")`, the gap's seconds and tenths, the spotter's `spotterClip` set to the car-left call), never a `voice/<voice>/…` path, so a third-party pack resolves them from its own clips. A name the active voice's entry uses that the example does not override runs its real resolver against the example's context, so a pack that phrases a call through other registered vocabulary is still heard. Override names must be registered (Testing, 2).
- **Fixed plausible values, and the driver's name.** Positions, gaps, lap times, fuel laps, temperatures and car numbers are constants in the example. The driver's name is the one value from settings, `ExampleEnv.driverName`, and an example that speaks a name takes it from `env` (the session-start greeting's `poolRef("session-start-greeting", env.driverName)`, the overtake loss line, the radio check). No callout speaks an opponent's name today; opponents are car numbers.
- **The special rows.** `pit-service-requests/requests` composes one toggle-confirmation contract (fuel added). `setup-warning/warning` composes the qualifying session-start brief with `setupWarning.qualifyingMismatch` overridden `true`, since the warning exists only as that clause. The three acknowledgments are `kind: "clips"`: `toggle/resuming-01`, `toggle/corner-names-on-01`, and `["driver-name", "toggle/radio-check-01"]`. `pit-speeding/cue` and `pit-exit/cue` are `kind: "none"`: they are sound effects every voice shares, not voice-pack lines.
- **One list of plugin-played clips.** `plugin-played-clips.ts` exports the clip names the plugin plays outside any script (the radio check, the two master-toggle acknowledgments, the two corner-names acknowledgments, the Voice Test greeting) as `PluginPlayedClip` constants. The deck actions (`audio-toggles.ts`, `pit-crew.ts`, `voice-test.ts`), the examples and `scripts/lib/lint-pack-run.mjs` all take them from there: `PLUGIN_PLAYED_CLIPS` there hand-writes the same `toggle/*` and `welcome/greeting` group and base today, and it already loads the built `audio-scenarios` through `catalog-engine.mjs`, so it reads the group and base from the built constants and keeps only its `playedBy` prose, whose stale file and function references are corrected in the same change. A test in `lint-pack-run.test.mjs` fails when an entry names a clip the constants lack, or the reverse.

### 2. The engine entry point: `playExample`, `checkExample`, `stopExample`

#1696 lands first (milestone 3.9.0; #1701 has none), so this builds on its free-bus test and its paths-only clip convention rather than adding a second one. Three `IScenarioEngine` members beside `playFramePreview`, implemented in the scheduler and expansion modules (the facade only forwards, as `interpreter-facade.test.ts` requires):

```typescript
export type ExampleSource =
  | {
      kind: "contract";
      id: string;
      event: SimEventOf<SimEventName> | null;
      vars?: Readonly<Record<string, string | null>>;
      conds?: Readonly<Record<string, boolean>>;
      cases?: Readonly<Record<string, string | null>>;
    }
  /** Full clip paths, played in order with no frame: #1696's `playClips` convention. */
  | { kind: "clips"; paths: readonly string[] };

export type ExampleResult = "playing" | "bus-busy" | "no-voice" | "not-scripted" | "unplayable";

export type ExampleCheck = {
  status: "ok" | "no-voice" | "not-scripted" | "unplayable";
  /** Optional groups the composition dropped. */
  skippedOptional: number;
};

playExample(source: ExampleSource, options: { label: string; onComplete?: () => void }): ExampleResult;
checkExample(source: ExampleSource): ExampleCheck;
/** Stop a playing example; `false` when none plays. */
stopExample(): boolean;
```

- **Composition.** A contract example is expanded by `Expansion.prepare` with one addition: an optional override set consulted before the vocabulary registry for each var, condition and case. Nothing else in the expansion changes, so the frame, the `optional` / abort rule (#835), the `case` branches and the `@` fragments behave exactly as for a fire. The voice is the one a fire of that contract resolves; the script entry is the one a fire would compile (`not-scripted` when the entry is absent or `skip: true`, the `isScripted` test). A clip source is already paths: the engine checks each against the live manifest and returns `unplayable` when one is missing, plays nothing else into it, and resolves no voice for it.
- **What it bypasses.** `when.where` (and with it the master gate, the opt-in, the session and caution checks), `triggerDelay`, `settle`, the `speakGate` and every cooldown claim, the queue, `queueBehind`, resume and the session generation's stale check. An example of a call that is switched off still plays: the button exists to help decide whether to switch it on.
- **Frame and picks.** A contract example plays in its frame (the entry's, else the contract's, else `radio`), with the driver's Radio beeps and Pit ambience switches applied, because the frame is part of how the call sounds. A clip source plays bare, as the deck actions play those lines. Pool picks are committed at once, the frame preview's precedent, so each press draws a random variant and repeated presses walk the pool under its no-repeat rule.
- **When it starts: one free-bus predicate.** The scheduler gets one named method, `previewMayStart(bus)`: no active fire other than a preview, an empty queue and no focus floor. `playFramePreview`, #1696's `whenBusy: "skip"` and `playExample` all call it; if #1696 inlines its test, this change extracts it. On a busy bus `playExample` plays nothing and returns `"bus-busy"`. There is no separate check for the Voice channel: once #1696, #1698 and the Voice Test move below are in, the engine owns every Voice play it arbitrates.
- **While it plays it is a preview, not a weighted fire, under a sentinel id.** It holds the Voice bus as `EXAMPLE_PREVIEW_ID` (`"(example)"`), declared beside `FRAME_PREVIEW_ID` in `engine-types.ts`, with no weight. `engine-types.ts` also exports `PREVIEW_IDS`, the set of both, which `yieldPreview` and `attemptFire` test instead of comparing to `FRAME_PREVIEW_ID`. The sentinel is what keeps an example from reading as a live fire of its contract: the same-family preemption in `attemptFire`, `cancelDisabled` and the line ends' `endFires` all look the active fire up by id, and no contract is registered under a preview id. Any fire that expands to something to play cuts it and then schedules as on an idle bus, so a real callout never waits behind an example. A new preview replaces a running one, whichever of the two ids it holds: the latest audition the driver pressed wins. A cut example is over: never stashed, never resumed. `options.label` names it in the log line and in `describeState`, which reports it as the active fire under the sentinel id.
- **`onComplete` runs exactly once,** when the example leaves the bus, finished, cut, replaced, stopped or `stopAll`, **and may run before `playExample` returns**: the frame preview already calls it synchronously when the switches leave it nothing to play (`scheduler.ts`), and `Playback` steps past a clip that fails to start synchronously, so an example whose every clip fails finishes inside the call. Callers must not do anything after a `"playing"` return that `onComplete` would have to undo.
- **`checkExample` is a dry composition.** It runs the same lookup and expansion, plays nothing, commits no pick and logs nothing per call, and reports `skippedOptional` so the coverage test can hold a composition whole. Whether the bus is free is not part of it.

### 3. The catalog wrapper, the runner and the audio holds

`@iracedeck/audio-scenarios/pit-crew` exports `playCalloutExample(key, env, onComplete)` and `calloutExampleAvailability(env)`. They look a key up in `CALLOUT_EXAMPLES`, build the factory's example with `env` and turn it into an `ExampleSource`: a contract example becomes the envelope around its payload plus its overrides; a clip example becomes full paths, `voice/<env.engineerVoice>/<clip>.mp3` for each constant and `driverNameClipPath(env.engineerVoice, env.driverName)` (#1173) for `"driver-name"`, so the engine takes paths only, as with `playClips`. With no engineer voice a clip example is `no-voice`. `calloutExampleAvailability` returns a record over every key of `CalloutExampleAvailability`, the reason union declared in `app-constants` (section 5), with `"no-example"` for `kind: "none"`.

**Audio holds replace the bypass booleans.** `iracing-actions/src/audio/audio-volume.ts` today keeps `raceEngineerTestInFlight` and `raceEngineerToggleInFlight` as separate booleans, reads `isBackgroundTestInFlight()` from `audio-scenarios`, and records in its own comments that the first `stopRaceEngineerPlayback` cleared one flag and missed the other. They become one set of named holds, each declaring the buses it keeps audible at their slider values:

```typescript
export const AUDIO_HOLDS = {
  "voice-test": [AudioBus.Voice],
  "toggle-ack": [AudioBus.Voice],
  "background-test": [AudioBus.Background],
  "callout-example": [AudioBus.Voice, AudioBus.Background],
} as const satisfies Record<string, readonly AudioBus[]>;

export type AudioHold = keyof typeof AUDIO_HOLDS;

raiseAudioHold(hold: AudioHold): void; // adds, then applyRaceEngineerAudio()
releaseAudioHold(hold: AudioHold): void; // removes, then applyRaceEngineerAudio()
releaseAllAudioHolds(): void; // stopRaceEngineerPlayback's one call
```

`applyRaceEngineerAudio` unmutes a bus when the master gate is on or any raised hold names it. `isBackgroundTestInFlight` retires into the set: nothing but `audio-volume.ts` reads it, so the Background Test runner raises `background-test` before `playBackgroundTest` and releases it in the callback it already passes, and `background-test.ts` keeps no flag. `callout-example` names the Background bus because the radio frame's ticks (SFX) and pit bed (Ambient) are routed there, so with the master gate off an example would otherwise play as bare speech.

**Hold order, the Voice Test's precedent.** Every runner raises its hold before it calls the engine, releases it at once on any result but `"playing"`, and releases it in `onComplete`. Because `onComplete` may run before the call returns, nothing after the call touches the hold.

**The runner** is `runCalloutExample(key, logger, onEnd): ExampleResult` in `iracing-actions/src/audio/callout-examples.ts`, beside `runAudioPreview`. It reads `ExampleEnv` from settings, raises `callout-example`, calls `playCalloutExample`, releases on a non-playing result, and in `onComplete` releases and then calls `onEnd`. It returns the engine's verdict and writes no settings key. It logs `Playing callout example <key> for voice <voice>` at info (a user action) and each refusal at debug. `stopCalloutExample()` calls `stopExample()`. **An example therefore plays with the Race Engineer switched off**, as the Voice Test does: the window is where a driver sets the engineer up, usually with it off and no session running.

**The Voice Test moves into the engine.** `playRaceEngineerVoiceTest` builds the same two paths it plays today (the name clip and the greeting constant) and calls `playExample({ kind: "clips", paths }, { label: "voice test", onComplete })` under the `voice-test` hold; with the engine not initialised it falls back to its direct play, as #1696's radio check does. A Test pressed while an example plays replaces it by the preview rule above, so no runner stops another. A Test pressed while the engineer is talking now plays nothing and logs `Voice test skipped — the engineer is on the radio` at debug, where today it plays over the callout and strands its fire.

**No sim is needed.** The scenario engine is initialised in the Race Engineer startup phase whether or not iRacing runs, `setScripts` has compiled every voice by then, and nothing in an example reads the sim except the resolvers it does not override, which answer `null` without one.

### 4. The command: `calloutExample` and `calloutExampleStop`

`createSettingsWindowCommandHandler` gains two cases and two optional delegates:

- `{ event: "calloutExample", key }` calls `playCalloutExample(key)` only when `typeof key === "string"` and `CALLOUT_SETTING_KEYS.includes(key)`. The allow-list is the registry itself: the handler imports `CALLOUT_SETTING_KEYS` from `@iracedeck/callout-settings`, a zero-dependency leaf, which adds a `settings-window → callout-settings` edge. The check is membership in a closed list, not a format rule, so a forged value (a path, `__proto__`, a key with a suffix, a number) matches nothing and is dropped, and the worst a valid forged key can do is play that call's example. The delegate's parameter is typed `CalloutSettingKey`.
- `{ event: "calloutExampleStop" }` takes nothing from the page and calls `stopCalloutExample()`.

Both arrive like every other window command, as `sendToPlugin` frames over the fake host's socket, which the request guard has already authorised by token or cookie. **The request guard does not change.** `plugin-runtime`'s `initSettings` binds the two delegates in `phases/settings/settings-window.ts`, beside `previewAudio`. The button exists only on the window's Callouts card, so no action PI and no Ulanzi `normalizeFrame` marker is involved.

### 5. How the page learns state: one run-scoped key with one owner

`app-constants` declares, beside `VOICE_PACK_STATUS_KEY`, so the PI bundle imports them like the other status payloads:

```typescript
export const CALLOUT_EXAMPLES_STATUS_KEY = "_calloutExamples";

export type CalloutExampleAvailability = "ok" | "no-voice" | "not-scripted" | "unplayable" | "no-example";

export type CalloutExamplesStatus = {
  /** Every key that cannot play now, with why; a key absent here can play. Keys are registry keys, typed as strings here. */
  unavailable: Readonly<Record<string, Exclude<CalloutExampleAvailability, "ok">>>;
  /** The key whose example holds the bus, or null. */
  playing: string | null;
  /** The last press refused at the bus, for a short note on its row; `seq` tells two refusals apart. */
  refused: { key: string; seq: number } | null;
};
```

The key is enrolled in `RUN_SCOPED_SETTING_KEYS` and written as a JSON string, the `_profileCaptureStatus` pattern: within a run it reaches the page like any global setting, it never reaches the settings file, and a write touching only it skips the save. `audio-scenarios` derives its availability type from this union.

- **One owner, beside the voice-pack pushes.** The key is written only by `voicePacks.push.calloutExamples()` in `plugin-runtime/src/phases/voice-packs/`, deduped on its last JSON like the other three pushes. It is called where they are: from `onPacksChanged` behind `isGlobalSettingsInitialized()` (after a rescan's `applyScripts` has handed the engine its scripts), and through `pushVoicePackLists`, so from the settings listener on every settings arrival and from the Property Inspector appear handler. That replaces any hand-listed trigger, and it is required twice over: the startup `setScripts` runs in phase 7, before global settings are initialised, where a write would set the dedupe marker and reach nothing (the trap `scan.ts` documents for the voice list), and a run-scoped key is re-asserted by its producer within the run.
- **Recomputed only when its inputs moved.** The push recomputes availability with `calloutExampleAvailability` (about 105 dry compositions, no audio) when the active voice id, the engineer voice, the driver name or the scan generation differs from its last computation, and otherwise re-asserts the last value, so a slider drag costs a comparison.
- **`playing` and `refused` are recorded by the same owner,** by the settings-window delegate binding in `phases/settings/settings-window.ts`: it opens a press record, calls `runCalloutExample(key, logger, onEnd)` with `onEnd` closing that record, and then hands the owner the returned verdict. `"playing"` sets `playing` unless that press already ended, which is how an `onComplete` that ran before the call returned leaves `playing` clear; `onEnd` clears `playing` only if it still names that press; `"bus-busy"` sets `refused` with the next `seq`, and the next press clears it. Any other verdict marks availability stale, so the row corrects itself when the voice changed between the last computation and the press. `iracing-actions` never writes the key.

### 6. The page: one small button on each row

`pi-components` gains `ird-callout-example key="<calloutEnabled…>"`, emitted by the row generator in `race-engineer-callouts.ejs` (from `callout-pi-groups.mjs`) at the end of each row, after its checkbox. It is designed against a row, whatever grouping #1700 gives the card: the generator that emits a row's checkbox emits its button. It is its own component rather than a `defineSendToPluginButton` pill, because it is an icon toggle with three states that must fit about 105 times beside checkboxes in a two-column grid; it sends through `sdpi-client.ts` and reads `CALLOUT_EXAMPLES_STATUS_KEY` through `skipUnchanged`, like `ird-cpu-profile-status`.

- **Idle:** a play icon, `aria-label="Hear an example: <row label>"`. A press sends `{ event: "calloutExample", key }` and nothing else.
- **Playing** (`playing === key`): pressed (`aria-pressed="true"`) with a stop icon; a press sends `calloutExampleStop`. Pressing another row's button while one plays replaces it.
- **Unavailable:** `aria-disabled="true"` rather than `disabled`, so the reason shows as a tooltip and to a screen reader (`aria-describedby`), and a press does nothing. Reasons: `no-voice` "No Race Engineer voice is installed.", `not-scripted` "The selected voice doesn't say this call.", `unplayable` "The selected voice is missing a clip this example needs." Before the first status arrives every button reads "The Race Engineer isn't ready yet."
- **No example:** `no-example` hides the button, for the two sound-effect rows.
- **Refused:** a `refused` naming the row shows "The engineer is on the radio. Try again when the engineer is done." under the row for four seconds.

### 7. Compatible with separate Spotter and Race Engineer voices (#1642)

Nothing here names one voice for every call. A contract example takes its voice from the same resolution a fire of that contract uses, so when #1642 resolves voices per contract role, a spotter row plays in the Spotter voice with no change here. A clip example is the engineer's own plugin-played line, resolved through `ExampleEnv.engineerVoice`, which under #1642 is the Race Engineer role's voice. The status key is per key with no voice field, so it survives unchanged; #1642 adds its Spotter voice to the push's inputs, and the `not-scripted` text becomes "The voice for this call doesn't say it."

## Differences from the issue

- **Two rows get no button:** pit road speeding and the pit exit beep are sound effects, not voice lines.
- **Examples are keyed by registry key, not declared on each contract:** keys and contracts are not one to one, and three rows have no contract.
- **The runner sits in `iracing-actions`, and the key's owner in `plugin-runtime`:** the issue names `race-engineer-wiring`, which this change does not touch, and the request guard, which needs no change because commands ride its authorised socket.
- **`whenBusy: "skip"` governs only the start:** while playing, an example yields to callouts like the frame preview, rather than holding the bus as #1696's `NORMAL` fire does.
- **With the Race Engineer off, the Background bus is unmuted too:** the frame's beeps and pit bed are routed there, not to the Voice bus.
- **The Voice Test moves into the engine:** without it a direct play could still cut an example and strand it.
- **No callout speaks an opponent's name:** opponents are car numbers.

## Alternatives rejected

- **Pre-recorded example clips per callout.** A second set of clips per voice to generate and keep in step with every script edit, with no answer for a third-party pack, whose scripts may phrase the call differently or not at all. The issue rules it out for that reason.
- **Publishing a synthetic trigger event on the bus.** It runs the `where:` gates (master, opt-in, session type, caution, cooldowns), so an example of a call that is off or out of session would be silent; its `speakGate` would claim real cooldowns and burn the next real call's window; and every other subscriber of that event (the plugin's bus caches, other families) would take the fake lap or gap as live state.
- **`engine.fire(id)`.** The imperative fire carries no event, so every payload-reading resolver answers `null`, and it still runs the speak gate and competes by weight.
- **Reusing the scenario harness shortcuts.** They are timed multi-step sequences driving the iRacing mock SDK in a harness-only package; the plugin cannot depend on it, and they exercise the whole translator rather than one script.
- **A complete resolved vocabulary per example, no payload.** It restates each resolver's logic as constants (a gap becomes three pool references the resolver already knows how to make) and silences a pack that phrases a call through other registered vocabulary. The payload plus live-only overrides keeps the real resolvers composing.
- **An `example` field on `ScenarioContract`.** Keys and contracts are not one to one (24 contracts behind one pit-service key, a setup-warning clause, three acknowledgments with no contract), and it would put a catalog concern on the engine's type. Keyed by callout id beside the family, the type checker enforces completeness per family.
- **Playing the example under its contract's id.** Same-family preemption, `cancelDisabled` and `endFires` would treat it as a live fire of that contract: a real call of the same family would replace it as stale news, and disabling or ending the contract would reach it.
- **A weighted clip fire, #1696's `playClips` at `NORMAL`, for examples or the Voice Test.** A real callout would wait behind an audition the driver pressed in the garage, and `playClips` carries no completion callback for the hold. The preview semantics make both yield instead.
- **A check that the Voice channel is idle before an example starts.** It patches one symptom of direct plays while leaving the reverse case (a direct play over an example) open; moving the last direct play into the engine closes both.
- **Writing the status key from the runner, or from each trigger site.** Writes before settings initialisation would be lost behind the dedupe marker, a run-scoped key would not be re-asserted, and two writers of one key race; one owner beside the voice-pack pushes avoids all three.
- **A button per heading.** A heading spans distinct calls (the Flags heading alone has 21), so it cannot play the one the driver is deciding on.
- **A reply to the command, or a route the page polls.** The fake host has no reply channel, and a route would be a second authenticated surface; a run-scoped key is the established way the plugin tells the window about state (`_voicePackStatus`, `_profileCaptureStatus`).
- **Checking availability in the page.** The page has the voice list but not the compiled scripts, so it cannot know which calls a voice says.

## Out of scope

- A button on the two sound-effect rows (pit road speeding cue, pit exit beep). They are not voice lines; hearing them belongs with the audio Test buttons, as its own issue if wanted.
- The action PIs: the Callouts card is in the settings window only (#1003).
- Separate voices per role (#1642), the radio check through the scheduler (#1696) and the toggle acknowledgments that play by path, which #1698 moves into the engine. This change only moves their clip names into `plugin-played-clips.ts`.
- Showing the words of the example as text.
- Examples in the scenario harness, the generated pack reference or `lint:pack`'s findings (its clip list changes source, not content).
- Any settings key, default or migration, and any voice-pack format change.

## Affected artifacts

- `@iracedeck/audio-scenarios`: `engine-types.ts` (`EXAMPLE_PREVIEW_ID`, `PREVIEW_IDS`), `scheduler.ts` (`previewMayStart`, `playExample`, `stopExample`, `yieldPreview`), `expansion.ts` (the override set, `checkExample`), `interpreter.ts` (the three members, forwarded), the catalog's `<PREFIX>_EXAMPLES` and `CALLOUT_EXAMPLES`, `plugin-played-clips.ts`, `background-test.ts` (its flag retires), `CLAUDE.md`.
- `@iracedeck/iracing-actions`: `audio/callout-examples.ts`, `audio/audio-volume.ts` (the holds), `audio/audio-previews.ts`, `audio/voice-test.ts`, `audio/audio-toggles.ts` and `actions/pit-crew/pit-crew.ts` (the clip constants).
- `@iracedeck/app-constants`: the key, the reason union and the status type. `@iracedeck/settings`: `RUN_SCOPED_SETTING_KEYS` and its tests.
- `@iracedeck/settings-window`: the two commands; its `CLAUDE.md`.
- `@iracedeck/plugin-runtime`: `phases/voice-packs/` (the push and the press record), `phases/settings/settings-window.ts` (the delegates), `phases/settings/listeners.ts` (through `pushVoicePackLists`), `types.ts`.
- `@iracedeck/pi-components`: `ird-callout-example`, `race-engineer-callouts.ejs`, `callout-pi-groups.mjs`; so all three plugins.
- `scripts/lib/lint-pack-run.mjs` and its test.
- Website: the settings-window page; the Architecture page (`docs/development/architecture.md`), whose dependency prose lists `settings-window`'s imports and gains `callout-settings`, and whose `app-constants` sentence gains the callout-example status; a changelog fragment, one with #1700's if both ship in the same release.
- Rules: `.claude/rules/race-engineer-callouts.md` (a new callout declares an example), `.claude/rules/settings-window.md` (the two commands and that their allow-list is `CALLOUT_SETTING_KEYS`, in the commands bullet and the run-scoped keys list), `.claude/rules/global-settings.md` (the run-scoped key).

## Testing

1. **Engine** (`scheduler.test.ts`, `expansion.test.ts`, `interpreter.test.ts`; fake clock and `createFakeAudio`): on an idle bus a contract example plays its frame and body in order; an override beats the registered resolver and an un-overridden resolver receives the example's envelope; `where:` and `speakGate` are never called and no cooldown is claimed; two presses commit picks so the second draws another variant; an active fire, a queued fire and a focus floor each return `"bus-busy"` and play nothing, and `playFramePreview` and `playExample` refuse on exactly the same states (one predicate); a running example or frame preview is replaced; an arriving fire that expands cuts the example and plays as on an idle bus, and one that aborts leaves it playing; an arriving fire of the example's contract's family, `setEnabled(contract, false)` and an `endsOn` event of that contract do not touch it; `stopExample`, `stopAll` and completion each run `onComplete` exactly once; a clip source whose every clip fails to start runs `onComplete` before `playExample` returns; `no-voice`, `not-scripted` (absent and `skip: true`) and `unplayable` (a required clip missing, a clip path missing); `checkExample` plays nothing, commits nothing and logs nothing; `describeState` shows the example under its sentinel id.
2. **Catalog coverage** (`catalog/pit-crew/callout-examples.test.ts`): `CALLOUT_EXAMPLES` has exactly one entry per `CALLOUT_SETTING_KEYS` entry, none stray; each contract example names a registered contract on the Voice bus whose `SCENARIO_ID_TO_*` map resolves to the example's own key, with the pit-service-requests and setup-warning rows named as the only exceptions and the reason beside each; each example's event name equals its contract's `when.event`, and an imperative contract's example has none; every override names registered vocabulary; every clip example's constants exist for every bundled voice; for every bundled voice and every example, `checkExample` is `"ok"` with `skippedOptional` equal to the example's `optionalSkips`, once with a name the default voice records and once with the `driver` fallback; running every example leaves `readRaceEngineerState()` unchanged, with a positive control in which a resolver that records state makes the comparison fail. The family maps' completeness is held by `pnpm typecheck`.
3. **Runner and holds** (`iracing-actions`: `callout-examples.test.ts`, `audio-volume.test.ts`, `voice-test.test.ts`): with the master gate off the example raises `callout-example` before the engine is called and both buses play at their slider values; a non-playing verdict releases it at once; completion releases it and restores the gate's levels; an engine double that calls `onComplete` synchronously inside `playExample` leaves no hold raised and `onEnd` called once; `releaseAllAudioHolds` clears every hold in one call and `stopRaceEngineerPlayback` uses it; the Background Test raises and releases `background-test`; the Voice Test goes through `playExample` under `voice-test`, falls back to the direct play with no engine, and logs the skip on a busy bus.
4. **Command** (`settings-window-commands.test.ts`): a registry key reaches the delegate; an unknown string, a key with a suffix, a path, `__proto__`, an empty string, a number and a missing key reach nothing; `calloutExampleStop` reaches its delegate and ignores any extra field; both are no-ops without their delegates.
5. **Status owner** (`plugin-runtime`): nothing is written before global settings are initialised, and the first settings arrival publishes the startup availability; a rescan's `onPacksChanged`, a settings arrival and a PI appear each publish, and an unchanged value is not rewritten; availability is recomputed only when one of its inputs moved; a press whose `onEnd` runs before its verdict is recorded leaves `playing` clear; a refusal sets `refused` with a new `seq` and the next press clears it; `run-scoped-settings.test.ts`, the snapshot test and `persisted-values.test.ts` cover `_calloutExamples`.
6. **Page** (`pi-components`): the row generator emits one `ird-callout-example` per registry key; the component renders idle, playing, each unavailable reason, the hidden no-example state and the four-second refusal, and sends exactly `{ event: "calloutExample", key }` or `{ event: "calloutExampleStop" }`.
7. **Pack linter** (`lint-pack-run.test.mjs`): `PLUGIN_PLAYED_CLIPS` and the built `plugin-played-clips.ts` constants name the same clips, and the check fails when either gains one.
8. **Manual, Stream Deck, iRacing not running:** open Settings → Race Engineer → Callouts and hear a row from each of position, gap, lap time, pit readback, a flag, spotter cars, pit-service requests, the setup warning and the radio check, each in the selected voice with its radio frame and your name where the call uses it; press one twice and hear a different variant where the pool has one; press while one plays and hear it replaced, press the playing row and hear it stop; press the Voice Test during an example and hear the example replaced by the test; switch the Race Engineer off and hear an example still play with its beeps, then confirm nothing else sounds; switch a callout's checkbox off and still hear its example; select a development-root voice whose `callouts.json` lacks an entry and see that row disabled with its reason, then press Rescan voices after adding it and see it enabled.
9. **Manual, Stream Deck, iRacing running:** in a session, press a row while the engineer is mid-callout and see the refusal note with nothing played; start a long example (the session brief) and complete a lap so a real callout arrives mid-example, and hear the callout cut the example; press the Voice Test while the engineer talks and hear nothing cut.
