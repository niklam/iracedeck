# @iracedeck/app-constants

The constants every layer shares, and the Property Inspector's browser bundle with them (spec #1351). Zero dependencies.

## What it owns

- Setting-key names: `PI_WARNINGS_KEY`, `PROFILE_CAPTURE_STATUS_KEY`, the voice-pack keys (`VOICE_PACKS_KEY`, `VOICE_LABELS_KEY`, `VOICE_PACK_STATUS_KEY`), `ENSURED_VOICE_PACK_ID`, and the catalog's dev-base-url key with the published catalog location (`voice-pack-catalog-location.ts`).
- Value sets: the voice-pack status payload and its phases and verdicts (`voice-pack-status.ts`), the changelog notification policies and their default (`changelog-policy.ts`), the Focus iRacing Window modes (`focus-iracing-mode.ts`), the Mouse to Sim pointer anchors and defaults (`sim-pointer-target.ts`).
- Settings-window names: `SETTINGS_WINDOW_HTML` and the two warning ids (`settings-window-ids.ts`).
- The `_warnings` record shape: `PiWarning` (`{ id, level, message }`) and `PiWarningLevel`, derived from `PI_WARNING_LEVELS` (the one list `settings`' record schema and the reader's filter also use), beside `PI_WARNINGS_KEY` in `pi-warnings-constants.ts` (#1366, moved from `@iracedeck/settings`' `pi-warnings.ts`). The writers in `settings`, the evaluators in `settings`, `deck-core`, `deck-iracing` and `voice-packs`, and `pi-components`' `ird-warnings` reader name this one type; the reader's own `WarningRecord` / `WarningLevel` copy was deleted.
- The key map and the default-binding parser the PI and the plugin share (`key-binding-defaults.ts`, #1277). Every lookup goes through a `Map`, so `Object.prototype` names (`constructor`, `__proto__`, `toString`) are never keys, codes or modifier aliases.

Three pins over these values live outside the package, because it may depend on no other package and its tests have no Node typings to read another package's files with: deck-core's `mouse-pointer-service.test.ts` holds the default pointer anchors and offsets to the pre-#1029 placement (`DEFAULT_POINTER_X_FRACTION` / `_Y_FRACTION`), deck-core's `sim-pointer-target.partial.test.ts` holds the settings-window control's `default=` attributes to the same constants, and pi-components' `key-binding-input.default-save.test.ts` holds a seeded default byte-identical to the one the binding field saves.

Every name has one import path: `@iracedeck/app-constants`. deck-core re-exports none of them, so an importer never has to guess which package a mock must cover. Key names and values are persisted or run-scoped contracts, and a value never changes here. `persisted-values.test.ts` pins the setting-key names, the ids, the value sets and the catalog location. It does not pin the key map: the `KEY_CODE_MAP` identifiers and the modifier names are stored inside every saved binding too, so changing one breaks stored bindings even though no test goes red.

## Admission rule

Constants, types, and pure functions over them — nothing else. The rule is enforced, not conventional:

- `tsconfig.json` sets `lib: ["es2022"]` and `types: []`, so any Node global (`process`, `Buffer`) or DOM global (`document`, `window`, even `URL`) fails `pnpm typecheck`. Do not add `@types/node` or the `dom` lib.
- `admission.test.ts` refuses every import: the barrel `index.ts` may only re-export the package's own modules (`./<name>.js`), and every other module imports nothing, types included. It also requires every module to be exported by the barrel. Tests read sources through `import.meta.glob` rather than `node:fs`, because Node typings in one test file would apply to the whole program.

Something that touches timers, `AbortController` or I/O belongs in `@iracedeck/fetch-utils` or a layer above, not here.

## Who imports it

settings, deck-core, deck-iracing, voice-packs, plugin-runtime and iracing-actions import it directly, and `plugin-build` reads `SETTINGS_WINDOW_HTML` from it at build time to pick out the page that gets the settings-window bridge. Browser code does too: `pi-components` bundles it into the Property Inspector, and its Rollup guard admits exactly two workspace packages, each by its bare name — this one and `@iracedeck/fetch-utils` — and refuses every other `@iracedeck/` import, any subpath of either included.
