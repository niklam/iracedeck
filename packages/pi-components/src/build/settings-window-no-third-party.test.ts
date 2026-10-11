import { SETTINGS_WINDOW_HTML } from "@iracedeck/app-constants";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { discoverPlugins } from "../../../../scripts/lib/plugin-config-shape.mjs";
import { findThirdPartyReferences, type ThirdPartyReference } from "./third-party-references.js";

/**
 * The Settings window runs no code from another site (#1303).
 *
 * The page holds a write connection to the user's settings. Until the Support
 * iRaceDeck tab nothing in it came from a third party, by habit; that tab
 * hotlinks one image, so the line is written down here: no `<script>`,
 * stylesheet, font, frame or media element names another origin, an image may
 * only when it is on the allow-list below, and an anchor is the only other
 * element that may carry an absolute URL.
 *
 * Held in two places. The SOURCES (the page and every partial, since any
 * partial can be included by it) always run. The BUILT pages run when a build
 * is present, and are what actually ships: they also cover whatever a build
 * step injects.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const repoRoot = path.resolve(partialsDir, "../../..");
const windowPage = path.join(repoRoot, "packages/iracing-actions/src/actions/settings-window/settings-window.ejs");

/**
 * Every image the window may load from another site. Adding one is a decision
 * about what a third party learns each time a user opens that part of the
 * window, so it is made here, in review, and not by a template.
 */
const ALLOWED_REMOTE_IMAGES = [
  // Buy Me a Coffee's button on the Support iRaceDeck tab (#1303): an SVG drawn
  // by an <img>, which runs no script and follows no link.
  "https://img.buymeacoffee.com/button-api/?text=Support%20iRaceDeck&emoji=%F0%9F%8F%8E%EF%B8%8F&slug=niklaslampen&button_colour=FFDD00&font_colour=000000&font_family=Cookie&outline_colour=000000&coffee_colour=ffffff",
];

/** The one partial that names an allowed image, and the constant it names it by. */
const SUPPORT_PARTIAL = "settings-window-support.ejs";
const IMAGE_CONSTANT = "SUPPORT_BUTTON_IMAGE_URL";

const partials = readdirSync(partialsDir)
  .filter((name) => name.endsWith(".ejs"))
  .sort();

/** One line per finding, so a failure names the element and the value. */
function lines(found: ThirdPartyReference[]): string[] {
  return found.map(({ where, value, why }) => `${where} ${value} (${why})`);
}

describe("findThirdPartyReferences (the positive control)", () => {
  const ALLOWED = "https://img.example/button.svg?a=1&b=2";
  const scan = (html: string) => lines(findThirdPartyReferences(html, { allowedImages: [ALLOWED] }));

  it("flags a remote script", () => {
    expect(scan('<script src="https://cdn.example/widget.js"></script>')).toEqual([
      "<script src> https://cdn.example/widget.js (remote)",
    ]);
  });

  it("flags a remote stylesheet", () => {
    expect(scan('<link rel="stylesheet" href="https://fonts.example/css?family=Cookie" />')).toEqual([
      "<link href> https://fonts.example/css?family=Cookie (remote)",
    ]);
  });

  it("flags a remote image that is not on the allow-list", () => {
    expect(scan('<img src="https://img.example/other.svg" alt="" />')).toEqual([
      "<img src> https://img.example/other.svg (remote)",
    ]);
  });

  it("flags a protocol-relative script", () => {
    expect(scan('<script src="//cdn.example/widget.js"></script>')).toEqual([
      "<script src> //cdn.example/widget.js (remote)",
    ]);
  });

  it("flags a CSS url() and an @import that name another origin", () => {
    expect(scan("<style>.a { background: url(https://img.example/bg.png); }</style>")).toEqual([
      "css url() https://img.example/bg.png (remote)",
    ]);
    expect(scan('<style>@import "https://fonts.example/a.css";</style>')).toEqual([
      "css @import https://fonts.example/a.css (remote)",
    ]);
    expect(scan('<p style="background:url(&quot;//img.example/bg.png&quot;)"></p>')).toHaveLength(1);
  });

  it("flags every other element that loads something: frames, media, embeds, forms", () => {
    const html = `
      <iframe src="https://example.com/"></iframe>
      <video poster="https://example.com/p.png"><source src="https://example.com/v.mp4" /></video>
      <audio src="https://example.com/a.mp3"></audio>
      <object data="https://example.com/o.swf"></object>
      <embed src="https://example.com/e.swf" />
      <img srcset="local.png 1x, https://example.com/2x.png 2x" />
      <form action="https://example.com/post"></form>
      <svg><use xlink:href="https://example.com/sprite.svg#a" /></svg>
    `;

    expect(scan(html).map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "<iframe src>",
      "<video poster>",
      "<source src>",
      "<audio src>",
      "<object data>",
      "<embed src>",
      "<img srcset>",
      "<form action>",
      "<use xlink:href>",
    ]);
  });

  it("is not fooled by how the URL is written", () => {
    // Each of these reaches another origin in a browser.
    for (const value of [
      "HTTPS://cdn.example/a.js",
      " https://cdn.example/a.js",
      "\\\\cdn.example\\a.js",
      "https:&#x2F;&#x2F;cdn.example/a.js",
      "ht\ntps://cdn.example/a.js",
      "ws://cdn.example/",
    ]) {
      expect(scan(`<script src="${value}"></script>`), value).toHaveLength(1);
      expect(scan(`<script src='${value}'></script>`), value).toHaveLength(1);
    }

    expect(scan("<script src=https://cdn.example/a.js></script>")).toHaveLength(1);
  });

  it("flags markup a scriptlet or an inline script builds in a string", () => {
    expect(scan(`<% var html = '<img src="https://img.example/other.svg">'; %><%- html %>`)).toHaveLength(1);
    expect(scan(`<script>if (a<b) { el.innerHTML = "<iframe src=\\"https://example.com/\\">"; }</script>`)).toEqual([
      "<iframe src> https://example.com/\\ (remote)",
    ]);
  });

  it("flags a URL it cannot show to be a local file", () => {
    expect(scan('<script src="<%= widgetUrl %>"></script>')).toEqual([
      "<script src> {{ejs:<%= widgetUrl %>}} (unresolved)",
    ]);
    expect(scan(`<% var html = '<img src="' + imageUrl + '">'; %>`)).toEqual([
      "<img src> ' + imageUrl + ' (unresolved)",
    ]);
  });

  it("lets through the allow-listed image, however its ampersands are written", () => {
    expect(scan(`<img src="${ALLOWED}" alt="" />`)).toEqual([]);
    expect(scan(`<img src="${ALLOWED.replaceAll("&", "&amp;")}" alt="" />`)).toEqual([]);
  });

  it("allows that URL on an <img src> only, and only exactly", () => {
    expect(scan(`<script src="${ALLOWED}"></script>`)).toHaveLength(1);
    expect(scan(`<iframe src="${ALLOWED}"></iframe>`)).toHaveLength(1);
    expect(scan(`<img srcset="${ALLOWED} 2x" />`)).toHaveLength(1);
    expect(scan(`<img src="${ALLOWED}&c=3" />`)).toHaveLength(1);
    expect(scan(`<img src="${ALLOWED.replace("https:", "http:")}" />`)).toHaveLength(1);
  });

  it("allows an EJS expression only as that <img>'s whole, escaped src, and only when the caller names it", () => {
    const named = (html: string) =>
      findThirdPartyReferences(html, { allowedImages: [ALLOWED], allowedImageExpressions: ["BUTTON"] });

    expect(named('<img src="<%= BUTTON %>" />')).toEqual([]);
    expect(named('<img src="<%= OTHER %>" />')).toHaveLength(1);
    expect(named('<img src="<%- BUTTON %>" />')).toHaveLength(1);
    expect(named('<img src="<%= BUTTON %>/more" />')).toHaveLength(1);
    expect(named('<script src="<%= BUTTON %>"></script>')).toHaveLength(1);
    expect(scan('<img src="<%= BUTTON %>" />')).toHaveLength(1);
  });

  it("leaves anchors, local files and things that are not references alone", () => {
    const html = `
      <!-- <script src="https://cdn.example/commented-out.js"></script> -->
      <%# was an <iframe src="https://example.com/"> once %>
      <a href="https://example.com/" target="_blank" rel="noopener noreferrer">A link</a>
      <a href="<%= docsUrl %>">Docs</a>
      <script src="sdpi-components.js"></script>
      <link rel="icon" type="image/png" href="iracedeck-icon.png" />
      <img src="iracedeck-logo.png" alt="" />
      <img src="data:image/png;base64,AAAA" alt="" />
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#mark" /></svg>
      <p>Served from https://example.com/ and //example.com/ as text.</p>
      <sdpi-textfield setting="host" default="http://127.0.0.1:8888" placeholder="https://example.com"></sdpi-textfield>
      <style>/* url(https://example.com/in-a-comment.png) */ .a { background: url(local.png); fill: url(#grad); }</style>
      <script>var u = new URL("https://example.com/"); fetch("https://example.com/");</script>
    `;

    expect(scan(html)).toEqual([]);
  });
});

describe("the Settings window's sources", () => {
  const supportSource = readFileSync(path.join(partialsDir, SUPPORT_PARTIAL), "utf-8");

  it("finds the partials at all", () => {
    // Guards the scan below against an empty directory read passing it vacuously.
    expect(partials.length).toBeGreaterThanOrEqual(30);
    expect(partials).toContain(SUPPORT_PARTIAL);
    expect(partials).toContain("head-common.ejs");
  });

  it("names the support button's image by a constant that is on the allow-list", () => {
    // What licenses reading `<%= SUPPORT_BUTTON_IMAGE_URL %>` as an allowed
    // image in that partial's source: the expression is this one literal.
    const declared = [...supportSource.matchAll(new RegExp(`^\\s*var ${IMAGE_CONSTANT} = "([^"\\n]*)";\\s*$`, "gm"))];

    expect(declared).toHaveLength(1);
    expect(supportSource.split(IMAGE_CONSTANT)).toHaveLength(3);
    expect(ALLOWED_REMOTE_IMAGES).toContain(declared[0][1]);
  });

  it("sees that image, so the exemption is doing something", () => {
    expect(lines(findThirdPartyReferences(supportSource, { allowedImages: ALLOWED_REMOTE_IMAGES }))).toEqual([
      `<img src> {{ejs:<%= ${IMAGE_CONSTANT} %>}} (unresolved)`,
    ]);
  });

  it("names no other origin in the page", () => {
    const found = findThirdPartyReferences(readFileSync(windowPage, "utf-8"), { allowedImages: ALLOWED_REMOTE_IMAGES });

    expect(lines(found)).toEqual([]);
  });

  it.each(partials)("names no other origin in %s", (name) => {
    const found = findThirdPartyReferences(readFileSync(path.join(partialsDir, name), "utf-8"), {
      allowedImages: ALLOWED_REMOTE_IMAGES,
      // An EJS expression is exempt in the one file that declares it, where the
      // test above has read its value. Anywhere else it is an unknown.
      allowedImageExpressions: name === SUPPORT_PARTIAL ? [IMAGE_CONSTANT] : [],
    });

    expect(lines(found)).toEqual([]);
  });
});

describe("the built Settings window pages", () => {
  const plugins = discoverPlugins(repoRoot);

  it("finds every plugin", () => {
    expect(plugins.length, "fewer plugins than deck ecosystems: discovery broke").toBeGreaterThanOrEqual(3);
  });

  describe.each(plugins)("$pkg", ({ pkg, folder }) => {
    const builtPage = path.join(repoRoot, "packages", pkg, folder, "ui", SETTINGS_WINDOW_HTML);

    it("loads nothing from another site but the allow-listed image", () => {
      if (!existsSync(builtPage)) {
        // The plugin has not been built in this checkout; the source scan
        // above still ran.
        return;
      }

      const html = readFileSync(builtPage, "utf-8");

      expect(lines(findThirdPartyReferences(html, { allowedImages: ALLOWED_REMOTE_IMAGES }))).toEqual([]);
      // …and with nothing allowed the same scan reports exactly that image,
      // which is what shows it read the page that carries it.
      expect(lines(findThirdPartyReferences(html))).toEqual([
        `<img src> ${ALLOWED_REMOTE_IMAGES[0].replaceAll("&", "&amp;")} (remote)`,
      ]);
    });
  });
});
