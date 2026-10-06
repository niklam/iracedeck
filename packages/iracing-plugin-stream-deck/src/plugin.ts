/**
 * iRaceDeck Stream Deck plugin — the Elgato entry point (#1349).
 *
 * Startup is `@iracedeck/plugin-runtime`'s `startPlugin`; this file builds
 * the host's adapter and the extension for what only Stream Deck has
 * (profiles, the deck list, the device type). The phases and their order:
 * `.claude/rules/plugin-structure.md`.
 */
import streamDeck from "@elgato/streamdeck";
import { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { startPlugin } from "@iracedeck/plugin-runtime";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createElgatoExtension } from "./elgato-extension.js";

// `<plugin>/bin`: where this bundle and its build-time config.json live.
const binDir = dirname(fileURLToPath(import.meta.url));

const adapter = new ElgatoPlatformAdapter(streamDeck);

startPlugin({ adapter, binDir, extension: createElgatoExtension(streamDeck, adapter) });
