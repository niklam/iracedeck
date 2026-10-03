> **Issue:** [#1258](https://github.com/niklam/iracedeck/issues/1258) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# A locked native addon is moved aside, and the rebuild runs anyway

The issue carries the problem: both native build scripts try to detect a `.node` locked by a running deck host after `node-gyp rebuild` fails, and the detection can never match. This spec settles what the build does about the lock once it can see it.

## The decision: rename the locked binary out of the way, then rebuild

Decided with the maintainer on 2026-10-03. Before `node-gyp rebuild`, the build script deletes the existing `build/Release/<name>.node` itself. When that fails with `EPERM`, `EBUSY` or `EACCES`, the file is loaded by a running process, and the script **moves** it into the package's gitignored `.locked-native/` folder under a timestamped name. `node-gyp rebuild` then runs on a tree with nothing locked in it and produces a fresh binary. Any failure of the rebuild itself fails the build; there is no catch around it any more.

This rests on how Windows treats a mapped image, measured on 2026-10-03 against a copy of `audio_native.node` loaded by a separate Node process:

| Operation on the loaded `.node` | Result |
| --- | --- |
| Delete (node-gyp's clean step) | `EPERM` |
| Open for writing | `EBUSY` |
| Rename in the same folder, or move to another folder on the same volume | succeeds |
| Delete the moved copy while it is still loaded | `EPERM` |
| Delete the moved copy after the process exits | succeeds |
| Call into the addon after its file was moved | succeeds |

So the running host is unaffected: it keeps executing the old code from the moved file, and loads the new binary on its next start — the restart a native change needs anyway. The folder sits inside the package rather than in `%TEMP%` because a move across volumes is a copy-and-delete, and the delete is exactly what the lock refuses.

Every build (and `clean`) first sweeps `.locked-native/`: each copy that deletes is gone, each one still loaded is left for a later build, and the folder is removed once empty. `clean.mjs` gets the same move before `node-gyp clean`, which fails on the lock in exactly the same way.

One helper in `scripts/lib/native-addon-build.mjs` serves both packages, replacing two copies that had to be kept in sync by hand. Because it lives outside the packages, `turbo.json` names it as an input of both packages' `build`, or an edit to it would be served from cache.

## The alternatives weighed

- **Keep the old binary and carry on** (the issue's original intent, with stderr captured so the lock is visible). Rejected because of turbo: the build would exit green and turbo would cache the **stale** binary under the hash of the **new** sources. After the host is quit, the next `pnpm build` is a cache hit that restores the stale binary, so the native change is never compiled — a loud failure turned into a silent one. It also leaves `build/` emptied around the locked file by node-gyp's partial clean.
- **Detect the lock and fail with a clear message.** Honest, and nothing stale is cached, but a linked host still blocks every full build, which is the inconvenience the fallback existed to remove.
- **Classify node-gyp's captured stderr.** Unnecessary once the script probes the file itself before node-gyp touches it: the probe reads the lock from the `fs` error code in our own process, rather than from text another process printed.

## Out of scope

- Locks on anything other than the addon binary. A different file held open under `build/` fails the rebuild as before, which is correct: nothing known makes that happen.
- The plugins' own `bin/` copies of native dependencies (`keysender`), installed by each plugin's `postbuild`. A lock there is that step's concern.
- Restarting or signalling the deck host. The build never touches the host; picking up the new binary is the maintainer's restart.

## Testing

- **Unit tests** (`scripts/lib/native-addon-build.test.mjs`): the lock classification over `EPERM` / `EBUSY` / `EACCES` versus other codes; a locked addon is moved aside with a timestamped name; an unlocked one is deleted; a missing one is a no-op; a non-lock error is rethrown; the sweep removes released copies and keeps locked ones. The fs layer is injected, so the locked cases run on every platform; each lock case is positive-controlled by a sibling case that must not take the lock path.
- **Manual, on Windows**: hold the worktree's `audio_native.node` and `iracing_native.node` loaded in a separate Node process, run `pnpm build`, and confirm both addons are moved aside, both rebuild, the build is green, and the holder can still call into its addon. Then end the holder and build again: the sweep empties `.locked-native/`.
