// Pure helpers for stamping the changelog's in-development `_Unreleased_` date
// line with the real release date during a stable release (issue #690).
//
// `stampChangelog` is dependency-free and side-effect-free so the
// stamping/skip logic is unit-testable in isolation; `scripts/release-hooks.mjs`
// owns the file I/O, `git add`, and the live `new Date()` (via `formatLocalDate`).

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Stamp the `_Unreleased_` date line of the section matching `version` with
 * `dateStr` (a `YYYY-MM-DD` string). Pure — returns a new content string and a
 * status; never throws and never touches the filesystem.
 *
 * @param {string} content - The full changelog.mdx contents.
 * @param {string} version - The release version (may carry a pre-release suffix).
 * @param {string} dateStr - The release date as `YYYY-MM-DD`.
 * @returns {{ content: string, stamped: boolean, reason: string }}
 */
export function stampChangelog(content, version, dateStr) {
  // Pre-releases (-dev / -rc / -alpha / -beta) get no section of their own, so
  // never stamp on them.
  if (version.includes("-")) {
    return { content, stamped: false, reason: `Pre-release ${version} — skipping changelog date stamp` };
  }

  const numericVersion = version.replace(/[-+].*$/, "");

  // Match the `## <version>` heading exactly (anchored end-of-line) so e.g.
  // 1.22.2 never matches `## 1.22.20`.
  const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(numericVersion)}[ \\t]*\\r?$`, "m");
  const headingMatch = headingRe.exec(content);
  if (!headingMatch) {
    return { content, stamped: false, reason: `No "## ${numericVersion}" section in changelog — skipping date stamp` };
  }

  // Bound the search to this section (heading → next `## ` heading or EOF) so a
  // later section is never touched.
  const sectionStart = headingMatch.index;
  const nextHeadingRe = /^##[ \t]+/gm;
  nextHeadingRe.lastIndex = sectionStart + headingMatch[0].length;
  const nextMatch = nextHeadingRe.exec(content);
  const sectionEnd = nextMatch ? nextMatch.index : content.length;
  const section = content.slice(sectionStart, sectionEnd);

  // Capture any trailing whitespace / CR so CRLF line endings are preserved.
  const unreleasedRe = /^_Unreleased_([ \t]*\r?)$/m;
  if (unreleasedRe.test(section)) {
    const newSection = section.replace(unreleasedRe, `_${dateStr}_$1`);
    const newContent = content.slice(0, sectionStart) + newSection + content.slice(sectionEnd);
    return { content: newContent, stamped: true, reason: `Stamped "## ${numericVersion}" → _${dateStr}_` };
  }

  const dateMatch = /^_(\d{4}-\d{2}-\d{2})_[ \t]*\r?$/m.exec(section);
  if (dateMatch) {
    return {
      content,
      stamped: false,
      reason: `Section "## ${numericVersion}" already dated (_${dateMatch[1]}_) — skipping`,
    };
  }

  return { content, stamped: false, reason: `No _Unreleased_ date line under "## ${numericVersion}" — skipping` };
}

/**
 * Format a Date as a zero-padded `YYYY-MM-DD` string in local time — matching
 * how the release date is written by hand when cutting a release.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
