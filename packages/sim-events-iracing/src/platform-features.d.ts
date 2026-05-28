/**
 * Ambient declaration for the build-time feature-flag constant consumed by the
 * translator's position-telemetry dump (issue #603). Each plugin's
 * `@rollup/plugin-replace` substitutes it at bundle time; the root
 * `test-setup.ts` seeds it `false` for vitest.
 *
 * Declared HERE rather than in `icon-composer/src/platform-features.d.ts` (where
 * the other `__FEATURE_*__` / `__CAPABILITY_*__` flags live) because this is the
 * only package that references it. The flags are GLOBAL ambient declarations, so
 * declaring the same name in two packages that a plugin both depends on would
 * surface a duplicate-identifier error in that plugin's type-check.
 */
declare const __FEATURE_TELEMETRY_POSITION_DUMP__: boolean;
