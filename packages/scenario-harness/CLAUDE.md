# @iracedeck/scenario-harness

Local QA tool for auditioning Race Engineer / Pit Crew audio without launching iRacing. Boots the REAL event-bus / sim-events-iracing translator / audio-service / audio-scenarios stack against a mock SDK controller (`src/mock-sdk-controller.ts`) and a mock platform adapter, and serves a web UI for live telemetry/session mutation, presets, one-click scenario shortcuts, raw bus-event injection, and audio activity monitoring.

For the end-to-end "how to add a callout" walkthrough (which includes this package's harness steps), see `.claude/rules/race-engineer-callouts.md` — the notes below cover harness-only mechanics.

## Running

```bash
pnpm --filter @iracedeck/scenario-harness dev   # tsx watch src/main.ts
```

UI at `http://127.0.0.1:5750/` (`DEFAULT_HOST`/`DEFAULT_PORT` in `src/server.ts`). No iRacing, no deck hardware.

## Audio pipeline

Boot processes the audio-assets clips through the same radio-engineer ffmpeg filter the plugin build applies, so the harness auditions the exact clips shipped to users. The processed cache is shared with the plugin builds (`packages/audio-assets/.cache/<filter-hash>/`), so the first run after a plugin build is a fast cache-hit copy. The UI's audio refresh re-runs the processor with `wipe: false` — Windows/miniaudio holds file locks on any clip currently loaded, so overwrite-in-place instead of rmSync (`src/main.ts`). `/api/audio/wipe-cache` nukes the upstream ffmpeg cache and reprocesses everything — a last-resort diagnostic (`src/server.ts`).

## Callout scripts and voice packs (#1064)

Since #1064 a voice's callouts are data it ships — `voice/<voice-id>/callouts.json` — compiled by the engine against the contracts `registerPitCrew` declares, so the harness has to hand the engine a script or every migrated callout is silent. `src/voice-scripts.ts` does it two ways, and `src/main.ts` wires both **after** `registerPitCrew` (calling `setScripts` earlier compiles every entry to "no contract" and warns once per scenario about a state the first fire would silently fix — the order the plugins keep too):

- **The bundled voice's script is read from the audio-assets source tree** (`loadBundledVoiceScripts`, `audioAssetsPath` + `calloutScriptPath` for every `BUNDLED_VOICE_IDS` entry) — the same committed artifact the plugin build copies and the packer ships. **It throws, naming the file**, on a missing, non-JSON or schema-failing artifact, and that ends the boot. Deliberate: the harness is a dev tool, and a bundled voice with no usable script is a build that would ship a silent engineer. (The plugins go through the never-throwing scanner instead, since a plugin must never end its process over a pack.) After editing `configs/<voice>.voice.json`, run `pnpm generate:callout-scripts` in `packages/audio-assets` — the harness reads the generated artifact, not the config — then press **Reload audio** in the UI: `/api/audio/refresh` runs the processor and then `reloadVoiceScripts` (`src/voice-scripts.ts`), which re-reads the bundled scripts (or, with a packs directory named, runs the pack service's refresh) and hands the engine the new map, so a regenerated script is auditioned without a restart. A broken regenerated script fails the Reload request loudly, naming the file, rather than leaving the engine on the old map.
- **Installed voice packs load when `IRACEDECK_VOICE_PACKS_PATH` names a packs directory** (`loadInstalledVoiceScripts`): the plugins' own `createVoicePackService` over the real `createVoicePackFileSystem`, so a sideloaded or downloaded pack's clips AND script load exactly as they do in a plugin — roots to the audio service, the merged manifest to the engine and the voice list, then the merged script map (bundled ∪ installed) to the engine, in that order. The seeded `_raceEngineerVoices` / `_voiceLabels` are re-issued afterwards so the UI's Voice dropdown offers the pack's voices. The service reads the bundled voice's script from the harness's processed audio root (`.cache/audio`, where `processAndCopyAudioAssets` copies `callouts.json` beside the clips); a processed root from before that copy existed falls back to the source-tree read above. Unset, the harness is the bundled voice alone — the default, and what every shortcut assumes.

The radio frame's two opt-outs, `raceEngineerRadioBeeps` and `raceEngineerPitAmbience`, are seeded on and read live at frame expansion through `getFrameOptions` in `src/main.ts` (deck-core's `frameOptionsFromSettings`, the same rule the plugins and the Background preview use) — `POST /api/settings {"patch": {"raceEngineerRadioBeeps": false}}` is heard on the next callout, and the UI's settings grid offers both as the **Radio Beeps** / **Pit Ambience** checkboxes (`ui/app.js`, `renderSettings`).

## Mock SDK controller

`MockSDKController` implements only the structural surface the translator uses (`subscribe`/`unsubscribe`/`getSessionInfo`); it's handed over cast `as unknown as SDKController` because the real class's private fields defeat structural typing (same pattern as the translator tests). Default tick interval is 14 ms (matching the real controller's poll rate). Default telemetry is "in garage / engine off / no flags / off-track" so boot fires no spurious events.

## Seeded settings

`src/bootstrap-settings.ts` seeds the adapter's global-settings store from the audio-assets manifest: `_raceEngineerVoices` / `_driverNames` (plus the first entry of each as the picked voice / driver name), Race Engineer and Radar enabled at volume 100, and the radio frame's beeps and ambience on (#1064). So scenarios fire on a fresh boot with zero UI interaction. `initGlobalSettings` is called AFTER seeding so the listener delivers the seeded values on the first tick (`src/main.ts`).

**The harness cannot test any callout gate, and the seeded settings make it look like it can.** It passes `registerPitCrew` only the eight resolvers it needs — `getPitActionsAllowed` plus the snapshot/gap resolvers (see the `DEFAULT_DEPS` comment above that call in `src/main.ts`) — and **no master gates and no `calloutEnabled*` getters at all**, so every one of those runs on its `() => true` default here. That is deliberate: the harness seeds no `calloutEnabled*` settings and wants everything audible.

The trap is that `pitCrewRaceEngineerEnabled` and `pitCrewRadarEnabled` *are* seeded, so toggling them appears to exercise the master gates. It doesn't. `pitCrewRadarEnabled` reaches the radar through the harness's own `applyAudioSettings` → `setRadarEnabled` path (`src/main.ts`), never through the `getRadarMasterEnabled` dep, and `pitCrewRaceEngineerEnabled` reaches nothing at all — the voice master gate is the hardcoded default. So the radar responding to a toggle here says nothing about whether the master keys are wired correctly.

Anything gated by a master or a per-callout opt-in — including which getter a family is wired to — has to be tested in a real plugin against real global settings. Use the harness for what it does cover: that scenarios register and fire, and that the eight resolvers above deliver the right *content* (a corner-name call that names no corner is a resolver reaching the wrong key, even though audio played).

## Presets

`presets/telemetry/*.json` and `presets/session/*.json`; the filename (minus `.json`) is the preset name. Applied via `/api/telemetry/preset` and `/api/session/preset`. Malformed preset files are silently skipped at load (`src/server.ts`).

## Deleting a telemetry field (capability gates)

`/api/telemetry` merges **`body.patch`** into the current snapshot — `POST {"patch": {"dcPitSpeedLimiterToggle": null}}`, not the bare object, which is rejected with a 400 — and an explicit `null` there **deletes** that key rather than setting it (`mutateTelemetry`, issue #1051). JSON has no `undefined`, and without the sentinel a patch could never make a field ABSENT — which is exactly what iRacing's capability fields mean: `hasPitLimiter`, `hasVisor` and `hasWipers` all read whether a `dc*` field EXISTS, not what it holds. No `TelemetryData` field takes null legitimately, so the sentinel is unambiguous.

So `{"dcPitSpeedLimiterToggle": null}` turns the mock car into one with no pit limiter, which is how the no-limiter pit-speed callouts are auditioned; the field ships present by default because most of the roster has a limiter. Before the sentinel existed, one of the two families was always unfireable and its shortcuts looked broken rather than correctly gated.

## Snapshot endpoints vs telemetry patch

Scenarios whose resolvers are harness-held (session-start, qualifying-invalidation, race-start) have dedicated `/api/<name>/snapshot` endpoints; shortcuts in `src/scenario-shortcuts.ts` may carry a snapshot inline, which the UI POSTs BEFORE publishing the trigger event so the resolver returns the intended snapshot at fire time. `/api/readback/snapshot` is different: production readback scenarios re-read live telemetry at fire time (issue #481), so it converts the composer snapshot into a telemetry PATCH via `snapshotToTelemetryPatch` (`src/pit-readback-telemetry.ts`), which mirrors the translator's `buildSnapshot()` field-for-field, then ticks once synchronously. Known limitation: `windshield.available` has no telemetry source (`buildSnapshot()` hardcodes it `true`), so the patch drops it.

The session-start composer has a second fire button, "Fire as Fresh Connect", publishing `session.changed { from: -1, to: 0 }` (the translator's mid-session connect shape) so the #871 on-track suppression is reproducible — apply a telemetry preset (`hot-lap` vs `in-garage`) before firing; the race-start equivalents are the two "Fresh connect" shortcuts in `src/scenario-shortcuts.ts`.

## API surface

HTTP for writes, WebSocket (`/ws`) for the live stream of `event` / `state` / `audio` messages. Routes (`src/server.ts`): `/api/state` (full snapshot incl. event templates, shortcuts, preset names), `/api/connection`, `/api/tick` + `/api/tick/once`, `/api/telemetry` (+`/preset`), `/api/session` (+`/preset`), `/api/settings`, `/api/audio/device|refresh|wipe-cache`, the snapshot endpoints above, and `/api/bus/publish` (raw event injection, name-checked against the catalog).

## UI

Static files in `ui/` (`index.html` / `app.js` / `styles.css`), no build step, served by `@fastify/static`.

## Maintenance hooks

- New bus event → add a template to `src/event-names.ts`; the compile-time completeness check at the bottom of that file fails `pnpm build` if the list drifts from `SimEventMap` in either direction.
- New callout → add a one-click shortcut to `src/scenario-shortcuts.ts` (per the checklist in `.claude/rules/race-engineer-callouts.md`).
