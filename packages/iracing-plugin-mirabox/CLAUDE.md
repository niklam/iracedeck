# @iracedeck/iracing-plugin-mirabox

Mirabox plugin for iRaceDeck. Registers actions from `@iracedeck/iracing-actions` with VSD Craft via `@iracedeck/deck-adapter-mirabox`.

Mirrors the structure of `@iracedeck/iracing-plugin-stream-deck` but targets Mirabox devices instead of Elgato Stream Deck.

## Key Differences from iracing-plugin-stream-deck

- Uses `VSDPlatformAdapter` instead of `ElgatoPlatformAdapter`
- **All actions are Keypad-only in the manifest** — no `"Knob"` declarations (#786). The dial-capable actions (Fuel Service, Setup Brakes, Audio Controls) still bundle their shared dial surfaces from `@iracedeck/iracing-actions`, and the adapter still normalizes knob events, but the manifest withholds the dial controller until knob input is verified on real hardware. When re-enabling, a dial-capable action declares `"Controllers": ["Keypad", "Knob"]` with **no** `Encoder`/`Knob` config block and **no** touch strip — the Stream Dock protocol defines no layouts/`setFeedback`, so touch-strip feedback is unsupported (the Mirabox adapter no-ops it; only the touch strip is gated, by `__FEATURE_DIAL_FEEDBACK__`, `false` here). See `.claude/rules/encoders-and-touchscreen.md`.
- Uses `ws` package for WebSocket communication (VSD bundles Node.js 20)
- `SDKVersion: 2` instead of `3` (initially shipped as `1`, deliberately bumped to `2` in commit `51515173`)

PI framework (web components, EJS partials, compile plugin, `sdpi-components.js`) comes from `@iracedeck/pi-components`, the same shared package the Elgato plugin consumes. Per-action PI templates, static icons, and template data come from `@iracedeck/iracing-actions` (`src/actions/<name>/*.ejs` + `icon.svg` + `key.svg`, and shared `src/actions/data/*.json`). The `rollup.config.mjs` imports `piTemplatePlugin`, `partialsDir`, and `browserDir` from `@iracedeck/pi-components/build`, computes `actionTemplatesDir` locally from the `@iracedeck/iracing-actions` path, and copies per-action `icon.svg`/`key.svg` into `com.iracedeck.sd.core.sdPlugin/imgs/actions/<name>/`. The plugin-level branding icons in `imgs/plugin/` are still copied from `iracing-plugin-stream-deck` until a dedicated branding package lands. Generated HTML is then stripped of the `lang="en"` attribute (`stripHtmlLangPlugin`) because VSD Craft does not accept it.

## Manifest maintenance

`com.iracedeck.sd.core.sdPlugin/manifest.json` is committed and hand-maintained. When adding/removing an action, update this manifest alongside the Elgato and Ulanzi manifests, keeping the `Actions` array alphabetical by display `Name` (the host renders them in array order). `scripts/manifest-actions-order.test.mjs` enforces that all three manifests stay sorted, duplicate-free, and in sync.

## Build

```bash
pnpm build  # Rollup → com.iracedeck.sd.core.sdPlugin/bin/plugin.js
```

## Dev Linking

Unlike the Elgato plugin (which has a first-party `streamdeck link` CLI), Mirabox has no official plugin-link tool and the host app's install path varies by vendor (VSD Craft, other Mirabox-compatible hosts). Use the repo's `*:mirabox` scripts, which create a symlink from the built plugin folder into a per-developer destination read from `MIRABOX_PLUGINS_DIR`.

**One-time setup:**

1. Copy `.env.local.example` to `.env.local` at the repo root (it's gitignored).
2. Set `MIRABOX_PLUGINS_DIR` to your host app's plugins folder, e.g. for VSD Craft on Windows:
   ```env
   MIRABOX_PLUGINS_DIR=C:\Users\you\AppData\Roaming\VSD Craft\Plugins
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

The `window-focus.ts` module is duplicated from `iracing-plugin-stream-deck` rather than shared via `deck-core`, to avoid adding test infrastructure to `deck-core`. Extraction is planned as a follow-up.
