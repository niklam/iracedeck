/**
 * Measured text widths for the dash box (#801): the advance widths of bold
 * Arial, which the box draws in, so a check of whether a label or a pair of
 * neighbours fits can be made without a font engine. Arimo, the font the
 * plugin's rasterizer bundles, is metric-compatible with Arial, so these are
 * its widths too.
 *
 * Unlike `fitValueFontSize`'s 0.6 em average, which fits a value generously,
 * this is for the checks where a wrong answer is an overlap.
 */

/** Advance widths of Arial Bold, in thousandths of an em. */
const ARIAL_BOLD_ADVANCE: Readonly<Record<string, number>> = {
  " ": 278,
  "!": 333,
  '"': 474,
  "#": 556,
  $: 556,
  "%": 889,
  "&": 722,
  "'": 238,
  "(": 333,
  ")": 333,
  "*": 389,
  "+": 584,
  ",": 278,
  "-": 333,
  ".": 278,
  "/": 278,
  "0": 556,
  "1": 556,
  "2": 556,
  "3": 556,
  "4": 556,
  "5": 556,
  "6": 556,
  "7": 556,
  "8": 556,
  "9": 556,
  ":": 333,
  ";": 333,
  "<": 584,
  "=": 584,
  ">": 584,
  "?": 611,
  "@": 975,
  A: 722,
  B: 722,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 556,
  K: 722,
  L: 611,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  "[": 333,
  "]": 333,
  _: 556,
  a: 556,
  b: 611,
  c: 556,
  d: 611,
  e: 556,
  f: 333,
  g: 611,
  h: 611,
  i: 278,
  j: 278,
  k: 556,
  l: 278,
  m: 889,
  n: 611,
  o: 611,
  p: 611,
  q: 611,
  r: 389,
  s: 556,
  t: 333,
  u: 611,
  v: 556,
  w: 778,
  x: 556,
  y: 556,
  z: 500,
  " ": 278,
};

/** A character the table does not hold counts a full em: an overestimate, so a check fails rather than overlaps. */
const UNKNOWN_ADVANCE = 1000;

/**
 * The width in pixels of `text` set in bold Arial at `fontSize`: the sum of
 * its characters' advance widths, without kerning.
 */
export function boldTextWidth(text: string, fontSize: number): number {
  let units = 0;

  for (const char of text) units += ARIAL_BOLD_ADVANCE[char] ?? UNKNOWN_ADVANCE;

  return (units * fontSize) / 1000;
}
