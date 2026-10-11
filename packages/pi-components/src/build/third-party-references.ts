/**
 * Finds what a page would load from another site (#1303).
 *
 * The Settings window holds a write connection to the user's settings, so it
 * runs no code from another site: no `<script>`, stylesheet, font, frame or
 * media element in it may name another origin. An image may, when it is on a
 * short allow-list, and an anchor is the only other element that may carry an
 * absolute URL. `settings-window-no-third-party.test.ts` holds the window to
 * that with this scanner, over the template sources and the built pages.
 *
 * It is a tripwire for an honest mistake: somebody pasting a vendor's embed
 * snippet, or hotlinking an asset. It is not a filter a determined author could
 * not get past. It reads markup, CSS and the string literals of inline scripts,
 * as text, because half of what it reads is EJS that has not been rendered. It
 * does NOT read the JavaScript bundles the page loads (`pi-components.js`,
 * `sdpi-components.js`, the bridge), does not follow string concatenation, and
 * does not model a browser's comment and `srcdoc` parsing. What would hold
 * against all of that is a `Content-Security-Policy` on the settings server,
 * and none is in place. Within what it reads it is suspicious rather than
 * exact: a URL it cannot show to be a local file is reported, not waved through.
 */

export interface ThirdPartyReference {
  /** Where it was found: `<script src>`, `css url()`, `css @import`, `script text`. */
  where: string;
  /** The value as written. An EJS expression reads `{{ejs:<%= … %>}}`. */
  value: string;
  /** `remote` names another origin; `unresolved` could not be shown to be local. */
  why: "remote" | "unresolved";
}

export interface ThirdPartyScanOptions {
  /** Absolute URLs an `<img src>` may name, compared after HTML-decoding the attribute. */
  allowedImages?: readonly string[];
  /**
   * EJS expressions an `<img src>` may be, as `<%= EXPRESSION %>` and nothing
   * else. Only for a template source whose expression the caller has resolved
   * to an entry of `allowedImages`.
   */
  allowedImageExpressions?: readonly string[];
}

/**
 * The attributes that make an element fetch, embed or navigate to their value.
 * `xmlns` and its kin are absent on purpose: a namespace is a name, not a
 * reference.
 */
const URL_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "imagesrcset",
  "href",
  "xlink:href",
  "data",
  "poster",
  "action",
  "formaction",
  "background",
  "manifest",
  "codebase",
]);

/** The two that hold a comma-separated list of `url descriptor` candidates. */
const CANDIDATE_LIST_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

/** A tag from its `<` to its `>`, with a `>` inside a quoted value not ending it. */
const TAG_AT = /<([a-zA-Z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y;

/** The fallback for a tag the strict form cannot close: up to the next angle bracket. */
const LOOSE_TAG_AT = /<([a-zA-Z][\w:-]*)([^<>]*)/y;

/**
 * `name=value`. The optional backslashes are for markup inside a string
 * literal, where the quotes around a value arrive escaped.
 */
const ATTRIBUTE = /([^\s"'<>/=\\]+)\s*=\s*(?:\\?"([^"]*)"|\\?'([^']*)'|([^\s"'<>]+))/g;

/** What an EJS output tag is replaced with, so a tag's `>` is never its `%>`. */
const EJS_PLACEHOLDER = /\{\{ejs:(\d+)\}\}/;

/** A relative reference with nothing in it that a template or a script could be filling in. */
const STATIC_LOCAL = /^[\w./#?=&%~-]+$/;

/** A `<script>` element, from its opening tag to its closing one or the end of the text. */
const SCRIPT_ELEMENT = /<script\b(?:[^<>"']|"[^"]*"|'[^']*')*>([\s\S]*?)(?:<\/script\b|$)/gi;

/**
 * What script text is made of, as far as finding its string literals goes: an
 * escaped character, a comment, or a literal, whose content is captured. A
 * regular expression literal is not modelled; the escape is what keeps the
 * `\/\/` in one from opening a comment that would hide the rest of its line.
 */
const SCRIPT_TOKEN =
  /\\[\s\S]|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"((?:\\[\s\S]|[^"\\\n])*)"?|'((?:\\[\s\S]|[^'\\\n])*)'?|`((?:\\[\s\S]|[^`\\])*)`?/g;

/** The hosts that are this machine: the window's own server is one of them. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  colon: ":",
  sol: "/",
  bsol: "\\",
  period: ".",
  tab: "\t",
  newline: "\n",
};

/** Decodes the character references a browser would, as far as a URL can be hidden in them. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (match, hex, decimal, name) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));

    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));

    return NAMED_ENTITIES[String(name).toLowerCase()] ?? match;
  });
}

/**
 * A URL as a browser's parser would read it: tabs and newlines dropped,
 * surrounding spaces ignored, a backslash taken for a slash.
 */
function asParsed(raw: string): string {
  return decodeEntities(raw)
    .replace(/[\t\n\r]/g, "")
    .replace(/\\/g, "/")
    .trim();
}

/**
 * Whether a URL names another origin, is a local file, or cannot be told.
 *
 * Any scheme counts as another origin except `data:`, which carries its own
 * bytes; so does a protocol-relative `//host`.
 */
function classify(raw: string): "local" | "remote" | "unresolved" {
  const value = asParsed(raw);

  if (value === "") return "local";

  if (value.startsWith("//")) return "remote";

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase();

  if (scheme === "data") return "local";

  if (scheme !== undefined) return "remote";

  return STATIC_LOCAL.test(value) ? "local" : "unresolved";
}

/**
 * Whether a URL's host is this machine. The host is what follows any
 * `user@`, so a loopback address written as the user name of another host does
 * not pass for one.
 */
function isLoopback(raw: string): boolean {
  const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/+([^/?#]*)/i.exec(asParsed(raw))?.[1];

  if (authority === undefined) return false;

  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");

  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

interface Normalised {
  text: string;
  /** The EJS output tags taken out of `text`, by placeholder index, as `=EXPR` or `-EXPR`. */
  expressions: string[];
}

/**
 * Drops what is not a reference and makes the rest safe to tokenise: comments
 * (EJS, HTML, and CSS inside a `<style>`) go and each EJS output tag becomes a
 * placeholder. A scriptlet is read both ways, one per call:
 *
 * - `"code"` keeps its code and drops its delimiters, so the markup its string
 *   literals build is read like any other.
 * - `"gone"` drops it whole, so the comparison in `<img <% if (a < b) { %> src=…`
 *   cannot end the tag before the attribute that follows it.
 */
function normalise(source: string, scriptlets: "code" | "gone"): Normalised {
  const expressions: string[] = [];
  const text = source
    .replace(/<%#[\s\S]*?%>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => block.replace(/\/\*[\s\S]*?\*\//g, " "))
    .replace(/<%([=-])([\s\S]*?)[-_]?%>/g, (_match, kind: string, expression: string) => {
      expressions.push(kind + expression.trim());

      return `{{ejs:${expressions.length - 1}}}`;
    })
    .replace(scriptlets === "code" ? /<%_?|[-_]?%>/g : /<%[\s\S]*?%>/g, " ");

  return { text, expressions };
}

/** A value for a finding, with each placeholder turned back into the tag it stood for. */
function readable(value: string, expressions: string[]): string {
  return value.replace(new RegExp(EJS_PLACEHOLDER, "g"), (_match, index) => {
    const expression = expressions[Number(index)] ?? "";

    return `{{ejs:<%${expression[0] ?? ""} ${expression.slice(1)} %>}}`;
  });
}

/** The references the elements and the CSS of one normalised text make. */
function findInMarkup({ text, expressions }: Normalised, options: ThirdPartyScanOptions): ThirdPartyReference[] {
  const { allowedImages = [], allowedImageExpressions = [] } = options;
  const found: ThirdPartyReference[] = [];

  const isAllowedImage = (element: string, attribute: string, value: string): boolean => {
    if (element !== "img" || attribute !== "src") return false;

    if (allowedImages.includes(decodeEntities(value))) return true;

    const placeholder = new RegExp(`^${EJS_PLACEHOLDER.source}$`).exec(value.trim());
    const expression = placeholder ? expressions[Number(placeholder[1])] : undefined;

    // Escaped output only: `<%-` would write the URL's `&` into the attribute raw.
    return expression !== undefined && allowedImageExpressions.some((allowed) => expression === `=${allowed}`);
  };

  const judge = (value: string): "local" | "remote" | "unresolved" =>
    EJS_PLACEHOLDER.test(value) ? "unresolved" : classify(value);

  // Tried at EVERY `<name`, not from where the last tag ended: in script text a
  // stray `a<b` opens a tag that is not one, and the next real tag may sit
  // inside what it swallowed.
  for (const start of text.matchAll(/<(?=[a-zA-Z])/g)) {
    TAG_AT.lastIndex = start.index;
    LOOSE_TAG_AT.lastIndex = start.index;

    const tag = TAG_AT.exec(text) ?? LOOSE_TAG_AT.exec(text);

    if (!tag) continue;

    const element = tag[1].toLowerCase();

    if (element === "a") continue;

    for (const [, name, double, single, bare] of tag[2].matchAll(ATTRIBUTE)) {
      const attribute = name.toLowerCase();

      if (!URL_ATTRIBUTES.has(attribute)) continue;

      const value = double ?? single ?? bare ?? "";

      if (isAllowedImage(element, attribute, value)) continue;

      const candidates = CANDIDATE_LIST_ATTRIBUTES.has(attribute)
        ? value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0])
        : [value];
      const verdicts = candidates.map(judge);
      const why = verdicts.includes("remote") ? "remote" : verdicts.includes("unresolved") ? "unresolved" : undefined;

      if (why) found.push({ where: `<${element} ${attribute}>`, value: readable(value, expressions), why });
    }
  }

  // CSS, wherever it is written: a `<style>`, a `style` attribute, a string.
  // `new URL(…)` is script, not a stylesheet's `url(…)`.
  for (const [, double, single, bare] of text.matchAll(
    /(?<![\w$.-])(?<!\bnew\s+)url\(\s*(?:\\?"([^"]*)"|\\?'([^']*)'|([^)"']*))\s*\)/gi,
  )) {
    const value = double ?? single ?? bare ?? "";
    const why = judge(value);

    if (why !== "local") found.push({ where: "css url()", value: readable(value, expressions), why });
  }

  // The string form only: `@import url(…)` is already a `url(…)` above.
  for (const [, value] of text.matchAll(/@import\s+\\?["']([^"']*)["']/gi)) {
    const why = judge(value);

    if (why !== "local") found.push({ where: "css @import", value: readable(value, expressions), why });
  }

  return found;
}

/**
 * The string literals in the `<script>` bodies of one normalised text that name
 * another origin: what a script would hand to `fetch`, `import`, an element's
 * `src`. A URL in a script comment is no literal, and one on this machine is the
 * window talking to its own server. Whole literals only: an address put together
 * from pieces is not followed.
 */
function findInScriptText({ text, expressions }: Normalised): ThirdPartyReference[] {
  const found: ThirdPartyReference[] = [];

  for (const [, script] of text.matchAll(SCRIPT_ELEMENT)) {
    for (const [, double, single, template] of script.matchAll(SCRIPT_TOKEN)) {
      const value = double ?? single ?? template;

      if (value === undefined || classify(value) !== "remote" || isLoopback(value)) continue;

      found.push({ where: "script text", value: readable(value, expressions), why: "remote" });
    }
  }

  return found;
}

/**
 * Every reference in `source` to something another site would serve, other
 * than an anchor's link and an allow-listed image, each reported once. Empty
 * when there is none.
 *
 * @param source - HTML or EJS text: a built page, a template or a partial.
 */
export function findThirdPartyReferences(source: string, options: ThirdPartyScanOptions = {}): ThirdPartyReference[] {
  const withCode = normalise(source, "code");
  const withoutScriptlets = normalise(source, "gone");
  const seen = new Set<string>();

  // Inline scripts are read without the scriptlets only: a scriptlet runs at
  // build time, so a string in one is not something the page's script holds.
  return [
    ...findInMarkup(withCode, options),
    ...findInMarkup(withoutScriptlets, options),
    ...findInScriptText(withoutScriptlets),
  ].filter(({ where, value, why }) => {
    const key = `${where}\n${value}\n${why}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}
