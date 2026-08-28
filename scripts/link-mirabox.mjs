#!/usr/bin/env node
/**
 * Symlinks the built Mirabox plugin folder into the host app's plugins
 * directory, so the host loads the dev build directly (the Mirabox-side
 * equivalent of `streamdeck link` for Elgato).
 *
 * On Windows the destination defaults to the standard HotSpot StreamDock
 * install path (`%APPDATA%\HotSpot\StreamDock\plugins`). Set
 * MIRABOX_PLUGINS_DIR in your shell or in a gitignored .env.local at the
 * repo root to override (e.g. for VSD Craft or another vendor's build):
 *
 *   MIRABOX_PLUGINS_DIR=C:\Users\you\AppData\Roaming\HotSpot\StreamDock\plugins
 *
 * The implementation is shared with the Ulanzi pair — see lib/plugin-link.mjs (#1040).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECK_HOSTS } from "./lib/deck-hosts.mjs";
import { linkPlugin } from "./lib/plugin-link.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.exit(linkPlugin(DECK_HOSTS.mirabox, { root }));
