# @iracedeck/fetch-utils

Request helpers shared by the plugin's Node process and a Property Inspector's browser bundle: `abortAfter` (a one-shot request deadline) and `readCappedJson` / `ResponseTooLargeError` (a JSON read under a byte cap, #1101). Zero dependencies.

## Browser-safety rule

This package may use only globals that both runtimes share (`AbortController`, `AbortSignal`, `setTimeout`, `Response`, `TextDecoder` …). Never import `node:*` and never reference `process` or `Buffer`. It is enforced, not conventional: `tsconfig.json` sets `types: []` (no Node typings) and `lib: ["es2022", "dom"]`, so a `node:` import or a `process` reference fails `pnpm typecheck`. Do not add `@types/node` to this package.

## Why it is not part of app-constants

`app-constants` holds plain constants. This package touches timers and `AbortController`, which is runtime behaviour, so it is a separate leaf (spec #1351). deck-core imports it directly; there are no re-exports.
