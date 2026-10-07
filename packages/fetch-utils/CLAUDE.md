# @iracedeck/fetch-utils

Request helpers shared by the plugin's Node process and a Property Inspector's browser bundle: `abortAfter` (a one-shot request deadline) and `readCappedJson` / `ResponseTooLargeError` (a JSON read under a byte cap, #1101). Zero dependencies.

## Browser-safety rule

This package may use only globals that both runtimes share (`AbortController`, `AbortSignal`, `setTimeout`, `Response`, `TextDecoder` …). Never import `node:*` and never reference `process` or `Buffer`. It is enforced, not conventional: `pnpm typecheck` compiles the sources twice. `tsconfig.json` sets `types: []` and `lib: ["es2022", "dom"]`, the browser's view, so a `node:` import or a `process` reference fails. `tsconfig.node.json` swaps in `types: ["node"]` and drops `dom`, Node's view, so a DOM-only global such as `window` or `document` fails. Only what both runtimes declare passes both. `@types/node` is a devDependency for that second pass alone; never add `node` to `tsconfig.json`'s `types`.

## Why it is not part of app-constants

`app-constants` holds plain constants. This package touches timers and `AbortController`, which is runtime behaviour, so it is a separate leaf (spec #1351). deck-core imports it directly for its two feed clients (`changelog-feed-client.ts`, `voice-pack-catalog-client.ts`), and `pi-components` bundles `abortAfter` into the Property Inspector (`simhub-probe.ts`, `update-notice.ts`); its Rollup guard admits this package and `@iracedeck/app-constants` by bare name and nothing else from the workspace. There are no re-exports.
