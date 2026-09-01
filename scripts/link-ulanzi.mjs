#!/usr/bin/env node
/**
 * Junction-links the built Ulanzi plugin folder into UlanziStudio's plugins
 * directory, so the host loads the dev build directly (#1040).
 *
 * On Windows the destination defaults to `%APPDATA%\Ulanzi\UlanziDeck\Plugins`.
 * Set ULANZI_PLUGINS_DIR in your shell or in a gitignored .env.local at the
 * repo root to override.
 *
 * UlanziStudio reads its plugins directory at start only, so restart the host
 * after linking: `pnpm stop:ulanzi && pnpm switch-test-env:ulanzi && pnpm start:ulanzi`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECK_HOSTS } from "./lib/deck-hosts.mjs";
import { linkPlugin } from "./lib/plugin-link.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.exitCode = linkPlugin(DECK_HOSTS.ulanzi, { root });
