/**
 * Allow-list sanitizer for one changelog bullet's HTML (issue #1016).
 *
 * The Settings window renders bullets as HTML. For the notes compiled INTO the
 * build that is safe by construction — `scripts/lib/changelog-inline-html.mjs`
 * escapes the text before it produces any markup. The upstream check fetches
 * the same shape from iracedeck.com, and that content arrives over the network
 * into a page holding an authenticated socket to the plugin, so it is treated
 * as untrusted no matter who serves it.
 *
 * The generator emits exactly four constructs — `<code>`, `<strong>`, `<em>`
 * and an `<a>` with `href`/`target`/`rel`. This re-emits those and turns
 * everything else into literal text, so an unexpected construct shows up as
 * visible markup in a bullet rather than as behaviour on the page.
 *
 * Pure and dependency-free: a hand-rolled scanner rather than a DOM, because
 * deck-core runs in the plugin's Node process where there is no DOM, and the
 * grammar it has to cover is four tags wide.
 */

/** Tags kept as markup. Everything else is escaped into text. */
const ALLOWED_TAGS = new Set(["code", "strong", "em", "a"]);

/**
 * Matches one tag: `</?name ...attrs>`. Deliberately not a general HTML parser.
 * Built per call, never shared: a `g`-flagged regex carries `lastIndex`, and a
 * module-level one would make this function stateful across calls.
 */
const TAG_PATTERN = "<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>";

/** Matches `href="…"` / `href='…'` / bare `href=…` in a tag's attribute text. */
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Escape text for HTML. Entities that are already well formed are left alone,
 * so a bullet that legitimately contains `&amp;` is not published as
 * `&amp;amp;` — the generator escaped it once already.
 */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * The `href` an anchor may keep: an absolute http(s) URL. Anything else —
 * `javascript:`, `data:`, a relative path (which would resolve against the
 * plugin's loopback origin, not the website) — disqualifies the whole tag.
 */
function safeHref(attributes: string): string | undefined {
  const match = HREF.exec(attributes);

  if (!match) return undefined;

  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();

  return /^https?:\/\/\S+$/i.test(raw) ? raw : undefined;
}

/**
 * Sanitize one bullet's HTML to the allow-list.
 *
 * Unbalanced tags are escaped rather than silently repaired: a `<strong>` with
 * no closing tag would otherwise bleed its styling into the rest of the pane,
 * and a stray `</em>` would close a tag it never opened.
 */
export function sanitizeChangelogHtml(html: string): string {
  if (html === "") return "";

  const tag = new RegExp(TAG_PATTERN, "g");
  const open: string[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    const [raw, closing, rawName, attributes] = match;
    const name = rawName.toLowerCase();

    parts.push(escapeText(html.slice(cursor, match.index)));
    cursor = match.index + raw.length;

    if (!ALLOWED_TAGS.has(name)) {
      parts.push(escapeText(raw));
      continue;
    }

    if (closing === "/") {
      // A close with no matching open is text, not markup.
      if (open[open.length - 1] === name) {
        open.pop();
        parts.push(`</${name}>`);
      } else {
        parts.push(escapeText(raw));
      }

      continue;
    }

    if (name === "a") {
      const href = safeHref(attributes);

      if (href === undefined) {
        parts.push(escapeText(raw));
        continue;
      }

      open.push(name);
      parts.push(`<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`);
      continue;
    }

    open.push(name);
    parts.push(`<${name}>`);
  }

  parts.push(escapeText(html.slice(cursor)));

  // Anything still open never closed. Escaping the whole bullet is the honest
  // answer: the markup was not what it claimed to be, so none of it is trusted
  // — and the reader sees the tags rather than a silently restyled pane.
  if (open.length > 0) return escapeText(html);

  return parts.join("");
}
