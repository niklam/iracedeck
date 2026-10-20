/**
 * The raw control bytes no text file in the repo may carry (#1103): every C0
 * byte except tab, LF and CR, plus DEL. Written with escapes, which is the
 * whole point. One definition for its three readers: the Edit/Write hook and
 * the spec-commit rule (`scripts/claude-hooks/`), the staged-spec pre-commit
 * check (`scripts/check-staged-spec-bytes.mjs`, #1466) and the tree-wide test
 * (`scripts/no-control-bytes.test.mjs`).
 */

// eslint-disable-next-line no-control-regex
export const CONTROL_BYTE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * Every control byte in `buffer` other than tab, LF and CR, with its 1-based
 * line and character column (UTF-8 continuation bytes do not start a column,
 * so the position matches the editor's).
 */
export function findControlBytes(buffer) {
  // Nearly every file is clean; skip the byte walk for those. A latin1 view
  // makes each byte one character.
  if (!CONTROL_BYTE.test(buffer.toString("latin1"))) return [];

  const found = [];
  let line = 1;
  let column = 0;

  for (const byte of buffer) {
    if (byte === 0x0a) {
      line += 1;
      column = 0;
      continue;
    }

    if ((byte & 0xc0) !== 0x80) column += 1;

    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0d) || byte === 0x7f) {
      found.push({ line, column, byte });
    }
  }

  return found;
}

/** A byte as `0x00`. */
export function hex(byte) {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}
