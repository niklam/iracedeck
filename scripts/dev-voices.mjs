#!/usr/bin/env node
/**
 * `pnpm dev:voices on|off|auto` — the development voice root switch for this
 * worktree (#1143, #1214).
 *
 * `on` writes the gitignored `dev.local.json` marker at the repo root with the
 * default root; `off` writes `voicePacksRoot: false`, the explicit per-worktree
 * off; `auto` removes the marker so the worktree follows the machine-wide
 * `IRACEDECK_DEV_VOICES` opt-in. Each then rebuilds the three plugins — which
 * stages the packs into the default root while development mode is on — so the
 * resolved root reaches each `bin/config.json` as `devVoicePacksRoot`, and
 * relinks whichever deck hosts already point at this worktree. A host linked
 * to another worktree is reported and left alone.
 *
 * The loop it exists for: set `IRACEDECK_DEV_VOICES=1` once in your user
 * environment (or `pnpm dev:voices on` in one worktree), `pnpm build` once
 * with the deck host stopped, then per voice edit `pnpm stage:voices` and
 * **Rescan voices** in the settings window — no plugin build, so a running
 * host (which locks the native addon) is fine.
 *
 * Argument handling only — the behaviour lives in `lib/dev-voices.mjs`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvLocalForDevVoices, runDevVoices } from "./lib/dev-voices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The host plugin directories can be overridden in a gitignored .env.local,
// exactly as the link scripts allow — the relink step must see the same paths.
// IRACEDECK_DEV_VOICES is never taken from it: a plain `pnpm build` would not
// see it, and the two would disagree about the mode.
loadEnvLocalForDevVoices(root);

// `process.exitCode` rather than `process.exit`: a Windows TTY's stdout is
// asynchronous, and exiting outright can truncate the lines naming which hosts
// were relinked and which were left alone.
process.exitCode = runDevVoices(process.argv[2], { root });
