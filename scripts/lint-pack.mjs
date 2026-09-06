#!/usr/bin/env node
/**
 * Lints a voice pack (issue #1066): what the plugin would only skip quietly,
 * said loudly — grammar problems in a voice's callouts.json, every compile
 * skip the pack did not mean with its reason, frames and fragments that fail,
 * clips the pack ships that nothing references, references to clips it does
 * not ship, and a per-voice coverage summary.
 *
 *   pnpm lint:pack <packDir>     # the folder holding voice-pack.json and voice/
 *
 * Exit 0 with the summary when the pack is clean, 1 when it has problems,
 * 2 when the tool could not run (usage, a path that is not a directory, or
 * a missing dist — `pnpm build` first: the root scripts are plain Node and
 * read the BUILT `@iracedeck/audio-scenarios`).
 *
 * The rules live in `packages/audio-scenarios/src/reference/lint-pack.ts`;
 * the argument handling and the `node:fs` port in `lib/lint-pack-run.mjs`.
 */
import { runLintPack } from "./lib/lint-pack-run.mjs";

// `exitCode` rather than `exit()`: a Windows TTY's stdout is asynchronous, and
// exiting outright can truncate the last lines of the report.
process.exitCode = await runLintPack(process.argv.slice(2));
