/**
 * Author the `corner-names` voice-config group from the track-data name set
 * (issue #888). Deterministic + idempotent: reads default.voice.json, replaces
 * groups["corner-names"] wholesale, writes the file back. Entry text is the
 * SPOKEN form — numbers spelled out ("Turn five.", never "Turn 5") per the
 * ElevenLabs input convention. Names containing digits that no rule handles
 * make the script FAIL LOUDLY so a new dataset name can't ship with bad TTS
 * text — add an override below when that happens.
 *
 * Usage:
 *   pnpm --filter @iracedeck/track-data build
 *   node packages/audio-assets/scripts/generate-corner-names-group.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listCornerNames } from "../../track-data/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", "configs", "default.voice.json");

const ONES = [
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

function numberToWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  throw new Error(`numberToWords: unhandled number ${n}`);
}

/** Full-name overrides for oddballs the generic rules can't speak. */
const TEXT_OVERRIDES = {
  "130R": "One-thirty R.",
  "200R": "Two hundred R.",
  "180°": "One eighty.",
  "1er Ralentisseur": "Premier Ralentisseur.",
  "2e Ralentisseur": "Deuxième Ralentisseur.",
  "T3/T4": "Turn three and four.",
  "T6/T7": "Turn six and seven.",
  "T8/T9": "Turn eight and nine.",
  "T14 - Wall of Champions": "Wall of Champions.",
};

function spokenText(name) {
  if (TEXT_OVERRIDES[name]) return TEXT_OVERRIDES[name];

  const turn = /^Turn (\d+)$/.exec(name);
  if (turn) return `Turn ${numberToWords(Number(turn[1]))}.`;

  // "Turn 10A" / "Turn 5a" / "T15a" — number + sub-corner letter, spoken
  // "Turn ten A." / "Turn five A." / "Turn fifteen A."
  const lettered = /^(?:Turn |T)(\d+)([a-dA-D])$/.exec(name);
  if (lettered) return `Turn ${numberToWords(Number(lettered[1]))} ${lettered[2].toUpperCase()}.`;

  if (/\d/.test(name)) {
    // Standalone number tokens inside a longer name read naturally as words
    // ("Bocht 10" → "Bocht ten.", "Expo 92" → "Expo ninety-two.").
    const spelled = name.replace(/\b(\d+)\b/g, (_, d) => numberToWords(Number(d)));
    if (/\d/.test(spelled)) throw new Error(`No TTS rule for "${name}" — add a TEXT_OVERRIDES entry.`);
    return `${spelled}.`;
  }

  return `${name}.`;
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
config.groups["corner-names"] = listCornerNames().map(({ name, slug }) => ({
  name: `${slug}-01`,
  text: spokenText(name),
}));
writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`corner-names group: ${config.groups["corner-names"].length} entries`);
