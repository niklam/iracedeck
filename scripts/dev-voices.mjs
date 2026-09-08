#!/usr/bin/env node
/**
 * `pnpm dev:voices on|off` — the development voice root switch (#1143).
 *
 * `on` writes the gitignored `dev.local.json` marker at the repo root, rebuilds
 * the three plugins so the resolved path reaches each `bin/config.json` as
 * `devVoicePacksRoot`, and relinks whichever deck hosts already point at this
 * worktree; `off` removes the marker and does the same. A host linked to
 * another worktree is reported and left alone.
 *
 * The loop it exists for: `pnpm dev:voices on` once, then edit the voice,
 * `pnpm --filter @iracedeck/audio-assets pack:voice default --no-catalog`, and
 * press **Rescan voices** in the settings window.
 *
 * Argument handling only — the behaviour lives in `lib/dev-voices.mjs`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDevVoices } from "./lib/dev-voices.mjs";
import { loadEnvLocal } from "./lib/env-local.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The host plugin directories can be overridden in a gitignored .env.local,
// exactly as the link scripts allow — the relink step must see the same paths.
loadEnvLocal(root);

// `process.exitCode` rather than `process.exit`: a Windows TTY's stdout is
// asynchronous, and exiting outright can truncate the lines naming which hosts
// were relinked and which were left alone.
process.exitCode = runDevVoices(process.argv[2], { root });
