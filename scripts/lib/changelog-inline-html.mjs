// Renders one changelog bullet's inline markdown to HTML for the plugin's What's
// New pane (issue #1011).
//
// Pure and dependency-free. Deliberately NOT a general markdown implementation:
// it covers exactly the inline syntax `.claude/rules/changelog.md` allows in a
// bullet — code spans, bold, emphasis and links — and throws on a link it cannot
// safely hand to the settings window, so an unsupported construct fails the
// generator rather than reaching a user as raw markup.
//
// Safety: the text is HTML-escaped BEFORE any markup is produced, and code spans
// and links are lifted out behind sentinels first so their contents can never be
// reinterpreted. The output is therefore safe to emit with EJS's raw `<%-`, which
// is what `settings-window-changelog.ejs` does.

/** Site-relative changelog links are resolved against the public website. */
export const WEBSITE_ORIGIN = "https://iracedeck.com";

/** Thrown for inline syntax the pane cannot render. */
export class InlineMarkdownError extends Error {
  constructor(message) {
    super(message);
    this.name = "InlineMarkdownError";
  }
}

// U+0000 cannot appear in the source (it is not valid in a text file we author)
// and survives escaping untouched, so it makes a collision-proof sentinel.
const SENTINEL = "\u0000";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Resolve a changelog link target to an absolute URL the settings window can open.
 *
 * The window is served from the plugin's own loopback origin, so a site-relative
 * href would resolve against the plugin rather than the website. Root-relative
 * targets are therefore rebased onto the public site; anything that is not
 * http(s) is refused, since the PI external-link handler only opens those.
 */
function resolveHref(target) {
  const href = target.trim();

  if (href.startsWith("/")) return `${WEBSITE_ORIGIN}${href}`;
  if (/^https?:\/\//i.test(href)) return href;

  throw new InlineMarkdownError(
    `Changelog link "${target}" must start with "/" (a website path) or "http(s)://" — the settings window cannot open anything else.`,
  );
}

/**
 * Render one bullet's inline markdown as safe HTML.
 *
 * @param {string} text - The bullet text, without its leading `- `.
 * @returns {string} HTML, already escaped.
 * @throws {InlineMarkdownError} on a link target the window cannot open.
 */
export function renderInlineMarkdown(text) {
  /** @type {string[]} */
  const placeholders = [];
  const hold = (html) => {
    placeholders.push(html);
    return `${SENTINEL}${placeholders.length - 1}${SENTINEL}`;
  };

  // 1. Lift code spans out of the raw text: their contents are literal, so no
  //    later transform — nor the escaping of surrounding prose — may touch them.
  let working = String(text).replace(/`([^`]+)`/g, (_match, code) => hold(`<code>${escapeHtml(code)}</code>`));

  // 2. Links, lifted out of the RAW text too — twice over. A URL may legitimately
  //    contain `_` or `*`, which the emphasis passes below would otherwise chew
  //    through; and the href must be escaped exactly ONCE, which it cannot be if
  //    the target has already been through the prose escaping below (a `&` in a
  //    query string would come back out as `&amp;amp;`). Label and href are each
  //    escaped here instead — a code-span sentinel inside a label passes through
  //    escapeHtml untouched, since it carries none of the characters it rewrites.
  working = working.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label, target) =>
    hold(
      `<a href="${escapeHtml(resolveHref(target))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`,
    ),
  );

  // 3. Escape everything that is left before any markup is generated.
  working = escapeHtml(working);

  // 4. Bold before emphasis, so `**x**` is never read as two `*x*`.
  working = working.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "<strong>$1</strong>");
  working = working.replace(/\*(\S(?:[^*]*\S)?)\*/g, "<em>$1</em>");
  // Underscore emphasis only at word boundaries, so `race_ahead` stays literal.
  working = working.replace(/(^|[^A-Za-z0-9_])_(\S(?:[^_]*\S)?)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>");

  // 5. Put the lifted fragments back — recursively, because a lifted fragment can
  //    itself hold one (a code span inside a link label). `String.replace` never
  //    rescans what it substitutes, so a single pass would leave that inner
  //    sentinel in the output verbatim.
  const restore = (html) =>
    html.replace(/\u0000(\d+)\u0000/g, (_match, index) => restore(placeholders[Number(index)]));

  return restore(working);
}
