#!/usr/bin/env node
/**
 * Removes the Mirabox plugin entry created by link-mirabox.mjs, or a real
 * plugin directory installed by the host app from a packaged build.
 * Tolerates the not-linked state (exits 0 with an info message).
 *
 * The implementation is shared with the Ulanzi pair — see lib/plugin-link.mjs (#1040).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECK_HOSTS } from "./lib/deck-hosts.mjs";
import { unlinkPlugin } from "./lib/plugin-link.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.exit(unlinkPlugin(DECK_HOSTS.mirabox, { root }));
