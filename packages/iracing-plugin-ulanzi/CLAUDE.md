# @iracedeck/iracing-plugin-ulanzi

Ulanzi Deck plugin for iRaceDeck. Registers actions from `@iracedeck/iracing-actions` with UlanziStudio via `@iracedeck/deck-adapter-ulanzi`.

Mirrors the structure of `@iracedeck/iracing-plugin-mirabox` but targets Ulanzi Deck devices (D200 / D200H / Dial / D200X) instead of Mirabox/VSD.

## Key Differences from iracing-plugin-mirabox

- Uses `UlanziPlatformAdapter` instead of `VSDPlatformAdapter`.
- **Action-UUID namespace mapping.** UlanziStudio requires the plugin UUID to be a 4-segment `com.ulanzi.ulanzistudio.*` and action UUIDs to extend it, so `plugin.ts` wraps every canonical `com.iracedeck.sd.core.*` action UUID through `toUlanziActionUuid()` (via the local `register()` helper) and the manifest declares the same rewritten UUIDs. The action classes are unchanged.
- Manifest is the Ulanzi format: `Type:"JavaScript"`, `CodePath:"bin/plugin.js"`, `UUID:"com.ulanzi.ulanzistudio.iracedeck"`, per-action `States:[{Image}]`, `Controllers:["Keypad"]`/`["Keypad","Encoder"]`, and `Encoder:{layout:"$UA1"}` for dial-capable actions. `"Knob"` (Mirabox) → `"Encoder"`; the Stream-Dock-293S `"Information"` controller has no Ulanzi equivalent and is dropped (Session Info / Telemetry Display become Keypad-only). No top-level `PropertyInspectorPath` (not in the Ulanzi manifest schema) — plugin-global settings are reached through each action's PI.
- **PI connection bridge.** Ulanzi's PI does not call `connectElgatoStreamDeckSocket` and speaks its own URL-param + `cmd` WebSocket protocol, so the rollup injects `ulanzi-pi-bridge.js` (from `@iracedeck/pi-components`) before `sdpi-components.js` into every generated PI HTML. The bridge monkeypatches `window.WebSocket` and translates frames both ways, so the shared `sdpi-components`/`ird-*` PI stack works unchanged. (Mirabox/VSD needs no bridge — its host mimics the Elgato PI socket.)
- No `stripHtmlLangPlugin` — UlanziStudio renders PI HTML in QWebEngineView (Chromium), which accepts `<html lang>`.
- No `@elgato/cli` / `pack:plugin` — Ulanzi packaging is not the Elgato `streamdeck pack` flow.

PI framework (web components, EJS partials, compile plugin, `sdpi-components.js`) comes from `@iracedeck/pi-components`, the same shared package Elgato/Mirabox consume. Per-action PI templates, static icons, and template data come from `@iracedeck/iracing-actions`. The `rollup.config.mjs` imports `piTemplatePlugin`, `partialsDir`, and `browserDir` from `@iracedeck/pi-components/build`, copies per-action `icon.svg`/`key.svg` into `com.ulanzi.iracedeck.ulanziPlugin/imgs/actions/<name>/`, and the plugin-level branding icons in `imgs/plugin/` are copied from `iracing-plugin-stream-deck` until a dedicated branding package lands.

## Folder / UUID naming

- Plugin folder: `com.ulanzi.iracedeck.ulanziPlugin` (the `*.ulanziPlugin` suffix is what UlanziStudio scans for; the `com.ulanzi.<plugin>.ulanziPlugin` prefix follows the SDK demo convention).
- Manifest `UUID`: `com.ulanzi.ulanzistudio.iracedeck` (4-segment, == `ULANZI_PLUGIN_UUID`).
- Action UUIDs: `com.ulanzi.ulanzistudio.iracedeck.<action>`.

## Manifest maintenance

`com.ulanzi.iracedeck.ulanziPlugin/manifest.json` is committed and hand-maintained, mirroring the Mirabox action set with the Ulanzi transform above. When adding/removing an action, update this manifest alongside the Elgato and Mirabox manifests. (A throwaway transform script — `scripts/local/gen-ulanzi-manifest.mjs`, gitignored — bootstrapped the initial file from the Mirabox manifest.)

## Build

```bash
pnpm build  # Rollup → com.ulanzi.iracedeck.ulanziPlugin/bin/plugin.js, then npm install in bin/
```

## Unverified on hardware

This plugin builds and is unit-tested at the adapter/bridge layer, but has not yet been validated on real Ulanzi hardware. Open items (see the issue #508 design spec): device-side SVG rendering (icons are passed through as `data:image/svg+xml,...`), Keypad-vs-Encoder detection at `add`, PI-bridge fidelity against UlanziStudio, D200X dial custom feedback layouts, and the exact `Software.MinVersion` / folder-naming. None block the build; all need a D200/D200X to confirm.

## Window Focus

The `window-focus.ts` module is duplicated from `iracing-plugin-stream-deck` / `iracing-plugin-mirabox` rather than shared via `deck-core`, to avoid adding test infrastructure to `deck-core`. Extraction is planned as a follow-up.
