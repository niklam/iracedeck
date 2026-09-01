/**
 * Ambient declarations for the build-time platform feature-flag constants that
 * `@rollup/plugin-replace` injects into this plugin bundle (see
 * `.claude/rules/platform-feature-flags.md`). Lives in the plugin's `src/` so
 * it is part of the plugin's TypeScript program, making the constants visible
 * to the bundled `@iracedeck/iracing-actions` sources that gate behind a flag.
 * Mirrors `@iracedeck/iracing-actions/src/platform-features.d.ts`, which the
 * bundled action sources need in their own program (#1078). The former
 * icon-composer copy was removed with the icon feature flags in #642.
 */
declare const __FEATURE_DIAL_FEEDBACK__: boolean;
declare const __FEATURE_PNG_RASTERIZATION__: boolean;
