# @iracedeck/iracing-plugin-mirabox

Mirabox plugin for iRaceDeck. Registers actions from `@iracedeck/iracing-actions` with VSD Craft via `@iracedeck/deck-adapter-mirabox`.

Mirrors the structure of `@iracedeck/iracing-plugin-stream-deck` but targets Mirabox devices instead of Elgato Stream Deck.

## Key Differences from iracing-plugin-stream-deck

- Uses `VSDPlatformAdapter` instead of `ElgatoPlatformAdapter`
- **No dial controllers in the manifest** — no `"Knob"` declarations anywhere (#786); the shared dial code still ships, but the manifest withholds the dial controller until knob input is verified on real hardware. Re-enabling shape and touch-strip limits: `.claude/rules/encoders-and-touchscreen.md`.
- Session Info and Telemetry Display declare `"Controllers": ["Keypad", "Information"]` — Stream Dock's `Information` controller is a read-only info-display area with no Elgato equivalent. Every other action is `["Keypad"]`.
- Uses `ws` package for WebSocket communication (VSD bundles Node.js 20)
- `SDKVersion: 2` instead of `3` (initially shipped as `1`, deliberately bumped to `2` in commit `51515173`)

The PI framework setup (templates, partials, browser assets, rollup wiring) follows `.claude/rules/pi-templates.md`. Package-local specifics: generated PI HTML is stripped of the `lang="en"` attribute (`stripHtmlLangPlugin` in `rollup.config.mjs`) because VSD Craft does not accept it, and the plugin-level branding icons in `imgs/plugin/` are still copied from `iracing-plugin-stream-deck` until a dedicated branding package lands.

## Manifest maintenance

`com.iracedeck.sd.core.sdPlugin/manifest.json` is committed and hand-maintained. When adding/removing an action, update this manifest alongside the Elgato and Ulanzi manifests, keeping the `Actions` array alphabetical by display `Name` (the host renders them in array order). `scripts/manifest-actions-order.test.mjs` discovers every plugin manifest dynamically and enforces sorted order, name uniqueness, and cross-manifest action-set parity — ecosystem-specific actions (`ECOSYSTEM_SPECIFIC_ACTIONS`, currently the Elgato-only "Switch Profile") are exempt from the parity check only, which is the mechanism to use when adding an action that ships on a single ecosystem.

## Build

```bash
pnpm build  # Rollup → com.iracedeck.sd.core.sdPlugin/bin/plugin.js, then npm install in bin/
```

`pnpm build` is `rollup -c && npm run postbuild`; the `postbuild` step runs `npm install` inside `com.iracedeck.sd.core.sdPlugin/bin/` to install the runtime dependencies of the emitted `package.json`. That emitted `package.json` (the `emit-module-package-file` plugin in `rollup.config.mjs`) pins `ws` to its own version (currently `8.18.2`) independently of the workspace dependency (currently `8.21.0`) — when bumping `ws`, update both or the shipped runtime silently stays on the old version.

## Packaging

- `pnpm pack:plugin` packs locally with `streamdeck pack --force --ignore-validation` (the manifest isn't Elgato-valid) into `local/` and renames the output to `com.iracedeck.sd.core.sdPlugin`. **Destructive side effect:** the script then `rimraf`s `com.iracedeck.sd.core.sdPlugin/assets/audio`, so the local audio assets are gone after packing — run `pnpm build` again before the next dev run.
- Release packing is done by CI: `.github/workflows/release-pack.yml` builds the monorepo once and packs all plugins, Mirabox included.

## Dev Linking

Unlike the Elgato plugin (which has a first-party `streamdeck link` CLI), Mirabox has no official plugin-link tool. Use the repo's `*:mirabox` scripts, which create a symlink from the built plugin folder into the host app's plugins directory. On Windows the destination defaults to the standard HotSpot StreamDock install path (`%APPDATA%\HotSpot\StreamDock\plugins`) — no setup needed.

**To target a different host app** (e.g. VSD Craft or another vendor's build), override the destination:

1. Copy `.env.local.example` to `.env.local` at the repo root (it's gitignored).
2. Set `MIRABOX_PLUGINS_DIR` to your host app's plugins folder:
   ```env
   MIRABOX_PLUGINS_DIR=C:\path\to\your\host\plugins
   ```

**Scripts:**

| Script | Action |
|---|---|
| `pnpm link:mirabox`            | Create the symlink (fails fast if one exists). |
| `pnpm unlink:mirabox`          | Remove the symlink (safe to run when not linked). |
| `pnpm relink:mirabox`          | Unlink + link. Useful after recreating the folder. |
| `pnpm switch-test-env:mirabox` | `pnpm install && pnpm build && pnpm relink:mirabox`. |

On Windows, `link:mirabox` creates a directory **junction** (via `fs.symlinkSync(..., "junction")`), which does not require admin/developer mode.

## Window Focus

The duplicated `window-focus.ts` module is **gone** (#926): window focus now lives in `deck-core`'s `window-service.ts`, which also owns the mouse-pointer placement the View Adjustment **Mouse to Sim** mode needs. `plugin.ts` wires it with `initializeWindowService(...)`, injecting `native.focusIRacingWindow()` and `native.moveMouseToIRacingWindow()`, and registers the same `focusIRacingIfEnabled()` key/dial listeners as before — imported from `@iracedeck/deck-core`.
