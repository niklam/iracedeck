/**
 * Reads the constants `partials/settings-window-support.ejs` declares (#1303).
 *
 * The partial opens with a scriptlet of `var NAME = "…";` lines: the plugin's
 * own copy of the website's support links. Nothing can import an EJS partial,
 * so every test that needs one of those values reads it from the file as text,
 * and they all read it here, so they cannot come to disagree about what a
 * declaration looks like.
 *
 * Takes the text, not a path, and imports nothing, so a plain `.mjs` test under
 * `scripts/` can use it as readily as a package's own.
 */

/** The first scriptlet that is code: not a comment, not an output tag. */
const LEADING_SCRIPTLET = /<%(?![#=%-])_?([\s\S]*?)[-_]?%>/;

/**
 * One declaration on a line of its own. No backslash in the value: an escape
 * would make the text between the quotes something other than the string.
 */
const DECLARATION = /^[ \t]*var ([A-Za-z_$][\w$]*) = "([^"\\\n\r]*)";[ \t]*$/;

/**
 * Every constant the partial's leading scriptlet declares, by name.
 *
 * Strict on purpose, since what it returns is compared with the website's
 * values and with an allow-list: a `var` in that scriptlet that is not a
 * one-line `var NAME = "…";`, and a name declared again anywhere in the file,
 * are errors, not something to read around.
 *
 * @param source - The partial's text.
 * @param required - Names that must be among them.
 * @throws When the file has no leading scriptlet, a declaration is not in that
 *   shape, a name is declared more than once, or a required name is missing.
 */
export function readSupportPartialConstants(source: string, required: readonly string[] = []): Record<string, string> {
  const code = source.replace(/<%#[\s\S]*?%>/g, "");
  const scriptlet = LEADING_SCRIPTLET.exec(code)?.[1];

  if (scriptlet === undefined) {
    throw new Error("The support partial has no leading <% … %> scriptlet to read its constants from.");
  }

  const constants: Record<string, string> = {};

  for (const line of scriptlet.split(/\r?\n/)) {
    if (!/^\s*var\b/.test(line)) continue;

    const declaration = DECLARATION.exec(line);

    if (!declaration) {
      throw new Error(
        `The support partial declares a constant that is not a one-line \`var NAME = "…";\`: ${line.trim()}`,
      );
    }

    const [, name, value] = declaration;
    const declarations = code.match(new RegExp(`\\bvar ${name.replaceAll("$", "\\$")}(?![\\w$])`, "g")) ?? [];

    if (declarations.length !== 1) {
      throw new Error(`The support partial declares ${name} ${declarations.length} times; it must be declared once.`);
    }

    constants[name] = value;
  }

  for (const name of required) {
    if (!Object.hasOwn(constants, name)) {
      throw new Error(
        `The support partial does not declare ${name}: its leading scriptlet has no \`var ${name} = "…";\` line.`,
      );
    }
  }

  return constants;
}
