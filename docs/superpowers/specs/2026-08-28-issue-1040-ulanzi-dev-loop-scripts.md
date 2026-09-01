# Ulanzi dev-loop scripts

> **Issue:** [#1040](https://github.com/niklam/iracedeck/issues/1040) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Ulanzi is the only one of the three ecosystems with no link step. Its `CLAUDE.md` tells the developer to copy the built plugin folder into `%APPDATA%\Ulanzi\UlanziDeck\Plugins\` by hand and restart the host. This spec settles how to close that gap, and how far to go in unifying it with the Mirabox pair that already exists.

## The loop, and why its order is not arbitrary

```bash
pnpm stop:ulanzi && pnpm switch-test-env:ulanzi && pnpm start:ulanzi
```

Two constraints fix that order, and both are load-bearing:

**The host must stop before the build, not before the relink.** A running UlanziStudio holds `iracing_native.node` open, and a full `pnpm build` then fails with `EPERM`. A developer who stops the host at the relink step — the intuitive place — has already lost the build. This is why `stop` is a separate first step rather than something `switch-test-env` does for itself: `switch-test-env:ulanzi` is defined as `install && build && relink` to stay symmetrical with its two siblings, and folding a `stop` into it would make it asymmetric to fix a problem the sequence already solves.

**The host reads its plugins directory at start only.** Verified 2026-08-28. So a relink without a restart changes nothing observable, and `start` is part of the loop rather than a convenience.

## Junction, not copy — verified, not assumed

`link:ulanzi` creates a Windows directory **junction** (`symlinkSync(src, link, "junction")`, no admin or developer mode required), exactly as `link-mirabox.mjs` does.

Whether UlanziStudio would load a plugin through a junction was genuinely unknown — the Mirabox host does, but it is a different application, and the answer decides the whole shape. It was tested before writing this spec: the installed copy was replaced with a junction into a worktree and the host restarted. Three independent signals agreed:

- the plugin's `_settingsChannel` port changed across the restart (a fresh port every plugin start, so a changed port means the plugin really started);
- a fresh per-day log appeared **in the source worktree** instead of under `%APPDATA%`, which can only happen if the host read through the junction;
- that log carried `Connected to UlanziStudio` and `Mirrored settings + channel to the deck host`.

A copy-based link was the fallback and is now rejected: the per-build re-copy is precisely the cost being removed, and a copy carries no back-pointer to the worktree it came from.

## Configuration: env var with a derived default

`ULANZI_PLUGINS_DIR` mirrors `MIRABOX_PLUGINS_DIR` exactly — read from a gitignored `.env.local` at the repo root, shell environment winning over it, defaulting on win32 to `%APPDATA%\Ulanzi\UlanziDeck\Plugins` and failing with the exact `.env.local` line to add when nothing can be derived. The default is a convenience for the common install; the env var is the real answer.

The host **executable** paths are env-configurable too (`ULANZI_APP_PATH`, `MIRABOX_APP_PATH`), which is a deliberate departure from `start:stream-deck` hardcoding Elgato's path. The reason is specific to the Mirabox family: two compatible hosts are commonly installed side by side (`StreamDock` and `VSD Craft`, both present on the machine this was written on), so a hardcoded executable is wrong for half the cases, and the process name to kill is the basename of whichever one is in use. Ulanzi has only one host today and takes the env var anyway, for symmetry rather than need. The existing `*:stream-deck` scripts are **not** touched — retrofitting them is unrelated churn.

## Factor the shared core, don't copy it a third time

Naively, Ulanzi adds `link-ulanzi.mjs` + `unlink-ulanzi.mjs` as near-identical twins of the Mirabox pair, and the four files then share about 90% of their content — `loadEnvLocal`, destination resolution, the built-plugin guard, the `lstat`-not-`exists` checks, the symlink-vs-real-directory branch in unlink. That duplication is already at two copies of `loadEnvLocal` today.

So: extract `scripts/lib/env-local.mjs` and a parameterised link/unlink core, and have both ecosystems' scripts be thin descriptors (`{ name, envVar, defaultDir, source, linkName }`). Two things this must not break, and they are the risk that makes it worth stating:

- The Mirabox scripts' **behaviour is load-bearing** — `scripts/CLAUDE.md` and the website setup page quote their defaults, and the error text names the env var to set. The refactor must not change what Mirabox *does*. Its output changes in exactly two deliberate ways, both improvements that apply equally to either host and so belong in the shared core rather than being switched off for one of them: the real-directory removal now announces itself and names the log files it will take (previously a silent recursive delete), and the `.env.local` example in the "nothing resolved" error loses its doubled backslashes — it read `C:\\Users\\you\\...` from an over-escaped string literal, which is not what `.env.local` actually wants and would have been copy-pasted wrong.
- The unlink branch on entry type is subtle and must survive intact: `rmSync(recursive)` on a Windows junction whose target is gone silently no-ops and leaves the junction behind, so symlinks and junctions get `unlinkSync` while only real directories get recursive removal.

The alternative — copy the pair and accept four files — was rejected. It is cheaper now and wrong later; a fix to the dangling-junction handling would have to be found and applied twice.

## The first-run hazard, and why there is now no deletion at all

1. **The installed folder is a plain copied directory today**, so the very first `unlink:ulanzi` meets a real folder rather than a link. Replacing the copy with a junction is the intended outcome; destroying its contents to get there is not.
2. **That folder contains `log/`**, the plugin's per-day log files, which are real diagnostic evidence (the #1039 diagnosis rested on two of them). Once the junction is in place this stops mattering — the logs land in the worktree instead, which is strictly better — but the transition itself must not eat them.

This spec originally specified `rmSync(recursive, force)` plus a printed warning, on the reasoning that the delete is intended and announcing it is enough. **Review overturned that, and the amended decision is to rename rather than delete:** the folder is moved to `<folder>.replaced-<timestamp>`.

Two arguments carried it. The printed warning is unreliable where it matters most — `relink` runs inside `switch-test-env`, so the one line scrolls past thousands of turbo build lines, unread and unconfirmed. And the loss is genuinely unrecoverable, unlike the rest of the folder, which any build reproduces. A rename costs one stale directory the user can delete at leisure and removes the irreversible step from the tool entirely.

The aside suffix must break the host's scan pattern (`*.sdPlugin` / `*.ulanziPlugin`) so the moved copy is never loaded as a second plugin. This is why the module's mutating filesystem calls are also wrapped: with the host still running, the rename fails EBUSY exactly as the delete would, and that is the *expected* error path given the loop's own instruction to stop the host first — it deserves the fix, not a stack trace.

## One junction means one worktree owns the host

The same trap the Stream Deck link already has, and it has already cost debugging time on "my fix isn't working" — whoever linked last owns the host, and nothing on screen says who that was. Mitigation is cheap and belongs here rather than in a rule nobody re-reads: `link:ulanzi` prints the resolved source path, and `start:ulanzi` echoes the junction's current target before launching. A developer who runs the loop therefore cannot avoid seeing which worktree they are about to test.

Rejected: making `start:ulanzi` wait for the host's WebSocket on `127.0.0.1:3906` before returning. It reads as rigour but buys nothing — nothing runs after `start` in the loop, and the developer is looking at a GUI application that either appeared or did not.

## Out of scope

- Changing the existing `*:stream-deck` scripts.
- A changelog entry. This is developer tooling with no user-visible effect; `changelog.md` explicitly excludes internal work.
- Any plugin runtime code. If a diff here reaches into `packages/*/src`, the design has gone wrong.
