---
paths:
  - ".nvmrc"
  - "vitest.config.ts"
  - ".github/workflows/**"
  - "scripts/workflow-setup-node*"
---

# The Node pin and the worker crash it fixes

Why `.nvmrc` pins the Node it does, for whoever edits it, `vitest.config.ts` or a workflow's `actions/setup-node` step, or meets a test worker that dies without a word. Moved out of `@.claude/rules/testing.md` in #1501 to keep the always-loaded set inside its budget; that rule keeps a one-line pointer naming the exit code.

## A worker that dies with exit code 3221226505 (#1444)

`Worker exited unexpectedly with exit code 3221226505` (0xC0000409) with no stderr, on Windows, is Node 24.15.0's own stack buffer overrun in libuv's Windows TCP-connect path, fixed in 24.16.0 ([nodejs/node#63620](https://github.com/nodejs/node/issues/63620), fix [#62561](https://github.com/nodejs/node/pull/62561)). It strikes during a WebSocket connect, so it showed as `settings-window-server.test.ts` failing in about one full run in four. Measured 2026-10-20 outside vitest: 0 crashes in 600 runs on 24.21.0 and 20.20.2, against 27 in 600 on 24.15.0; a bare `http` + `ws` loop with no repo code crashes on 24.15.0 too. **Check `node -v` before anything else**: `.nvmrc` pins 24.21.0, the Node 24 that Stream Deck ships, and a local Node older than 24.16.0 brings the crash back. Every `actions/setup-node` step reads that file (`node-version-file: '.nvmrc'`), the release and voice-pack workflows included since #1513, so what ships is built on the Node the suite runs on; `scripts/workflow-setup-node.test.mjs` fails on a step that names a version or another file (#1503). A `pool` or `isolate` setting cannot fix it. The #1084 dropped workers began after 24.15.0 was pinned (#928) and were probably the same bug; no exit code was recorded, so that link is unproven.
