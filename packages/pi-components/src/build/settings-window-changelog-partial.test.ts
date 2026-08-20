import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/settings-window-changelog.ejs` (not a fixture).
 *
 * The What's New tab used to embed https://iracedeck.com/changelog/ in an
 * iframe, which showed whatever the website said rather than what the user had
 * installed, needed internet, and dropped a white page into a dark window
 * (#1011). The partial now renders the notes this build ships, so these tests
 * pin the three properties that replacement has to keep: the running version is
 * identified, the notes are local, and bullet HTML reaches the page intact.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const repoRoot = path.resolve(partialsDir, "../../..");
const CHANGELOG_DATA = path.join(repoRoot, "packages/iracing-actions/src/actions/data/changelog.json");

const FIXTURE = {
  _meta: { generatedFrom: "…", generatedBy: "…", note: "…" },
  releases: [
    {
      version: "2.5.0",
      date: null,
      categories: [{ title: "Features", items: ["A <strong>bold</strong> feature with <code>code</code>."] }],
    },
    {
      version: "2.4.0",
      date: "2026-08-12",
      categories: [{ title: "Bug Fixes", items: ["An older fix."] }],
    },
  ],
};

/** Stands in for the compile plugin's `require`, which only resolves `data/*.json`. */
function render(version: string, changelog: unknown = FIXTURE): string {
  return ejs.render(
    "<%- include('settings-window-changelog') %>",
    { version, require: () => changelog },
    { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
  );
}

describe("settings-window-changelog.ejs", () => {
  it("renders every release the artifact carries, newest first", () => {
    const html = render("2.5.0");

    expect(html.indexOf("2.5.0")).toBeLessThan(html.indexOf("2.4.0"));
    expect(html.match(/<article class="sw-cl-release/g)).toHaveLength(2);
  });

  it("never reaches the website for the notes themselves", () => {
    const html = render("2.5.0");

    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("iracedeck.com/changelog");
  });

  describe("the installed release", () => {
    it("is badged", () => {
      const html = render("2.5.0");

      expect(html).toContain('<span class="sw-cl-badge">Installed</span>');
      expect(html.match(/sw-cl-badge/g)).toHaveLength(1);
    });

    it("is badged on the matching release, not merely the newest", () => {
      const html = render("2.4.0");
      const badged = /<article class="sw-cl-release installed">[\s\S]*?<\/article>/.exec(html)?.[0] ?? "";

      expect(badged).toContain("2.4.0");
      expect(badged).not.toContain("2.5.0");
    });

    it("matches a pre-release build against its plain version section", () => {
      // A dev build reports 2.5.0-dev.0 while the section is `## 2.5.0`.
      expect(render("2.5.0-dev.0")).toContain('<span class="sw-cl-badge">Installed</span>');
    });

    it("says so when this build has no section yet, rather than badging nothing silently", () => {
      const html = render("2.6.0-dev.0");

      expect(html).toContain("No release notes for version 2.6.0-dev.0 yet");
      expect(html).not.toContain("sw-cl-badge");
    });

    it("adds no such note when the running version is present", () => {
      expect(render("2.5.0")).not.toContain("No release notes for version");
    });
  });

  describe("bullet HTML", () => {
    it("reaches the page as markup, since the generator already escaped it", () => {
      const html = render("2.5.0");

      expect(html).toContain("<li>A <strong>bold</strong> feature with <code>code</code>.</li>");
    });
  });

  describe("dates", () => {
    it("shows the release date when there is one", () => {
      expect(render("2.5.0")).toContain('<span class="sw-cl-date">2026-08-12</span>');
    });

    it("says Unreleased rather than inventing a date for the in-development version", () => {
      expect(render("2.5.0")).toContain('<span class="sw-cl-date">Unreleased</span>');
    });
  });

  it("degrades to a plain line rather than an empty pane if the artifact carries nothing", () => {
    const html = render("2.5.0", { _meta: {}, releases: [] });

    expect(html).toContain("Release notes are not available in this build.");
  });

  it("renders rather than throwing when the compile plugin passed no version", () => {
    // Every real build passes one, but a template that dereferences an absent
    // local throws under EJS's `with` scope — and taking the whole page down
    // over a badge is a poor trade.
    const html = ejs.render(
      "<%- include('settings-window-changelog') %>",
      { require: () => FIXTURE },
      { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
    );

    expect(html).toContain("sw-cl-release");
    expect(html).not.toContain("sw-cl-badge");
  });

  it("renders the real committed artifact", () => {
    const real = JSON.parse(readFileSync(CHANGELOG_DATA, "utf-8"));
    const html = render(real.releases[0].version, real);

    expect(html.match(/<article class="sw-cl-release/g)).toHaveLength(real.releases.length);
    expect(html).toContain('<span class="sw-cl-badge">Installed</span>');
  });
});
