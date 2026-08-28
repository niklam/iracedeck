#!/usr/bin/env node
/**
 * Removes the Ulanzi plugin entry created by link-ulanzi.mjs, or a real plugin
 * directory UlanziStudio installed from a packaged build (#1040).
 * Tolerates the not-linked state (exits 0 with an info message).
 *
 * The first run on a machine that has only ever had a packaged install deletes
 * a real directory, including the plugin's own `log/` files — the script says so
 * before doing it.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECK_HOSTS } from "./lib/deck-hosts.mjs";
import { unlinkPlugin } from "./lib/plugin-link.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = unlinkPlugin(DECK_HOSTS.ulanzi, { root });
