import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No `.astro` file in the website may spell a script tag in its frontmatter.
 *
 * Vite's dependency scan does not parse an `.astro` file: it reads it as text
 * and takes everything from the first `<script>` to the next `</script>` for a
 * script. `DownloadLink.astro` named the tag in a frontmatter comment, so the
 * scan read the rest of that comment and the whole template as JavaScript and
 * failed, and every `astro dev` started with "Failed to run dependency scan.
 * Skipping dependency pre-bundling". The build never runs that scan, so nothing
 * else went red.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const websiteSrc = path.join(repoRoot, "packages", "website", "src");

/** The text between an `.astro` file's opening and closing `---` fences, or "" when it has none. */
function frontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?$/m.exec(source);

  return source.startsWith("---") && match ? match[1] : "";
}

/** The 1-based frontmatter lines of `source` that spell a script tag. */
function scriptTagLines(source) {
  return frontmatter(source)
    .split(/\r?\n/)
    .flatMap((line, index) => (/<\/?script\b/i.test(line) ? [index + 2] : []));
}

const astroFiles = readdirSync(websiteSrc, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".astro"))
  .map((entry) => path.join(entry.parentPath, entry.name));

describe("website .astro frontmatter", () => {
  it("is found by the walker", () => {
    // The check below passes on an empty list, so prove the list is not empty.
    expect(astroFiles.length).toBeGreaterThan(5);
  });

  it("catches the shape that broke the dependency scan, and only inside the frontmatter", () => {
    const broken =
      "---\n// A single bundled\n// <script> (below) wires every link\nconst a = 1;\n---\n\n<a />\n<script>\n  a;\n</script>\n";
    const fine =
      "---\n// A single bundled script (below) wires every link\nconst a = 1;\n---\n\n<a />\n<script>\n  a;\n</script>\n";

    expect(scriptTagLines(broken)).toEqual([3]);
    expect(scriptTagLines(fine)).toEqual([]);
    expect(scriptTagLines("<a />\n<script>\n  a;\n</script>\n")).toEqual([]);
  });

  it("never spells a script tag", () => {
    const offenders = astroFiles.flatMap((file) =>
      scriptTagLines(readFileSync(file, "utf8")).map(
        (line) => `${path.relative(repoRoot, file).split(path.sep).join("/")}:${line}`,
      ),
    );

    expect(offenders).toEqual([]);
  });
});
