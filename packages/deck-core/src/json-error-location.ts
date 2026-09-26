/**
 * Where a JSON document first goes wrong, as a line and column (issue #1036).
 *
 * `JSON.parse`'s message cannot be relied on for this: only Node 22+ appends
 * `(line L column C)`, the Mirabox and Ulanzi hosts run the plugin on Node 20,
 * which gives a bare character offset, and an `Unexpected token` message gives
 * no position on any version. So the settings store asks this small validator
 * instead, and only after `JSON.parse` has already rejected the text — it is
 * never on the success path.
 *
 * The position is where a strict parser first finds something it cannot
 * accept. For a trailing comma that is the token AFTER the comma (the closing
 * brace), which is why the banner says "at, or just before".
 */

export interface JsonErrorLocation {
  /** 1-based. */
  line: number;
  /** 1-based, counted in UTF-16 code units, as an editor's column indicator does for ordinary text. */
  column: number;
}

class Failure {
  constructor(readonly offset: number) {}
}

/**
 * The location of the first syntax error in `text`, or undefined when `text`
 * is valid JSON. A leading byte-order mark is the caller's business.
 */
export function locateJsonError(text: string): JsonErrorLocation | undefined {
  let i = 0;

  const fail = (): never => {
    throw new Failure(i);
  };
  const skipWhitespace = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const expect = (literal: string): void => {
    for (const char of literal) {
      if (text[i] !== char) fail();

      i++;
    }
  };
  const digits = (): void => {
    if (!/[0-9]/.test(text[i] ?? "")) fail();

    while (/[0-9]/.test(text[i] ?? "")) i++;
  };

  const string = (): void => {
    expect('"');

    for (;;) {
      const char = text[i];

      if (char === undefined || char < " ") fail();

      if (char === '"') {
        i++;

        return;
      }

      if (char === "\\") {
        i++;
        const escape = text[i];

        if (escape === "u") {
          i++;

          for (let n = 0; n < 4; n++) {
            if (!/[0-9a-fA-F]/.test(text[i] ?? "")) fail();

            i++;
          }
        } else {
          if (escape === undefined || !'"\\/bfnrt'.includes(escape)) fail();

          i++;
        }
      } else {
        i++;
      }
    }
  };

  const number = (): void => {
    if (text[i] === "-") i++;

    if (text[i] === "0") i++;
    else digits();

    if (text[i] === ".") {
      i++;
      digits();
    }

    if (text[i] === "e" || text[i] === "E") {
      i++;

      if (text[i] === "+" || text[i] === "-") i++;

      digits();
    }
  };

  const value = (): void => {
    skipWhitespace();
    const char = text[i];

    if (char === "{") {
      i++;
      skipWhitespace();

      if (text[i] === "}") {
        i++;

        return;
      }

      for (;;) {
        skipWhitespace();
        string();
        skipWhitespace();
        expect(":");
        value();
        skipWhitespace();

        if (text[i] === "}") {
          i++;

          return;
        }

        expect(",");
      }
    }

    if (char === "[") {
      i++;
      skipWhitespace();

      if (text[i] === "]") {
        i++;

        return;
      }

      for (;;) {
        value();
        skipWhitespace();

        if (text[i] === "]") {
          i++;

          return;
        }

        expect(",");
      }
    }

    if (char === '"') return string();

    if (char === "t") return expect("true");

    if (char === "f") return expect("false");

    if (char === "n") return expect("null");

    if (char === "-" || /[0-9]/.test(char ?? "")) return number();

    fail();
  };

  try {
    value();
    skipWhitespace();

    if (i < text.length) fail();

    return undefined;
  } catch (error: unknown) {
    if (!(error instanceof Failure)) throw error;

    return toLineColumn(text, error.offset);
  }
}

function toLineColumn(text: string, offset: number): JsonErrorLocation {
  let line = 1;
  let lineStart = 0;

  for (let k = 0; k < offset && k < text.length; k++) {
    if (text[k] === "\n") {
      line++;
      lineStart = k + 1;
    }
  }

  return { line, column: offset - lineStart + 1 };
}
