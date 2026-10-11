import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { MEMBERSHIP_URL, SUPPORT_BUTTON_IMAGE_URL, SUPPORT_URL } from "../packages/website/src/data/support.ts";

/**
 * The website's support section (#1299).
 *
 * The homepage used to carry its Buy Me a Coffee button as a widget `<script>`
 * typed into `index.mdx`, and the Download page had none. Both now render
 * `SupportSection.astro`, whose links come from `data/support.ts`. What this
 * holds is the part nothing else would notice: a page that drops the section
 * or moves it above a download button, a second hand-typed copy of a link that
 * then drifts, and the widget script coming back.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const websiteSrc = path.join(repoRoot, "packages", "website", "src");
const docsDir = path.join(websiteSrc, "content", "docs");

const TEXT_EXTENSIONS = new Set([".astro", ".css", ".js", ".json", ".md", ".mdx", ".mjs", ".ts"]);

/** Every text source under the website's `src/`, as repo-relative POSIX paths. */
function websiteSources() {
  return readdirSync(websiteSrc, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/** Every Buy Me a Coffee URL in `text`, up to the character that ends it in prose or markup. */
function buyMeACoffeeUrls(text) {
  return text.match(/https?:\/\/[^\s"'<>()`]*buymeacoffee\.com[^\s"'<>()`]*/g) ?? [];
}

const readDocsPage = (name) => readFileSync(path.join(docsDir, name), "utf8");

/** Where `needle` last occurs in `source`. A landmark that is gone fails here, not as a comparison against -1. */
function lastPosition(source, needle) {
  const position = source.lastIndexOf(needle);

  expect(position, `"${needle}" not found`).toBeGreaterThanOrEqual(0);

  return position;
}

describe("website support section", () => {
  describe.each(["index.mdx", "downloads.mdx"])("%s", (page) => {
    const source = readDocsPage(page);

    it("imports the shared component", () => {
      expect(source).toContain('import SupportSection from "../../components/SupportSection.astro";');
    });

    it("renders it exactly once", () => {
      expect(source.match(/<SupportSection\b/g)).toHaveLength(1);
    });
  });

  it("sits under the download cards on the Download page, never above a download button", () => {
    const source = readDocsPage("downloads.mdx");
    const section = lastPosition(source, "<SupportSection />");

    expect(section).toBeGreaterThan(lastPosition(source, "<DownloadLink"));
    expect(section).toBeLessThan(lastPosition(source, 'class="download-help">After downloading'));
  });

  it("sits between Works with and the category cards on the homepage", () => {
    const source = readDocsPage("index.mdx");
    const section = lastPosition(source, "<SupportSection />");

    expect(section).toBeGreaterThan(lastPosition(source, 'class="works-with-note"'));
    expect(section).toBeLessThan(lastPosition(source, 'class="category-grid"'));
  });

  it("takes every link from data/support.ts", () => {
    const component = readFileSync(path.join(websiteSrc, "components", "SupportSection.astro"), "utf8");

    expect(component).toContain("href={SUPPORT_URL}");
    expect(component).toContain("href={MEMBERSHIP_URL}");
    expect(component).toContain("src={SUPPORT_BUTTON_IMAGE_URL}");
    expect(buyMeACoffeeUrls(component)).toEqual([]);
  });

  describe("the links", () => {
    it("are https", () => {
      for (const link of [SUPPORT_URL, MEMBERSHIP_URL, SUPPORT_BUTTON_IMAGE_URL]) {
        expect(new URL(link).protocol).toBe("https:");
      }
    });

    it("point the membership link at the support page's own membership", () => {
      expect(MEMBERSHIP_URL).toBe(`${SUPPORT_URL}/membership`);
    });

    it("draw the button for the same slug the button links to", () => {
      const slug = new URL(SUPPORT_URL).pathname.slice(1);

      expect(slug).not.toBe("");
      expect(new URL(SUPPORT_BUTTON_IMAGE_URL).searchParams.get("slug")).toBe(slug);
    });
  });

  describe("the website's sources", () => {
    const sources = websiteSources().map((file) => ({ file, text: readFileSync(path.join(repoRoot, file), "utf8") }));
    const found = sources.flatMap(({ file, text }) => buyMeACoffeeUrls(text).map((link) => ({ file, link })));

    it("are found by the walker, the data module's three links included", () => {
      // The two checks below pass on an empty list, so prove the list is not empty.
      expect(sources.length).toBeGreaterThan(50);
      expect(
        found.filter(({ file }) => file === "packages/website/src/data/support.ts").map(({ link }) => link),
      ).toEqual([SUPPORT_URL, MEMBERSHIP_URL, SUPPORT_BUTTON_IMAGE_URL]);
    });

    it("name no Buy Me a Coffee URL that is not one of the three", () => {
      const allowed = new Set([SUPPORT_URL, MEMBERSHIP_URL, SUPPORT_BUTTON_IMAGE_URL]);

      expect(found.filter(({ link }) => !allowed.has(link))).toEqual([]);
    });

    it("never load the Buy Me a Coffee widget script", () => {
      expect(found.filter(({ link }) => new URL(link).hostname === "cdnjs.buymeacoffee.com")).toEqual([]);
      expect(sources.filter(({ text }) => text.includes("bmc-button")).map(({ file }) => file)).toEqual([]);
    });
  });
});
