/**
 * The local debug switch behind `pnpm debug:plugin on|off|status` (#1338).
 *
 * `on` adds `"Debug": "--inspect=127.0.0.1:9229"` to the Elgato manifest's
 * `Nodejs` block, so Stream Deck starts the plugin with the inspector on a
 * fixed port; `off` takes exactly that line out again; `status` reports which
 * of the three states the manifest is in. Stream Deck reads the key only while
 * it is in developer mode, and only when it (re)starts the plugin.
 *
 * Three decisions are load-bearing:
 *
 * - **The manifest is edited as TEXT, one line, never parsed and re-dumped.**
 *   A re-dump re-expands the inline arrays and rewrites the whole file, so the
 *   diff a developer has to revert is 900 lines instead of one. `on` then `off`
 *   restores the file byte for byte; every edit is verified before it is
 *   written (the result parses, carries exactly the intended `Debug`, and the
 *   reverse edit gives the input back), so an edit that matched the wrong text
 *   is refused rather than written.
 * - **A `Debug` value this switch did not set is never touched.** `on` refuses
 *   to overwrite it and `off` refuses to remove it, both naming the value: the
 *   developer put it there on purpose.
 * - **The key never ships.** Three guards read the same {@link manifestDebug}:
 *   `assert-release-build` refuses to pack a plugin folder whose manifest
 *   carries it, the pre-bash hook refuses a commit that would record it, and
 *   `manifest-no-debug.test.mjs` fails CI on a HEAD that carries it.
 *
 * Everything impure is injected and an exit code is RETURNED, the shape every
 * `scripts/lib` helper uses.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The Elgato manifest, repo-relative with forward slashes (as git names it). */
export const ELGATO_MANIFEST = "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json";

/** The one value this switch writes: the inspector on loopback, on a fixed port so attaching needs no hunting. */
export const DEBUG_VALUE = "--inspect=127.0.0.1:9229";

export const VERBS = ["on", "off", "status"];
export const USAGE = `Usage: pnpm debug:plugin <${VERBS.join("|")}>`;

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

/**
 * Whether `text` (a plugin manifest) carries a `Debug` key in its `Nodejs`
 * block: `{ ok: true, present: false }`, `{ ok: true, present: true, value }`,
 * or `{ ok: false, error }` when the text is not a JSON object. Presence is the
 * property, never the value — `"Debug": ""` still makes a different plugin.
 * Read by parsing, which is safe: only a WRITE must never go through a parse.
 */
export function manifestDebug(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, error: "the manifest does not hold an object" };
  const nodejs = parsed.Nodejs;
  if (nodejs === null || typeof nodejs !== "object" || Array.isArray(nodejs) || !("Debug" in nodejs))
    return { ok: true, present: false };

  return { ok: true, present: true, value: nodejs.Debug };
}

/**
 * The `Nodejs` block of `text` as `{ open, close }` — the indices of its `{`
 * and matching `}` — or `null`. Scans strings so a brace inside a value does
 * not count, and requires exactly one `"Nodejs"` key at the manifest's top
 * level, so the edit can never land in some other object.
 */
function nodejsBlock(text) {
  const keys = [...text.matchAll(/^([ \t]*)"Nodejs"[ \t]*:[ \t]*\{/gm)];
  if (keys.length !== 1) return null;
  const open = keys[0].index + keys[0][0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { open, close: i };
  }
  return null;
}

const DEBUG_LINE = JSON.stringify({ Debug: DEBUG_VALUE }).slice(1, -1).replace(":", ": ");

/** `text` with the switch's `Debug` line added as the last property of `Nodejs`, or `null` when the block's shape is not one this edit knows. */
export function addDebugLine(text) {
  const block = nodejsBlock(text);
  if (!block) return null;
  const body = text.slice(block.open + 1, block.close);
  const lastValue = body.trimEnd().length;
  if (lastValue === 0 || body.trimEnd().endsWith(",")) return null;
  const at = block.open + 1 + lastValue;
  // The indent of the last property's line, and the file's own line ending.
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))[0];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const sep = body.includes("\n") ? `,${eol}${indent}` : ", ";

  return text.slice(0, at) + sep + DEBUG_LINE + text.slice(at);
}

/** `text` with the switch's own `Debug` line taken out of `Nodejs`, or `null` when it is not there in a shape this edit knows. */
export function removeDebugLine(text) {
  const block = nodejsBlock(text);
  if (!block) return null;
  const body = text.slice(block.open + 1, block.close);
  const line = DEBUG_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Last property: take the comma and line break before it, which is exactly what `addDebugLine` adds.
  const last = new RegExp(`,(\\r?\\n[ \\t]*|[ \\t]*)${line}(?=\\s*$)`).exec(body);
  // Any other position: its own line, with the comma after it.
  const inner = new RegExp(`(^|\\n)[ \\t]*${line}[ \\t]*,[ \\t]*\\r?\\n`).exec(body);
  const m = last ?? inner;
  if (!m || (last && inner)) return null;
  const from = block.open + 1 + m.index + (last ? 0 : m[1].length);
  const to = block.open + 1 + m.index + m[0].length;

  return text.slice(0, from) + text.slice(to);
}

/**
 * @param {string | undefined} verb `on`, `off` or `status`.
 * @param {{ root: string, fs?: { readFileSync: Function, writeFileSync: Function }, log?: { log: Function, error: Function } }} options
 *   `root` is the repository (or worktree) whose manifest the switch edits.
 * @returns {number} 0 done (or nothing to do), 1 refused or failed, 2 usage.
 */
export function runDebugPlugin(verb, { root, fs = { readFileSync, writeFileSync }, log = console }) {
  if (!VERBS.includes(verb)) {
    log.error(USAGE);

    return EXIT_USAGE;
  }

  const file = path.join(root, ELGATO_MANIFEST);
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    log.error(`Error: could not read ${ELGATO_MANIFEST} (${error.message}).`);

    return EXIT_REFUSED;
  }

  const state = manifestDebug(text);
  if (!state.ok) {
    log.error(`Error: ${ELGATO_MANIFEST} could not be parsed (${state.error}). Nothing changed.`);

    return EXIT_REFUSED;
  }
  const foreign = state.present && state.value !== DEBUG_VALUE;
  const shown = JSON.stringify(state.value);

  if (verb === "status") {
    if (!state.present) log.log(`Plugin debugging is OFF: ${ELGATO_MANIFEST} carries no Debug key.`);
    else if (foreign)
      log.log(`The manifest carries a Debug value this switch did not set: ${shown}. Remove it by hand when done.`);
    else log.log(`Plugin debugging is ON: Debug is ${shown} (inspector on 127.0.0.1:9229).`);

    return EXIT_OK;
  }

  if (foreign) {
    log.error(
      `Refusing to ${verb === "on" ? "overwrite" : "remove"} the manifest's Debug value ${shown}: this switch did not ` +
        `set it, so it was put there by hand. Edit ${ELGATO_MANIFEST} yourself — ` +
        (verb === "on" ? `remove that line, then run \`pnpm debug:plugin on\`.` : "remove that line."),
    );

    return EXIT_REFUSED;
  }

  if (verb === "on" && state.present) {
    log.log(`Plugin debugging is already ON (Debug is ${shown}). Nothing changed.`);

    return EXIT_OK;
  }
  if (verb === "off" && !state.present) {
    log.log("Plugin debugging is already OFF. Nothing changed.");

    return EXIT_OK;
  }

  const next = verb === "on" ? addDebugLine(text) : removeDebugLine(text);
  // Verified before it is written: an edit must parse and carry exactly the
  // intended state, and `on` must reverse to the bytes it started from — which
  // is the promise `off` keeps.
  const after = next === null ? null : manifestDebug(next);
  const intended =
    after?.ok &&
    (verb === "on" ? after.present && after.value === DEBUG_VALUE && removeDebugLine(next) === text : !after.present);
  if (!intended) {
    log.error(
      `Error: the Nodejs block of ${ELGATO_MANIFEST} is not in a shape this switch can edit as one line. ` +
        `Nothing changed; ${verb === "on" ? `add "Debug": "${DEBUG_VALUE}" to it` : "remove the Debug line"} by hand.`,
    );

    return EXIT_REFUSED;
  }

  try {
    fs.writeFileSync(file, next, "utf-8");
  } catch (error) {
    log.error(`Error: could not write ${ELGATO_MANIFEST} (${error.message}).`);

    return EXIT_REFUSED;
  }

  if (verb === "on") {
    log.log(`Plugin debugging is ON: added "Debug": "${DEBUG_VALUE}" to the Nodejs block of ${ELGATO_MANIFEST}.`);
    log.log(
      "Stream Deck reads the key only in developer mode (`streamdeck dev`), and only when it starts the plugin — " +
        "restart it (`pnpm restart:stream-deck`), then attach from chrome://inspect on 127.0.0.1:9229.",
    );
    log.log(
      "Never commit it: run `pnpm debug:plugin off` first. The commit hook, `pack:plugin` and CI all refuse a manifest with Debug.",
    );
  } else {
    log.log(`Plugin debugging is OFF: removed the Debug line from ${ELGATO_MANIFEST}.`);
    log.log("Restart the plugin (`pnpm restart:stream-deck`) for Stream Deck to start it without the inspector.");
  }

  return EXIT_OK;
}
