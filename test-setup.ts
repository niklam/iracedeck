/**
 * Test setup — declares runtime defaults for the platform feature flag constants
 * that `@rollup/plugin-replace` injects into plugin builds.
 *
 * Tests exercising the `false` path can override via `vi.stubGlobal(name, false)`;
 * `vi.unstubAllGlobals()` restores these defaults.
 */
interface FeatureFlagGlobals {
  __FEATURE_DIAL_FEEDBACK__: boolean;
  __FEATURE_PNG_RASTERIZATION__: boolean;
}

const featureFlagGlobals = globalThis as unknown as FeatureFlagGlobals;
featureFlagGlobals.__FEATURE_DIAL_FEEDBACK__ = true;
featureFlagGlobals.__FEATURE_PNG_RASTERIZATION__ = true;
