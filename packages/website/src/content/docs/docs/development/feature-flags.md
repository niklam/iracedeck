---
title: Feature Flags
description: How iRaceDeck gates platform-specific features at build time, and how to override flags locally for testing.
---

iRaceDeck ships three plugins — the Elgato Stream Deck plugin, the Mirabox VSD Craft plugin, and the Ulanzi Deck plugin. They share most code, but the hosts use different SVG engines (Stream Deck is QT 6.7+, Mirabox is QT 5), so some features work on one platform and are silently ignored on the other. The Ulanzi plugin stays on the same conservative QT5 baseline as Mirabox until its renderer's support for those features is confirmed on hardware.

Feature flags let us gate those features at **build time**: unsupported code is stripped from the bundle, and Property Inspector controls that would have no effect are hidden. Flags also provide a lightweight way for contributors to test in-development features locally without shipping them to everyone.

## How the flags are structured

Each plugin has a committed `platform-features.json`:

- `packages/iracing-plugin-stream-deck/platform-features.json`
- `packages/iracing-plugin-mirabox/platform-features.json`
- `packages/iracing-plugin-ulanzi/platform-features.json`

The file has two top-level keys:

- **`capabilities`** — raw SVG engine support (`svgFilters`, `svgMasks`, `svgPatterns`). Source of truth.
- **`features`** — product-level flags that depend on one or more capabilities (e.g., `borderGlow`). These are the ones you'll typically toggle.

Example (Mirabox, glow disabled):

```json
{
  "capabilities": {
    "svgFilters": false,
    "svgMasks": false,
    "svgPatterns": false
  },
  "features": {
    "borderGlow": false
  }
}
```

## Where the flags take effect

The plugin build pipeline reads the merged flags once and fans them out to three places:

1. **Bundle code** — `@rollup/plugin-replace` substitutes `__FEATURE_BORDER_GLOW__` with `true` / `false` at compile time. Terser then drops unreachable branches, so disabled code doesn't ship.
2. **Property Inspector HTML** — the same flags are passed into EJS templates as `locals.platform`. Controls wrapped in `<% if (locals.platform?.features?.borderGlow !== false) { %>` disappear from the compiled HTML.
3. **Runtime `config.json`** — the merged flags are written to `com.iracedeck.sd.core.sdPlugin/bin/config.json` as a `featureFlags` field. Readable at runtime via `getFeatureFlag("borderGlow")` / `getPlatformFeatures()` from `@iracedeck/deck-core` if a dynamic check is ever needed.

## Overriding flags locally

For local testing — without editing committed files — create `feature-flags.local.json` at the **repo root**:

```json
{
  "features": {
    "borderGlow": false
  }
}
```

Each plugin's build deep-merges this file on top of its own committed `platform-features.json`. Any keys you don't include fall through to the committed values. The file is listed in `.gitignore`, so it never lands in a commit.

**You must rebuild for the override to take effect** (`pnpm build` or restart `pnpm watch:*`). There's no runtime reload — flags are baked into the bundle.

**Always restart the watcher after editing a flag file.** Rollup resolves the flags once when its config module loads, and that resolution is held for the lifetime of the watcher — editing `platform-features.json` or `feature-flags.local.json` mid-watch will trigger a rebuild but the output will still reflect the flag values from watcher startup.

Unknown keys in the local file are **ignored with a warning** during the build — watch the console for `[platform-features] feature-flags.local.json has unknown keys (ignored): …` to catch typos.

A committed `feature-flags.local.json.example` at the repo root documents the shape; copy it if you'd like a starting point.

## Typical use cases

- **Test a Mirabox-only scenario on your Stream Deck build.** Set `features.borderGlow: false` in the local file, rebuild Stream Deck — the glow code and controls disappear from your Stream Deck build too. Flip it back and they return.
- **Develop a beta feature locally without shipping it.** (Once issue #363 lands.) Commit the feature with its flag defaulting to `false` everywhere. Testers opt in via `feature-flags.local.json`.
- **Strip an unsupported capability** when experimenting with a new host or SVG engine — set the relevant `capabilities.*` flag to `false` and see what still works.

## Current flags

| Flag | Category | Stream Deck | Mirabox | Ulanzi | Purpose |
|------|----------|-------------|---------|--------|---------|
| `svgFilters` | capability | `true` | `false` | `false` | SVG `<filter>` support (required by `feGaussianBlur`, etc.) |
| `svgMasks` | capability | `true` | `false` | `false` | SVG `<mask>` support |
| `svgPatterns` | capability | `true` | `false` | `false` | SVG `<pattern>` support |
| `borderGlow` | feature | `true` | `false` | `false` | The glow halo around border overlays — uses `feGaussianBlur` and only renders on Stream Deck |

## Adding a new flag

Short version (see the in-repo rule `.claude/rules/platform-feature-flags.md` for full details):

1. Add the flag to all three `platform-features.json` files with the correct per-platform default.
2. For a new `features.*` flag, add it to the `PlatformFeatureFlags` interface in `packages/deck-core/src/plugin-config.ts`. For a new `capabilities.*` flag, add it to the `PlatformCapabilities` interface in the same file.
3. Declare the `__FEATURE_*__` or `__CAPABILITY_*__` ambient global in `packages/icon-composer/src/platform-features.d.ts`.
4. Add a replace entry in **all three** plugin `rollup.config.mjs` files.
5. Gate the affected code and/or PI partials (`locals.platform?.features?.yourFlag !== false`, or `locals.platform?.capabilities?.yourCapability` for capability checks).
6. Seed the default in `test-setup.ts` and cover both the `true` and `false` paths with `vi.stubGlobal`.
