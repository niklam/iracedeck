/**
 * Test setup — declares runtime defaults for the platform feature flag constants
 * that `@rollup/plugin-replace` injects into plugin builds.
 *
 * Tests exercising the `false` path can override via `vi.stubGlobal(name, false)`;
 * `vi.unstubAllGlobals()` restores these defaults.
 */
interface FeatureFlagGlobals {
  /** the Stream Deck+ extended-gesture flag */
  __FEATURE_DIAL_EXTENDED_GESTURES__: boolean;
  __FEATURE_PNG_RASTERIZATION__: boolean;
}

const featureFlagGlobals = globalThis as unknown as FeatureFlagGlobals;
featureFlagGlobals.__FEATURE_DIAL_EXTENDED_GESTURES__ = true;
featureFlagGlobals.__FEATURE_PNG_RASTERIZATION__ = true;
