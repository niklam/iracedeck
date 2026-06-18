# @iracedeck/iracing-plugin-ulanzi

Ulanzi Deck plugin for iRaceDeck. Registers actions from `@iracedeck/iracing-actions` with UlanziStudio via `@iracedeck/deck-adapter-ulanzi`.

Mirrors the structure of `@iracedeck/iracing-plugin-mirabox` but targets Ulanzi Deck devices (D200 / D200H / Dial / D200X) instead of Mirabox/VSD.

## Key Differences from iracing-plugin-mirabox

- Uses `UlanziPlatformAdapter` instead of `VSDPlatformAdapter`.
- **Action UUIDs reused verbatim.** UlanziStudio only requires a 4-segment main-service UUID and doesn't validate the prefix, so the plugin uses the canonical `com.iracedeck.sd.core` UUID (the same one the Elgato/Mirabox plugins use) and registers actions under their `com.iracedeck.sd.core.*` UUIDs directly — no remapping, exactly like Mirabox. The manifest declares the same UUIDs.
- Manifest is the Ulanzi format: `Type:"JavaScript"`, `CodePath:"bin/plugin.js"`, `UUID:"com.iracedeck.sd.core"`, per-action `States:[{Image}]`, `Controllers:["Keypad"]`/`["Keypad","Encoder"]`, and `Encoder:{layout:"$UA1"}` for dial-capable actions. `"Knob"` (Mirabox) → `"Encoder"`; the Stream-Dock-293S `"Information"` controller has no Ulanzi equivalent and is dropped (Session Info / Telemetry Display become Keypad-only). No top-level `PropertyInspectorPath` (not in the Ulanzi manifest schema) — plugin-global settings are reached through each action's PI.
- **PI connection bridge.** Ulanzi's PI does not call `connectElgatoStreamDeckSocket` and speaks its own URL-param + `cmd` WebSocket protocol, so the rollup injects `ulanzi-pi-bridge.js` (from `@iracedeck/pi-components`) before `sdpi-components.js` into every generated PI HTML. The bridge monkeypatches `window.WebSocket` and translates frames both ways, so the shared `sdpi-components`/`ird-*` PI stack works unchanged. (Mirabox/VSD needs no bridge — its host mimics the Elgato PI socket.)
- No `stripHtmlLangPlugin` — UlanziStudio renders PI HTML in QWebEngineView (Chromium), which accepts `<html lang>`.
- No `pack:plugin` script, but CI **does** package the Ulanzi plugin with `@elgato/cli pack` (the same tool as the other two plugins — it accepts the `.ulanziPlugin` folder and preserves the inner folder name). A committed `.sdignore` in the plugin folder strips native-module build cruft (~41 MB → ~7 MB), and the cli's `undefined.streamDeckPlugin` output is renamed to `com.ulanzi.iracedeck.ulanziPlugin.zip`. CI builds the monorepo once, then packs each plugin (into its own `-o` subdir, since Stream Deck and Mirabox share a UUID and would otherwise collide). See `.github/workflows/release-pack.yml`.

PI framework (web components, EJS partials, compile plugin, `sdpi-components.js`) comes from `@iracedeck/pi-components`, the same shared package Elgato/Mirabox consume. Per-action PI templates, static icons, and template data come from `@iracedeck/iracing-actions`. The `rollup.config.mjs` imports `piTemplatePlugin`, `partialsDir`, and `browserDir` from `@iracedeck/pi-components/build`, copies per-action `icon.svg`/`key.svg` into `com.ulanzi.iracedeck.ulanziPlugin/imgs/actions/<name>/`, and the plugin-level branding icons in `imgs/plugin/` are copied from `iracing-plugin-stream-deck` until a dedicated branding package lands.

## Folder / UUID naming

- Plugin folder: `com.ulanzi.iracedeck.ulanziPlugin` — installed into `…/UlanziDeck/Plugins/` (the user/third-party plugin dir; `…/System/Plugins/` holds first-party ones). The `*.ulanziPlugin` suffix is what UlanziStudio scans for; the `com.ulanzi.<name>.ulanziPlugin` form matches the installed first-party plugins (obsstudio, lightmaster). Folder name and manifest UUID are independent (the installed plugins' folders and UUIDs differ), so the folder keeps the host's install convention while the UUID is iRaceDeck's own.
- Manifest `UUID`: `com.iracedeck.sd.core` (== `PLUGIN_UUID` in `@iracedeck/deck-adapter-ulanzi`; the same UUID the Elgato/Mirabox plugins use — UlanziStudio only checks for 4 dot-segments, not the prefix).
- Action UUIDs: `com.iracedeck.sd.core.<action>` (the canonical iRaceDeck UUIDs, declared verbatim).

## Manifest maintenance

`com.ulanzi.iracedeck.ulanziPlugin/manifest.json` is committed and hand-maintained, mirroring the Mirabox action set with the Ulanzi transform above. When adding/removing an action, update this manifest alongside the Elgato and Mirabox manifests. (A throwaway transform script — `scripts/local/gen-ulanzi-manifest.mjs`, gitignored — bootstrapped the initial file from the Mirabox manifest.)

## Build

```bash
pnpm build  # Rollup → com.ulanzi.iracedeck.ulanziPlugin/bin/plugin.js, then npm install in bin/
```

## Validation status

Validated live in UlanziDeck (the desktop host): the plugin loads, the WebSocket connects (handshake + argv layout `address port language`), the global-settings read/write round-trips, the PI bridge drives `sdpi-components`, the **SVG data-URI icons render**, and key presses dispatch to actions. The earlier known-unknowns (manifest format, the 4-segment UUID, the wire protocol, the PI bridge, SVG passthrough) are therefore confirmed, not deferred.

Still to exercise on a physical device: D200X dial custom feedback layouts (no SDK `setFeedback` method — dial *input* works, but rich dial-slot display is deferred), Keypad-vs-Encoder detection at `add` (defaults to Keypad), and per-device behaviour across D200 / D200H / Dial / D200X. None block the build.

## Window Focus

The `window-focus.ts` module is duplicated from `iracing-plugin-stream-deck` / `iracing-plugin-mirabox` rather than shared via `deck-core`, to avoid adding test infrastructure to `deck-core`. Extraction is planned as a follow-up.
