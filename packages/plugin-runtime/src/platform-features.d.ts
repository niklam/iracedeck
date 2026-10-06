/**
 * Ambient declarations for the build-time platform feature-flag constants that
 * `@rollup/plugin-replace` injects into each plugin bundle (see
 * `.claude/rules/platform-feature-flags.md`). Lives here because plugin-runtime
 * gates `initializeRasterizer` on `__FEATURE_PNG_RASTERIZATION__`, and because
 * this package's program also compiles the bundled `@iracedeck/iracing-actions`
 * sources that gate behind a flag. An ambient `.d.ts` of another package is not
 * part of this program, which is also why each plugin carries its own copy.
 * Mirrors `@iracedeck/iracing-actions/src/platform-features.d.ts`, which the
 * bundled action sources need in their own program (#1078). The former
 * icon-composer copy was removed with the icon feature flags in #642.
 */
declare const __FEATURE_DIAL_EXTENDED_GESTURES__: boolean;
declare const __FEATURE_PNG_RASTERIZATION__: boolean;
