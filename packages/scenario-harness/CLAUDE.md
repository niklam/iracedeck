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

## Mock SDK controller

`MockSDKController` implements only the structural surface the translator uses (`subscribe`/`unsubscribe`/`getSessionInfo`); it's handed over cast `as unknown as SDKController` because the real class's private fields defeat structural typing (same pattern as the translator tests). Default tick interval is 14 ms (matching the real controller's poll rate). Default telemetry is "in garage / engine off / no flags / off-track" so boot fires no spurious events.

## Seeded settings

`src/bootstrap-settings.ts` seeds the adapter's global-settings store from the audio-assets manifest: `_raceEngineerVoices` / `_driverNames` (plus the first entry of each as the picked voice / driver name), Race Engineer and Radar enabled at volume 100. So scenarios fire on a fresh boot with zero UI interaction. `initGlobalSettings` is called AFTER seeding so the listener delivers the seeded values on the first tick (`src/main.ts`).

## Presets

`presets/telemetry/*.json` and `presets/session/*.json`; the filename (minus `.json`) is the preset name. Applied via `/api/telemetry/preset` and `/api/session/preset`. Malformed preset files are silently skipped at load (`src/server.ts`).

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
