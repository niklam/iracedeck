/**
 * Test setup — declares runtime defaults for the platform feature flag constants
 * that `@rollup/plugin-replace` injects into plugin builds.
 *
 * Tests exercising the `false` path can override via `vi.stubGlobal(name, false)`;
 * `vi.unstubAllGlobals()` restores these defaults.
 */
interface FeatureFlagGlobals {
  __CAPABILITY_SVG_FILTERS__: boolean;
  __CAPABILITY_SVG_MASKS__: boolean;
  __CAPABILITY_SVG_PATTERNS__: boolean;
  __FEATURE_BORDER_GLOW__: boolean;
  __FEATURE_DIAL_FEEDBACK__: boolean;
  __FEATURE_PNG_RASTERIZATION__: boolean;
}

const featureFlagGlobals = globalThis as unknown as FeatureFlagGlobals;
featureFlagGlobals.__CAPABILITY_SVG_FILTERS__ = true;
featureFlagGlobals.__CAPABILITY_SVG_MASKS__ = true;
featureFlagGlobals.__CAPABILITY_SVG_PATTERNS__ = true;
featureFlagGlobals.__FEATURE_BORDER_GLOW__ = true;
featureFlagGlobals.__FEATURE_DIAL_FEEDBACK__ = true;
featureFlagGlobals.__FEATURE_PNG_RASTERIZATION__ = true;
