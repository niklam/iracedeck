#!/usr/bin/env node
/**
 * Author the `car-number` voice-config group: a spoken clip for every car
 * number iRacing can produce (issue #1127 — the caution-restart narration
 * names the car ahead of you). `09` and `9` (and `009`) are DIFFERENT
 * clips, both in name and in reading — the leading zeros iRacing pads a
 * number with ARE information, not formatting, so this authors all 1,110
 * of them (0-9, 00-99, 000-999) rather than reusing `position-number`'s
 * 1-64 range.
 *
 * The clip text is the number ALONE — no "car", no "number" — because the
 * surrounding callout line supplies those words and always places the
 * number last (see `caution.followCarNumber` in
 * `packages/audio-scenarios/src/catalog/pit-crew/caution.ts`).
 *
 * Reading rules (ruled by the maintainer, 2026-09-17 — use verbatim):
 *
 *   | Shape               | Examples                                         |
 *   | ------------------- | ------------------------------------------------- |
 *   | One digit           | 5 -> "five", 0 -> "zero"                          |
 *   | Two digits          | 49 -> "forty-nine", 10 -> "ten"                   |
 *   | Leading zero        | 09 -> "oh nine", 00 -> "double oh"                |
 *   | Three digits        | 119 -> "one nineteen", 275 -> "two seventy-five", |
 *   |                     | 105 -> "one oh five", 100 -> "one hundred",       |
 *   |                     | 110 -> "one ten"                                  |
 *   | Zero + two digits   | 099 -> "oh ninety-nine", 050 -> "oh fifty"        |
 *   | Double zero + digit | 009 -> "double oh nine", 000 -> "triple oh"       |
 *
 * `readCarNumber` is exported for `src/car-numbers.test.ts` to drive
 * directly, so the reading rules are tested without touching the config.
 *
 * NOTE on TTS input: several readings speak the word "oh" as a digit
 * ("oh nine", "double oh", "one oh five", …). ElevenLabs may read a bare
 * "oh" with exclamation/interjection prosody rather than as a digit —
 * this could not be verified by ear before generating (see the task
 * report for #1127 task 10). If a sample comes back sounding like an
 * interjection rather than a digit, the fix belongs in the `text` here
 * (e.g. a punctuation or spelling hint), not in the reading rules above.
 *
 * Every entry is conditioned on the caution lead-in it is spliced onto — see
 * `CAR_NUMBER_LEAD_IN_REF` below for what that buys and why it is a
 * `previous_request_ids` reference and nothing else.
 *
 * NOTE on editing the config: this file writes the `car-number` group by
 * splicing its JSON text directly into `groups` (`spliceGroupIntoConfig`)
 * rather than `JSON.parse`-ing the whole document, mutating it, and
 * `JSON.stringify`-ing it back out. A full round-trip re-serializes EVERY
 * value in the file with `JSON.stringify`'s own formatting — which does
 * not know or care that a human hand-wrote `"sequence": ["pool:x"]` as a
 * compact one-liner elsewhere in the `scenarios` section, and expands it
 * to three lines. Prettier accepts both forms, so nothing catches this
 * except a diff far bigger than the intended change (issue #1127 fix
 * round 1 caught exactly that: 211 unrelated compact arrays flattened).
 * `generate-corner-names-group.mjs` uses the round-tripping idiom too —
 * don't copy it into a new generator.
 *
 * Usage:
 *   node packages/audio-assets/scripts/generate-car-numbers.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import url from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "configs", "default.voice.json");

const GROUP_NAME = "car-number";

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

// 0-19 as words, "ten" through "nineteen" included, so a two-digit reading
// with no tens-word (10-19) falls out of the same table as 0-9.
const ONES_AND_TEENS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * A two-digit VALUE (10-99) read as a compound number, hyphenated when both
 * a tens word and a ones word are spoken ("forty-nine", "seventy-five") —
 * per the maintainer's table — and left bare otherwise ("ten", "fifty").
 */
function twoDigitWord(n) {
  if (n < 20) return ONES_AND_TEENS[n];

  const tens = TENS[Math.floor(n / 10)];
  const ones = n % 10;

  return ones === 0 ? tens : `${tens}-${ONES_AND_TEENS[ones]}`;
}

/**
 * Read a car number exactly as iRacing spells it, per the maintainer's
 * ruling table above.
 *
 * @param {string} numStr the number exactly as the sim would print it —
 *   "5", "09", "275" — never re-derived from a numeric value, since the
 *   leading zeros ARE the information ("09" and "9" are different clips).
 * @returns {string} the spoken text for that number, alone (no "car", no
 *   "number").
 */
export function readCarNumber(numStr) {
  const len = numStr.length;

  if (len === 1) {
    return DIGIT_WORDS[Number(numStr)];
  }

  if (len === 2) {
    if (numStr[0] !== "0") return twoDigitWord(Number(numStr));

    const digit = Number(numStr[1]);

    return digit === 0 ? "double oh" : `oh ${DIGIT_WORDS[digit]}`;
  }

  if (len === 3) {
    const remainder = numStr.slice(1);

    if (numStr[0] === "0") {
      if (remainder === "00") return "triple oh";
      if (remainder[0] === "0") return `double oh ${DIGIT_WORDS[Number(remainder[1])]}`;

      return `oh ${twoDigitWord(Number(remainder))}`;
    }

    const hundreds = DIGIT_WORDS[Number(numStr[0])];

    if (remainder === "00") return `${hundreds} hundred`;
    if (remainder[0] === "0") return `${hundreds} oh ${DIGIT_WORDS[Number(remainder[1])]}`;

    return `${hundreds} ${twoDigitWord(Number(remainder))}`;
  }

  throw new Error(`readCarNumber: unsupported car number "${numStr}" (must be 1-3 digits)`);
}

/**
 * Every number iRacing can put on a car, as the sim would spell it:
 * 0-9, then 00-99 (zero-padded to two digits), then 000-999 (zero-padded to
 * three digits) — 1,110 total, each a distinct string ("9", "09" and "009"
 * all appear separately).
 */
export function allCarNumbers() {
  const numbers = [];

  for (let i = 0; i <= 9; i++) numbers.push(String(i));
  for (let i = 0; i <= 99; i++) numbers.push(String(i).padStart(2, "0"));
  for (let i = 0; i <= 999; i++) numbers.push(String(i).padStart(3, "0"));

  return numbers;
}

/**
 * The clip every car number is conditioned on: a caution lead-in that ends
 * exactly where a number begins ("One to go. Take the outside line, behind
 * car number"). A number is only ever spliced onto the END of a lead-in like
 * that, and generated standalone it opens like a fresh sentence — so each
 * entry names this clip in `previous_request_ids`, which the generator
 * resolves per voice to the real preceding audio (see the "Request-id
 * chains" block in `src/generate/generate.ts`). The tail "behind car number"
 * is common to almost every lead-in, so one reference serves them all.
 *
 * Only the request-id, deliberately no `previous_text`: the request-id
 * carries the actual preceding audio, and a text approximation beside it is
 * redundant (maintainer, 2026-09-18). The lead-in itself carries `next_text`
 * rather than `next_request_ids` back to a number, because that pair would
 * be a reference CYCLE and `detectReferenceCycles` refuses the config.
 *
 * Generation order follows from the reference: the `caution` group must be
 * generated BEFORE this one, so the target's request-id is in
 * `generate.manifest.json` when the numbers are cut.
 */
export const CAR_NUMBER_LEAD_IN_REF = "caution/one-to-go-outside-01";

/** The full `car-number` group: one `{ name, text, seed, previous_request_ids }` entry per number. */
export function buildCarNumberGroup() {
  // A uniform seed across all 1,110 short, similar clips — same approach as
  // the existing `position-number` group (also seed 1 throughout) — keeps
  // delivery style consistent rather than letting it drift entry to entry.
  return allCarNumbers().map((name) => ({
    name,
    text: readCarNumber(name),
    seed: 1,
    previous_request_ids: [CAR_NUMBER_LEAD_IN_REF],
  }));
}

// The indent of a key that is a direct child of `"groups": {` — this file's
// `groups` object always sits two levels deep (root -> "groups" -> the key),
// so this is fixed rather than computed from the surrounding text.
const GROUP_KEY_INDENT = "    "; // 4 spaces

/**
 * The `[start, end)` character range of `text[start..end)` such that
 * `text[start]` is the `{` or `[` at `openIndex` and `text[end - 1]` is its
 * matching close bracket. Skips over string literals (respecting `\"`
 * escapes) so a bracket character inside a JSON string is never mistaken for
 * structure — the group entries here are ordinary text, but this is meant to
 * be trustworthy independent of that.
 *
 * @internal Exported for testing.
 */
export function findMatchingBracket(text, openIndex) {
  const open = text[openIndex];
  const close = open === "{" ? "}" : "]";

  if (open !== "{" && open !== "[") {
    throw new Error(`findMatchingBracket: text[${openIndex}] is ${JSON.stringify(open)}, not "{" or "["`);
  }

  let depth = 0;
  let i = openIndex;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }

    i++;
  }

  throw new Error(`findMatchingBracket: unbalanced "${open}"..."${close}" starting at index ${openIndex}`);
}

/**
 * The `[start, end)` range of `"topKey"`'s object VALUE (`text[start]` is its
 * opening `{`, `text[end - 1]` its matching `}`) — the first `"topKey": {`
 * found scanning from the start of the document. Throws when absent, so a
 * key rename doesn't silently no-op the splice below.
 *
 * @internal Exported for testing.
 */
export function findTopLevelObjectRange(text, topKey) {
  const match = new RegExp(`"${topKey}"\\s*:\\s*\\{`).exec(text);

  if (!match) throw new Error(`findTopLevelObjectRange: no "${topKey}": { … } found`);

  const openIndex = match.index + match[0].length - 1;
  const closeIndex = findMatchingBracket(text, openIndex);

  return { start: openIndex, end: closeIndex + 1 };
}

/**
 * Render `entries` as it should appear as a group's array VALUE under
 * `"groups"` — i.e. exactly what `JSON.stringify(config, null, 2)` would
 * have produced at that position, but as a standalone string, never as a
 * step of re-serializing the whole document (see the module doc for why
 * that distinction is load-bearing).
 *
 * `JSON.stringify` renders starting at column 0; every line but the first
 * (the opening `[`, which sits right after the key on the same line) is
 * re-indented by `GROUP_KEY_INDENT` — the array's contents sit one level
 * deeper than the key that names it.
 *
 * @internal Exported for testing.
 */
export function renderGroupArray(entries) {
  return JSON.stringify(entries, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : GROUP_KEY_INDENT + line))
    .join("\n");
}

/**
 * Splice `entries` into `rawText`'s `groups.<groupName>` as a format-
 * preserving text edit — never by `JSON.parse`-ing the whole document,
 * mutating it, and `JSON.stringify`-ing it back out (see the module doc).
 * Every byte outside the `groups.<groupName>` value is left untouched,
 * including every other group and the whole `scenarios`/`frames`/`pools`/
 * `fragments` sections and their hand-formatted compact arrays.
 *
 * Replaces the group's array in place when the key already exists (a re-run
 * after a text tweak); otherwise appends it as the new last key of `groups`,
 * matching where a fresh `config.groups[groupName] = …` assignment would
 * have put it. The result is verified to still be valid JSON with the
 * expected group content — see the caller.
 *
 * @internal Exported for testing.
 */
export function spliceGroupIntoConfig(rawText, groupName, entries) {
  const groupsRange = findTopLevelObjectRange(rawText, "groups");
  const groupsText = rawText.slice(groupsRange.start, groupsRange.end);
  const renderedArray = renderGroupArray(entries);

  const existingKey = new RegExp(`"${groupName}"\\s*:\\s*\\[`).exec(groupsText);

  let newGroupsText;

  if (existingKey) {
    const arrayOpenIndex = existingKey.index + existingKey[0].length - 1;
    const arrayCloseIndex = findMatchingBracket(groupsText, arrayOpenIndex);

    newGroupsText = groupsText.slice(0, arrayOpenIndex) + renderedArray + groupsText.slice(arrayCloseIndex + 1);
  } else {
    // Insert right after the last non-whitespace character before the
    // object's closing "}" — i.e. right after whatever closes the previous
    // group's value — as the new last key.
    const closingBraceIndex = groupsText.length - 1;
    let insertAt = closingBraceIndex;

    while (insertAt > 0 && /\s/.test(groupsText[insertAt - 1])) insertAt--;

    const insertion = `,\n${GROUP_KEY_INDENT}"${groupName}": ${renderedArray}`;

    newGroupsText = groupsText.slice(0, insertAt) + insertion + groupsText.slice(insertAt);
  }

  return rawText.slice(0, groupsRange.start) + newGroupsText + rawText.slice(groupsRange.end);
}

function main() {
  const rawText = readFileSync(CONFIG_PATH, "utf8");
  const entries = buildCarNumberGroup();
  const updatedText = spliceGroupIntoConfig(rawText, GROUP_NAME, entries);

  // Prove the edit is both valid JSON and exactly the intended data before
  // trusting it to disk — a bracket-matching bug here would otherwise write
  // a corrupt (or silently wrong) config.
  const reparsed = JSON.parse(updatedText);

  if (JSON.stringify(reparsed.groups[GROUP_NAME]) !== JSON.stringify(entries)) {
    throw new Error(`spliceGroupIntoConfig produced unexpected content for "${GROUP_NAME}" — refusing to write`);
  }

  writeFileSync(CONFIG_PATH, updatedText);
  console.log(`${GROUP_NAME} group: ${entries.length} entries`);
}

// Direct-exec guard: only run main() when this file was executed as the entry
// script, so importing the pure functions above (from the test) never writes
// the config as a side effect of import.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  main();
}
