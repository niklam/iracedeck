/**
 * Ambient declarations for the build-time platform feature-flag constants that
 * `@rollup/plugin-replace` injects into this plugin bundle (see
 * `.claude/rules/platform-feature-flags.md`). Lives in the plugin's `src/` so
 * it is part of the plugin's TypeScript program, making the constants visible
 * to the bundled `@iracedeck/iracing-actions` sources that gate behind a flag.
 * Mirrors `@iracedeck/icon-composer/src/platform-features.d.ts`.
 */
declare const __CAPABILITY_SVG_FILTERS__: boolean;
declare const __CAPABILITY_SVG_MASKS__: boolean;
declare const __CAPABILITY_SVG_PATTERNS__: boolean;
declare const __FEATURE_BORDER_GLOW__: boolean;
declare const __FEATURE_DIAL_FEEDBACK__: boolean;
declare const __FEATURE_DIAL_LONG_PRESS__: boolean;
