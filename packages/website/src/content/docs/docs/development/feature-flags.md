---
title: Feature Flags
description: How iRaceDeck gates platform-specific features at build time, and how to override flags locally for testing.
---

iRaceDeck ships three plugins — the Elgato Stream Deck plugin, the Mirabox VSD Craft plugin, and the Ulanzi Deck plugin. They share most code, but there are two kinds of reason a feature might need gating: a genuine hardware difference (only Stream Deck+ has a touch strip), or a temporary in-development kill-switch. Icon rendering itself no longer differs by host — since issue #642, every plugin rasterizes its SVG icons to PNG in-plugin (`@iracedeck/rasterizer`, wrapping `@resvg/resvg-js`) before sending pixels to the device, so the old QT5-vs-QT6.7+ SVG engine split that used to justify most of these flags is gone. See [Architecture](/docs/development/architecture/) and `.claude/rules/svg-platform-compatibility.md` (in-repo) for what changed.

Feature flags let us gate those features at **build time**: unsupported code is stripped from the bundle, and Property Inspector controls that would have no effect are hidden. Flags also provide a lightweight way for contributors to test in-development features locally without shipping them to everyone, or to kill a risky in-development pipeline quickly.

## How the flags are structured

Each plugin has a committed `platform-features.json`:

- `packages/iracing-plugin-stream-deck/platform-features.json`
- `packages/iracing-plugin-mirabox/platform-features.json`
- `packages/iracing-plugin-ulanzi/platform-features.json`

The file has one top-level key, `features` — product-level flags. (A `capabilities` key existed before issue #642 to track raw SVG engine support; it was retired once icon rendering moved to in-plugin PNG rasterization, since no code branches on host SVG engine capability anymore.)

Example (Mirabox):

```json
{
  "features": {
    "dialFeedback": false,
    "pngRasterization": true
  }
}
```

## Where the flags take effect

The plugin build pipeline reads the merged flags once and fans them out to three places:

1. **Bundle code** — `@rollup/plugin-replace` substitutes `__FEATURE_DIAL_FEEDBACK__` and `__FEATURE_PNG_RASTERIZATION__` with `true` / `false` at compile time. Terser then drops unreachable branches, so disabled code doesn't ship. `pngRasterization` gates a single call, `initializeRasterizer(...)` in each plugin's `plugin.ts` — when it's `false`, the call (and everything it would have pulled in) is dropped.
2. **Property Inspector HTML** — the same flags are passed into EJS templates as `locals.platform`. Controls wrapped in `<% if (locals.platform?.features?.dialFeedback !== false) { %>` disappear from the compiled HTML. `pngRasterization` gates no PI content — it only guards a plugin-startup call.
3. **Runtime `config.json`** — the merged flags are written to `com.iracedeck.sd.core.sdPlugin/bin/config.json` as a `featureFlags` field. Readable at runtime via `getFeatureFlag("pngRasterization")` / `getPlatformFeatures()` from `@iracedeck/deck-core` if a dynamic check is ever needed.

## Overriding flags locally

For local testing — without editing committed files — create `feature-flags.local.json` at the **repo root**:

```json
{
  "features": {
    "pngRasterization": false
  }
}
```

Each plugin's build deep-merges this file on top of its own committed `platform-features.json`. Any keys you don't include fall through to the committed values. The file is listed in `.gitignore`, so it never lands in a commit.

**You must rebuild for the override to take effect** (`pnpm build` or restart `pnpm watch:*`). There's no runtime reload — flags are baked into the bundle.

**Always restart the watcher after editing a flag file.** Rollup resolves the flags once when its config module loads, and that resolution is held for the lifetime of the watcher — editing `platform-features.json` or `feature-flags.local.json` mid-watch will trigger a rebuild but the output will still reflect the flag values from watcher startup.

Unknown keys in the local file are **ignored with a warning** during the build — watch the console for `[platform-features] feature-flags.local.json has unknown keys (ignored): …` to catch typos.

A committed `feature-flags.local.json.example` at the repo root documents the shape; copy it if you'd like a starting point.

## Typical use cases

- **Test a Mirabox-only scenario on your Stream Deck build.** Set `features.dialFeedback: false` in the local file, rebuild Stream Deck — the touch-strip feedback code and controls disappear from your Stream Deck build too. Flip it back and they return.
- **Compare PNG rasterization against the raw SVG path.** Set `features.pngRasterization: false` in the local file and rebuild — the plugin falls back to sending SVG data URIs straight to the host, exactly as every build did before issue #642. Useful for isolating whether a rendering issue is in the rasterizer or elsewhere.
- **Develop a beta feature locally without shipping it.** (Once issue #363 lands.) Commit the feature with its flag defaulting to `false` everywhere. Testers opt in via `feature-flags.local.json`.

## Current flags

| Flag | Stream Deck | Mirabox | Ulanzi | Purpose |
|------|-------------|---------|--------|---------|
| `dialFeedback` | `true` | `false` | `false` | Stream Deck+ touch-strip feedback + touch-tap input — only Elgato hardware has a plugin-facing touch strip |
| `pngRasterization` | `true` | `true` | `true` | Temporary kill-switch for in-plugin PNG rasterization (`@iracedeck/rasterizer`, issue #642) — `true` everywhere; force it `false` locally to fall back to raw SVG data URIs |

## Adding a new flag

Short version (see the in-repo rule `.claude/rules/platform-feature-flags.md` for full details):

1. Add the flag to all three `platform-features.json` files with the correct per-platform default.
2. Add it to the `PlatformFeatureFlags` interface in `packages/deck-core/src/plugin-config.ts`.
3. Declare the `__FEATURE_*__` ambient global in each of the three plugins' own `src/platform-features.d.ts`.
4. Add a replace entry in **all three** plugin `rollup.config.mjs` files.
5. Gate the affected code (plugin init, `deck-core`, or an action file) and/or PI partials (`locals.platform?.features?.yourFlag !== false`).
6. Seed the default in `test-setup.ts` and cover both the `true` and `false` paths with `vi.stubGlobal`.
