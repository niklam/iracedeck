# @iracedeck/app-constants

The constants every layer shares, and the Property Inspector's browser bundle with them (spec #1351). Zero dependencies.

## What it owns

- Setting-key names: `PI_WARNINGS_KEY`, `PROFILE_CAPTURE_STATUS_KEY`, the voice-pack keys (`VOICE_PACKS_KEY`, `VOICE_LABELS_KEY`, `VOICE_PACK_STATUS_KEY`), `ENSURED_VOICE_PACK_ID`, and the catalog's dev-base-url key with the published catalog location (`voice-pack-catalog-location.ts`).
- Value sets: the voice-pack status payload and its phases and verdicts (`voice-pack-status.ts`), the changelog notification policies and their default (`changelog-policy.ts`), the Focus iRacing Window modes (`focus-iracing-mode.ts`), the Mouse to Sim pointer anchors and defaults (`sim-pointer-target.ts`).
- Settings-window names: `SETTINGS_WINDOW_HTML` and the two warning ids (`settings-window-ids.ts`).
- The key map and the default-binding parser the PI and the plugin share (`key-binding-defaults.ts`, #1277).

Every name has one import path: `@iracedeck/app-constants`. deck-core re-exports none of them, so an importer never has to guess which package a mock must cover. Key names and values are persisted or run-scoped contracts; `persisted-values.test.ts` pins them, and a value never changes here.

## Admission rule

Constants, types, and pure functions over them — nothing else. The rule is enforced, not conventional:

- `tsconfig.json` sets `lib: ["es2022"]` and `types: []`, so any Node global (`process`, `Buffer`) or DOM global (`document`, `window`, even `URL`) fails `pnpm typecheck`. Do not add `@types/node` or the `dom` lib.
- `admission.test.ts` refuses every import: the barrel `index.ts` may only re-export the package's own modules (`./<name>.js`), and every other module imports nothing, types included. It also requires every module to be exported by the barrel. Tests read sources through `import.meta.glob` rather than `node:fs`, because Node typings in one test file would apply to the whole program.

Something that touches timers, `AbortController` or I/O belongs in `@iracedeck/fetch-utils` or a layer above, not here.

## Who imports it

deck-core and the packages above it import it directly. Browser code does too: `pi-components` bundles it into the Property Inspector, and its Rollup guard admits `@iracedeck/app-constants` as the one workspace package a browser bundle may import.
