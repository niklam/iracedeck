/**
 * Plugin Config Singleton
 *
 * Stores build-time plugin configuration (version, future feature flags).
 * Each plugin process has its own instance.
 *
 * Usage:
 * 1. Call initPluginConfig() once at plugin startup with config read from config.json
 * 2. Import getPluginVersion() wherever the version is needed
 */

/**
 * Platform capabilities — SVG rendering engine support.
 * These are the source of truth that feature flags depend on.
 */
export interface PlatformCapabilities {
  svgFilters: boolean;
  svgMasks: boolean;
  svgPatterns: boolean;
}

/**
 * Product-level feature flags that gate user-visible features.
 * Each flag typically depends on one or more capabilities.
 */
export interface PlatformFeatureFlags {
  borderGlow: boolean;
}

export interface PlatformFeatures {
  capabilities: PlatformCapabilities;
  features: PlatformFeatureFlags;
}

export interface PluginConfig {
  version: string;
  platform: string;
  /**
   * Merged platform feature flags written into /bin/config.json at build time
   * (committed platform-features.json deep-merged with optional root
   * feature-flags.local.json). Absent in tests that don't supply it.
   *
   * Runtime consumers should normally rely on the `__FEATURE_*__` and
   * `__CAPABILITY_*__` compile-time constants — this field exists for cases
   * where a runtime check is needed, and for symmetry with version/platform.
   */
  featureFlags?: PlatformFeatures;
}

let config: PluginConfig | null = null;

/**
 * Initialize the plugin config singleton.
 * Should be called once at plugin startup.
 *
 * @param pluginConfig - Config object read from config.json
 * @throws Error if called more than once
 */
export function initPluginConfig(pluginConfig: PluginConfig): void {
  if (config) {
    throw new Error("Plugin config already initialized. initPluginConfig() should only be called once.");
  }

  config = pluginConfig;
}

/**
 * Get the plugin version string (e.g., "1.13.0").
 *
 * @throws Error if initPluginConfig() has not been called
 */
export function getPluginVersion(): string {
  if (!config) {
    throw new Error("Plugin config not initialized. Call initPluginConfig() first.");
  }

  return config.version;
}

/**
 * Get the plugin platform identifier (e.g., "stream-deck", "mirabox").
 *
 * @throws Error if initPluginConfig() has not been called
 */
export function getPluginPlatform(): string {
  if (!config) {
    throw new Error("Plugin config not initialized. Call initPluginConfig() first.");
  }

  return config.platform;
}

/**
 * Check if plugin config has been initialized.
 */
export function isPluginConfigInitialized(): boolean {
  return config !== null;
}

/**
 * Get the full platform feature flags object (capabilities + features) as
 * baked into this build's config.json, or `undefined` if not set.
 *
 * @throws Error if initPluginConfig() has not been called
 */
export function getPlatformFeatures(): PlatformFeatures | undefined {
  if (!config) {
    throw new Error("Plugin config not initialized. Call initPluginConfig() first.");
  }

  return config.featureFlags;
}

/**
 * Check whether a named product feature flag is enabled for this build.
 * Returns `undefined` if feature flags are not present in the config.
 *
 * @throws Error if initPluginConfig() has not been called
 */
export function getFeatureFlag(name: keyof PlatformFeatureFlags): boolean | undefined {
  return getPlatformFeatures()?.features[name];
}

/**
 * Reset the plugin config singleton (for testing only).
 */
export function _resetPluginConfig(): void {
  config = null;
}
