# @iracedeck/iracing-plugin-ulanzi

Ulanzi Deck plugin for iRaceDeck. Registers actions from `@iracedeck/iracing-actions` with UlanziStudio via `@iracedeck/deck-adapter-ulanzi`.

Mirrors the structure of `@iracedeck/iracing-plugin-mirabox` but targets Ulanzi Deck devices (D200 / D200H / Dial / D200X) instead of Mirabox/VSD.

## Key Differences from iracing-plugin-mirabox

- Uses `UlanziPlatformAdapter` instead of `VSDPlatformAdapter`.
- Manifest is the Ulanzi format: `Type:"JavaScript"`, `CodePath:"bin/plugin.js"`, `UUID:"com.iracedeck.sd.core"` (canonical UUIDs reused verbatim — see *Folder / UUID naming* below), per-action `States:[{Image}]`, and `Controllers:["Keypad"]` for **every** action — dial declarations were removed in #786 until dial input is verified on Ulanzi hardware (when re-enabling, a dial-capable action declares `Controllers:["Keypad","Encoder"]` plus `Encoder:{layout:"$UA1"}`; `"Knob"` (Mirabox) → `"Encoder"`). The Stream-Dock-293S `"Information"` controller has no Ulanzi equivalent and is dropped (Session Info / Telemetry Display become Keypad-only). No top-level `PropertyInspectorPath` (not in the Ulanzi manifest schema) — plugin-global settings are reached through each action's PI.
- **PI connection bridge.** Ulanzi's PI does not call `connectElgatoStreamDeckSocket` and speaks its own URL-param + `cmd` WebSocket protocol, so the rollup injects `ulanzi-pi-bridge.js` (from `@iracedeck/pi-components`) before `sdpi-components.js` into every generated PI HTML except `settings-window.html`, which gets the settings-window bridge instead — two bridges must never share a page (#992). The bridge monkeypatches `window.WebSocket` and translates frames both ways, so the shared `sdpi-components`/`ird-*` PI stack works unchanged. Since #993 phase 2 it also runs the shared settings-channel router: one plugin-scoped bootstrap read of `_settingsChannel` from the host copy (which the plugin mirrors there once per start), then every `getGlobalSettings`/`setGlobalSettings` goes to the plugin's loopback settings server — so PI edits reach the plugin-owned settings file — with a 3 s fallback to the host path if UlanziStudio never answers that read (the open question a community tester has to settle). (Elgato/Mirabox need no *connection* bridge — their hosts speak the Elgato PI socket — but their action PIs get `pi-settings-bridge.js` for the same settings routing.)
- No `stripHtmlLangPlugin` — UlanziStudio renders PI HTML in QWebEngineView (Chromium), which accepts `<html lang>`.

PI framework (web components, EJS partials, compile plugin, `sdpi-components.js`) comes from `@iracedeck/pi-components`, the same shared package Elgato/Mirabox consume. Per-action PI templates, static icons, and template data come from `@iracedeck/iracing-actions`. The `rollup.config.mjs` imports `piTemplatePlugin`, `partialsDir`, and `browserDir` from `@iracedeck/pi-components/build`, copies per-action `icon.svg`/`key.svg` into `com.ulanzi.iracedeck.ulanziPlugin/imgs/actions/<name>/`, and the plugin-level branding icons in `imgs/plugin/` are copied from `iracing-plugin-stream-deck` until a dedicated branding package lands.

## Folder / UUID naming

- Plugin folder: `com.ulanzi.iracedeck.ulanziPlugin` — installed into `…/UlanziDeck/Plugins/` (the user/third-party plugin dir; `…/System/Plugins/` holds first-party ones). The `*.ulanziPlugin` suffix is what UlanziStudio scans for; the `com.ulanzi.<name>.ulanziPlugin` form matches the installed first-party plugins (obsstudio, lightmaster). Folder name and manifest UUID are independent (the installed plugins' folders and UUIDs differ), so the folder keeps the host's install convention while the UUID is iRaceDeck's own.
- Manifest `UUID`: `com.iracedeck.sd.core` (== `PLUGIN_UUID` in `@iracedeck/deck-adapter-ulanzi`) with action UUIDs `com.iracedeck.sd.core.<action>` — the same canonical UUIDs the Elgato/Mirabox plugins use, declared verbatim with no remapping. UlanziStudio only checks for 4 dot-segments, not the prefix.

## Manifest maintenance

`com.ulanzi.iracedeck.ulanziPlugin/manifest.json` is committed and hand-maintained, mirroring the Mirabox action set with the Ulanzi transform above. When adding/removing an action, update this manifest alongside the Elgato and Mirabox manifests, keeping the `Actions` array alphabetical by display `Name` (the host renders them in array order). `scripts/manifest-actions-order.test.mjs` discovers every plugin manifest dynamically and enforces sorted order, name uniqueness, and cross-manifest action-set parity — ecosystem-specific actions (`ECOSYSTEM_SPECIFIC_ACTIONS`, currently the Elgato-only "Switch Profile") are exempt from the parity check only. (A throwaway transform script — `scripts/local/gen-ulanzi-manifest.mjs`, gitignored — bootstrapped the initial file from the Mirabox manifest.)

**Image paths carry explicit file extensions** (`imgs/plugin/marketplace.png`, `imgs/actions/<name>/icon.svg`, `imgs/actions/<name>/key.svg`) — unlike the Elgato manifest convention, UlanziStudio resolves image paths literally and does not probe for `.png`/`.svg`/`@2x` variants, so an extensionless reference shows no icon (e.g. in the Settings > Plugins list, #845). `scripts/ulanzi-manifest-images.test.mjs` enforces the extension and that every reference resolves to its committed source (per-action icons in `@iracedeck/iracing-actions`, plugin branding in the Elgato plugin's `imgs/plugin/` — the rollup copy sources).

## Build

```bash
pnpm build  # Rollup → com.ulanzi.iracedeck.ulanziPlugin/bin/plugin.js, then npm install in bin/
```

## Packaging

No local `pack:plugin` script; CI packages the Ulanzi plugin in `.github/workflows/release-pack.yml` (the same workflow that packs the other two plugins) with `@elgato/cli pack` — it accepts the `.ulanziPlugin` folder and preserves the inner folder name. A committed `.sdignore` in the plugin folder strips native-module build cruft (~41 MB → ~7 MB), and the cli's `undefined.streamDeckPlugin` output is renamed to `com.ulanzi.iracedeck.ulanziPlugin.zip`. CI builds the monorepo once, then packs each plugin into its own `-o` subdir (Stream Deck and Mirabox share a UUID and would otherwise collide).

## Dev deploy / test

The whole cycle is three commands (#1040), and **the order is load-bearing** — see the lock gotcha below:

```bash
pnpm stop:ulanzi && pnpm switch-test-env:ulanzi && pnpm start:ulanzi
```

`link:ulanzi` creates a directory **junction** from UlanziStudio's plugins directory to the built `com.ulanzi.iracedeck.ulanziPlugin` folder in this worktree, so a rebuild needs no re-copy. The destination defaults to `%APPDATA%\Ulanzi\UlanziDeck\Plugins` on Windows; override with `ULANZI_PLUGINS_DIR` in a gitignored `.env.local` at the repo root. `ULANZI_APP_PATH` overrides the host executable that `start:ulanzi` / `stop:ulanzi` drive.

| Script | Action |
|---|---|
| `pnpm link:ulanzi` | Create the junction (fails fast if anything already exists there). |
| `pnpm unlink:ulanzi` | Remove it (safe to run when not linked). |
| `pnpm relink:ulanzi` | Unlink + link. |
| `pnpm switch-test-env:ulanzi` | `pnpm install && pnpm build && pnpm relink:ulanzi`. |
| `pnpm start:ulanzi` / `stop:ulanzi` | Start/stop UlanziStudio. `start` prints which worktree the junction points at. |

**The junction points at exactly ONE worktree** — the same trap as the Stream Deck link. Whoever ran `link:ulanzi` last owns the host, so "my fix isn't working" is usually the host serving another checkout; `start:ulanzi` prints the target for exactly this reason.

**First run on a machine with a packaged install:** the installed folder is a real directory rather than a link, so the first `unlink:ulanzi` **moves it aside** to `com.ulanzi.iracedeck.ulanziPlugin.replaced-<timestamp>` instead of deleting it, and says where it went. The suffix deliberately breaks the host's `*.ulanziPlugin` scan pattern so the stale copy is never loaded as a second plugin — delete it yourself once you're sure you don't need it. It is not deleted automatically because it carries the plugin's own `log/` files, which are routinely the evidence someone is mid-diagnosis on, and because `relink` runs inside `switch-test-env`, where any printed warning scrolls past thousands of build lines unread. Once linked, logs land in the worktree instead.

**Native-module lock gotcha:** while UlanziStudio (or Stream Deck) is running, it locks the native `iracing_native.node`, so a full `pnpm build` fails with EPERM. This is why `stop:ulanzi` comes **before** `switch-test-env:ulanzi` and not just before the relink — stopping the host at the relink step is too late, the build has already failed. UlanziStudio also reads its plugins directory at start only, so a relink without a restart changes nothing.

## Validation status

Validated live in UlanziDeck (the desktop host): the plugin loads, the WebSocket connects (handshake + argv layout `address port language`), the global-settings read/write round-trips, the PI bridge drives `sdpi-components`, the **SVG data-URI icons render**, and key presses dispatch to actions. The earlier known-unknowns (manifest format, the 4-segment UUID, the wire protocol, the PI bridge, SVG passthrough) are therefore confirmed, not deferred.

Still to exercise on a physical device: dial input end-to-end (the manifest declares no `Encoder` controllers until this is verified — #786), D200X dial custom feedback layouts (no SDK `setFeedback` method — rich dial-slot display is deferred), Keypad-vs-Encoder detection at `add` (defaults to Keypad), and per-device behaviour across the four supported device models. None block the build.

Still to verify in the UlanziStudio host (no device needed): the #845 fixes — the plugin-list icon (manifest image paths now carry explicit extensions) and PI external links (relayed out the plugin socket via the `sendToPlugin` openUrl marker). Both were authored blind against first-party plugin conventions and the observed working plugin-socket `openurl` path.

## Window Focus

Window focusing lives in `@iracedeck/deck-core` (`initWindowFocus` / `focusIRacingIfEnabled`); `plugin.ts` injects the native focuser. It was previously duplicated per plugin as `src/shared/window-focus.ts` — extracted in #930, which is why this package no longer has a `src/shared/` folder. `plugin.ts` also injects the native pointer mover via `initMousePointer` (#926), for the View Adjustment **Mouse to Sim** mode.
