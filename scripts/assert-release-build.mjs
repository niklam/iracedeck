#!/usr/bin/env node
/**
 * Refuses to let a DEVELOPMENT build be packed (#1143).
 *
 *   node scripts/assert-release-build.mjs <path to bin/config.json>
 *
 * Exit 0 when the built plugin folder carries no `devVoicePacksRoot`, 1 when
 * it does — or when the config is missing, unreadable or not an object — and
 * 2 with no path. Wired as the first step of every plugin's `pack:plugin`
 * script, chained with `&&`, so only a clean artifact is ever packed.
 *
 * The sibling guard `dev-voice-root-guard.test.mjs` proves the SOURCE cannot
 * emit the key unconditionally; this proves the ARTIFACT on disk does not carry
 * it, which is a different question on a machine where `pnpm dev:voices on` is
 * routinely in effect.
 *
 * Argument handling only — the behaviour lives in `lib/assert-release-build.mjs`.
 */
import { assertReleaseBuild } from "./lib/assert-release-build.mjs";

// `process.exitCode` rather than `process.exit`: a Windows TTY's stdout is
// asynchronous, and exiting outright can truncate the line naming the fix.
process.exitCode = assertReleaseBuild(process.argv[2]);
