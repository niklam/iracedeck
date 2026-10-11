import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import {
  MEMBERSHIP_URL,
  SUPPORT_BUTTON_IMAGE_HEIGHT,
  SUPPORT_BUTTON_IMAGE_URL,
  SUPPORT_BUTTON_IMAGE_WIDTH,
  SUPPORT_URL,
} from "../packages/website/src/data/support.ts";

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

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".svg",
  ".ts",
  ".tsx",
  ".webmanifest",
  ".yaml",
  ".yml",
]);

let sources;

/**
 * Every text file of the website package that git tracks or would add, with
 * its text: the sources, `astro.config.mjs` (where the site's third-party
 * script tags are declared), `public/` and the package's own scripts. Asking
 * git keeps `node_modules`, `dist` and the generated gallery out without a list
 * of them here. Read once, on first use, so a filtered run that skips these
 * tests reads nothing.
 */
function websiteSources() {
  sources ??= execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/website"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => TEXT_EXTENSIONS.has(path.extname(file)) && existsSync(path.join(repoRoot, file)))
    .map((file) => ({ file, text: readFileSync(path.join(repoRoot, file), "utf8") }));

  return sources;
}

/**
 * Every mention of one of Buy Me a Coffee's domains in `text`, as the whole
 * token it is part of. Not only `https://` URLs: a protocol-relative
 * `//cdnjs…`, a link typed without its scheme and the `bmc.link` short domain
 * are the ways a copy would slip past a stricter pattern.
 *
 * The domain is found first and the token grown outwards from it. One pattern
 * for the whole token would rescan every long unbroken run in the files (a
 * data URI, a line of JSON) from each of its characters.
 */
function buyMeACoffeeMentions(text) {
  const endsToken = (character) => /[\s"'<>()`]/.test(character);
  const mentions = [];
  let covered = 0;

  for (const match of text.matchAll(/buymeacoffee\.com|bmc\.link/gi)) {
    // A second domain inside a token already reported is the same mention.
    if (match.index < covered) continue;

    let start = match.index;
    let end = match.index + match[0].length;

    while (start > covered && !endsToken(text[start - 1])) start--;
    while (end < text.length && !endsToken(text[end])) end++;

    mentions.push(text.slice(start, end));
    covered = end;
  }

  return mentions;
}

let sourceMentions;

/** Every mention in the website package, with the file it is in. */
function mentionsInSources() {
  sourceMentions ??= websiteSources().flatMap(({ file, text }) =>
    buyMeACoffeeMentions(text).map((link) => ({ file, link })),
  );

  return sourceMentions;
}

const readDocsPage = (name) => readFileSync(path.join(docsDir, name), "utf8");
const readComponent = () => readFileSync(path.join(websiteSrc, "components", "SupportSection.astro"), "utf8");

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
    const component = readComponent();

    expect(component).toContain("href={SUPPORT_URL}");
    expect(component).toContain("href={MEMBERSHIP_URL}");
    expect(component).toContain("src={SUPPORT_BUTTON_IMAGE_URL}");
    expect(buyMeACoffeeMentions(component)).toEqual([]);
  });

  it("reserves the image's box from data/support.ts, beside the text that sets its width", () => {
    const component = readComponent();

    expect(component).toContain("width={SUPPORT_BUTTON_IMAGE_WIDTH}");
    expect(component).toContain("height={SUPPORT_BUTTON_IMAGE_HEIGHT}");

    for (const size of [SUPPORT_BUTTON_IMAGE_WIDTH, SUPPORT_BUTTON_IMAGE_HEIGHT]) {
      expect(Number.isInteger(size) && size > 0).toBe(true);
    }
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

  describe("the website package's files", () => {
    it("are found, astro.config.mjs and the data module's three links included", () => {
      // The two checks below pass on an empty list, so prove the list is not empty.
      const files = websiteSources().map(({ file }) => file);
      const inDataModule = mentionsInSources()
        .filter(({ file }) => file === "packages/website/src/data/support.ts")
        .map(({ link }) => link);

      expect(files.length).toBeGreaterThan(80);
      expect(files).toContain("packages/website/astro.config.mjs");
      expect(inDataModule).toEqual(expect.arrayContaining([SUPPORT_URL, MEMBERSHIP_URL, SUPPORT_BUTTON_IMAGE_URL]));
    });

    it("hold the developer docs page's own copy of the link to SUPPORT_URL", () => {
      // The one link typed by hand: a Markdown page cannot import the constant.
      // The check below would also refuse a stale copy; this one proves the
      // page is read, and that the copy is still there to be checked.
      const inDeveloperDocs = mentionsInSources()
        .filter(({ file }) => file === "packages/website/src/content/docs/docs/development/index.md")
        .map(({ link }) => link);

      expect(inDeveloperDocs).toEqual([SUPPORT_URL]);
    });

    it("name no Buy Me a Coffee link that is not one of the three", () => {
      const allowed = new Set([SUPPORT_URL, MEMBERSHIP_URL, SUPPORT_BUTTON_IMAGE_URL]);

      expect(mentionsInSources().filter(({ link }) => !allowed.has(link))).toEqual([]);
    });

    it("never load a Buy Me a Coffee widget script", () => {
      const withWidget = websiteSources()
        .filter(({ text }) => /bmc-(?:button|widget)/i.test(text))
        .map(({ file }) => file);

      expect(mentionsInSources().filter(({ link }) => /cdnjs\.buymeacoffee\.com/i.test(link))).toEqual([]);
      expect(withWidget).toEqual([]);
    });
  });

  it("sees a copy typed without a scheme, protocol-relative or on the short domain", () => {
    expect(buyMeACoffeeMentions('<script src="//cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js">')).toEqual([
      "//cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js",
    ]);
    expect(buyMeACoffeeMentions("see [here](BuyMeACoffee.com/niklaslampn) or bmc.link/niklaslampen")).toEqual([
      "BuyMeACoffee.com/niklaslampn",
      "bmc.link/niklaslampen",
    ]);
    expect(buyMeACoffeeMentions("Buy Me a Coffee draws the button")).toEqual([]);
  });
});
