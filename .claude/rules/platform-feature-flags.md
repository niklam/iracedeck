# Platform Feature Flags

Per-plugin build-time flags that gate features dependent on SVG rendering-engine capabilities. Used to strip unsupported code and PI controls from the Mirabox bundle (QT5) — and conservatively from the Ulanzi bundle (renderer unverified) — while keeping them on Stream Deck (QT6.7+).

## Layout

- `packages/iracing-plugin-stream-deck/platform-features.json` — committed Stream Deck flags (all true by default).
- `packages/iracing-plugin-mirabox/platform-features.json` — committed Mirabox flags (QT5-incompatible features off).
- `packages/iracing-plugin-ulanzi/platform-features.json` — committed Ulanzi flags. Kept at the Mirabox conservative baseline (filters/masks/patterns off): basic SVG data-URI icons are confirmed to render in UlanziDeck (issue #508), but filters/masks/patterns haven't been exercised — widen a flag only once that feature is confirmed on Ulanzi.
- `feature-flags.local.json` — **optional, gitignored** developer override at repo root. Deep-merges over every plugin's committed flags at build time.
- `feature-flags.local.json.example` — committed example showing the file shape.

## Flag categories

- **Capabilities** (`capabilities.*`) — raw SVG engine support (`svgFilters`, `svgMasks`, `svgPatterns`). These are the source of truth.
- **Features** (`features.*`) — product-level flags. Current flags:
  - `borderGlow` — SVG-filter border glow (depends on `svgFilters`). Elgato `true`, Mirabox `false`.
  - `dialFeedback` — Stream Deck+ touch-strip feedback + touch-tap input (Elgato-only; Mirabox/Ulanzi have no plugin touch strip). Elgato `true`, Mirabox `false`.

  When adding a new feature that requires a capability, document the dependency in the flag name or a comment.

  > **Note.** There is no dial long-press flag. Dial press / long-press / push+turn are classified at `dialUp` by a duration comparison (`classifyDialRelease` in `packages/deck-core/src/dial-gesture.ts`), with no `setTimeout` to gate, so they work cross-platform with no feature flag. The former `dialLongPress` / `__FEATURE_DIAL_LONG_PRESS__` flag has been removed.

## How flags reach runtime + PI

Both plugins' `rollup.config.mjs`:

1. Read their `platform-features.json`.
2. If `feature-flags.local.json` exists at the repo root, deep-merge it on top.
3. Feed the merged object to three consumers:
   - `@rollup/plugin-replace` — injects `__CAPABILITY_SVG_FILTERS__`, `__CAPABILITY_SVG_MASKS__`, `__CAPABILITY_SVG_PATTERNS__`, `__FEATURE_BORDER_GLOW__`, `__FEATURE_DIAL_FEEDBACK__` as JSON-stringified boolean literals. Terser then tree-shakes the dead branches.
   - `emit-plugin-config` — writes the merged object as `featureFlags` in `/bin/config.json` (readable via `getFeatureFlag()` / `getPlatformFeatures()`).
   - `piTemplatePlugin` — passes the object to EJS render context as `platform` (and `locals.platform`).

## Using a flag in code

Ambient globals are declared in `packages/icon-composer/src/platform-features.d.ts`. Reference the `__FEATURE_*__` constant directly:

```ts
// packages/icon-composer/src/icon-base.ts
if (!border.glowEnabled || !__FEATURE_BORDER_GLOW__) {
  return { defs: "", rects: borderRect };
}
```

Put the gating in shared `icon-composer` / `deck-core` utilities — **not in individual action files**. Actions call the utilities and stay platform-agnostic.

**Exception — dial touch-strip gating.** The "not in actions" rule is about SVG-*rendering* gating. The per-platform touch-strip difference is the documented exception: an action gates it directly on `__FEATURE_DIAL_FEEDBACK__` (touch-strip feedback + touch-tap, Elgato-only) because the difference is action logic, not shared rendering. Dial press / long-press / push+turn are **not** gated — they are classified at `dialUp` and work cross-platform. Reference: `packages/iracing-actions/src/actions/fuel-dial/fuel-dial.ts`. See `.claude/rules/encoders-and-touchscreen.md` for why.

**Per-plugin ambient declarations for bundled action sources.** The shared `@iracedeck/iracing-actions` sources are compiled as part of each plugin's TypeScript program, so the `__FEATURE_*__` constants must be declared there too. Each plugin therefore carries its own `src/platform-features.d.ts` (mirroring `src/svg.d.ts`) duplicating the ambient declarations in `packages/icon-composer/src/platform-features.d.ts` — without it the bundled action gating fails to type-check.

For resolved settings, force the flag's state so downstream callers don't see the feature enabled:

```ts
// packages/icon-composer/src/title-settings.ts — resolveBorderSettings
glowEnabled:
  __FEATURE_BORDER_GLOW__ &&
  resolve(actionOverrides?.glowEnabled, globalBorderSettings.glowEnabled, undefined, BORDER_DEFAULTS.glowEnabled),
```

## Using a flag in PI templates

Gate `sdpi-item` controls and any related JS in the shared partial:

```ejs
<% var borderGlowEnabled = (locals.platform?.features?.borderGlow !== false); %>
<% if (borderGlowEnabled) { %>
  <sdpi-item id="ird-border-glow" class="hidden" label="Show Glow">...</sdpi-item>
<% } %>
```

The `!== false` check makes the default-enabled behavior explicit: when a caller doesn't set `platformFeatures` (e.g., tests), the control still renders.

## Runtime access (rare)

Most code should use the compile-time constants. If a runtime check is genuinely needed:

```ts
import { getFeatureFlag, getPlatformFeatures } from "@iracedeck/deck-core";

if (getFeatureFlag("borderGlow") === true) { /* ... */ }
const all = getPlatformFeatures(); // full object or undefined
```

Runtime checks don't participate in tree-shaking — prefer the compile-time constants when the decision can be made at build time.

## Testing

Root `test-setup.ts` sets `globalThis.__FEATURE_BORDER_GLOW__ = true` (and the capabilities) so tests see the defaults. Cover both paths with `vi.stubGlobal`:

```ts
afterEach(() => vi.unstubAllGlobals());

it("strips glow when flag is false", () => {
  vi.stubGlobal("__FEATURE_BORDER_GLOW__", false);
  // ... assertion
});
```

## Adding a new flag

1. Add to both `platform-features.json` files under `capabilities` or `features` (enabled/disabled per platform).
2. Add the `__CAPABILITY_*__` / `__FEATURE_*__` ambient declaration to `packages/icon-composer/src/platform-features.d.ts` **and** to both plugins' `src/platform-features.d.ts` (so the bundled `@iracedeck/iracing-actions` sources also see it).
3. Add the replace entry to **both** `rollup.config.mjs` files.
4. If it's a new feature, add its key to `PlatformFeatureFlags` in `packages/deck-core/src/plugin-config.ts`.
5. Gate the relevant code in `icon-composer` / `deck-core` utilities and any relevant PI partial.
6. Add default to `test-setup.ts` and true/false path tests that `vi.stubGlobal` the constant.
7. Update the example file (`feature-flags.local.json.example`).

## Watch mode caveat

Rollup loads each plugin config module **once per watcher session**, so the resolved `platformFeatures` object is captured at watcher startup and held for the lifetime of the watcher. Consequences:

- Creating `feature-flags.local.json` while a watcher is running: the file isn't in the watch set yet, and even once a rebuild is triggered by some other change, the resolved flags are still the ones from startup.
- Editing an existing `platform-features.json` or `feature-flags.local.json` while a watcher is running: a rebuild fires (the file is in the watch set), but it uses the flags captured at startup — the edit won't affect the output.

**Always restart the watcher after changing any flag file.** This is a deliberate trade-off: refreshing the flags on every rebuild would require either reinstantiating `@rollup/plugin-replace` (not possible mid-watch) or threading mutable state through `replace`, `piTemplatePlugin`, and `emit-plugin-config`, which adds complexity for a scenario that's already covered by a one-line restart.

## Local override round-trip

```bash
# Force borderGlow off on this machine:
cat > feature-flags.local.json <<'EOF'
{ "features": { "borderGlow": false } }
EOF
pnpm build

# Verify bundle (tree-shaken by @rollup/plugin-replace + terser):
grep -c feGaussianBlur packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/plugin.js   # -> 0
grep -c ird-border-glow packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/plugin.js # -> 0

# Verify PI output (emitted by piTemplatePlugin; `ird-border-glow` is the control id):
grep -R -l ird-border-glow packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui         # -> (no matches)

# Revert:
rm feature-flags.local.json
pnpm build
```

## Related files

- `@.claude/rules/svg-platform-compatibility.md` — which SVG features are safe on each platform.
- `packages/icon-composer/src/icon-base.ts` / `title-settings.ts` — gating for `borderGlow`.
- `packages/pi-components/partials/border-overrides.ejs`, `global-border-defaults.ejs`, `head-common.ejs` — PI glow gating.
- `packages/deck-core/src/plugin-config.ts` — `PluginConfig`, `getFeatureFlag`, `getPlatformFeatures`.
