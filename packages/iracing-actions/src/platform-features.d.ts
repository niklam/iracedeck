/**
 * Ambient declarations for the build-time platform feature-flag constants that
 * `@rollup/plugin-replace` injects into each plugin bundle (see
 * `.claude/rules/platform-feature-flags.md`). Action sources in this package
 * gate behaviour on them, so they must be declared in this package's own
 * program as well as in each plugin's — see the note in `svg.d.ts` for why the
 * duplication is necessary rather than lazy.
 */
declare const __FEATURE_DIAL_FEEDBACK__: boolean;
declare const __FEATURE_PNG_RASTERIZATION__: boolean;
