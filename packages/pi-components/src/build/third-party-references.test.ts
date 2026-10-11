import { describe, expect, it } from "vitest";

import { findThirdPartyReferences } from "./third-party-references.js";

/**
 * The scanner against markup written for it. These are the positive control
 * for `settings-window-no-third-party.test.ts`, which runs it over the real
 * window: a scan that reports nothing there means something only because each
 * shape below is reported here.
 */
describe("findThirdPartyReferences", () => {
  const ALLOWED = "https://img.example/button.svg?a=1&b=2";

  /** One line per finding, so a failure names the element and the value. */
  const scan = (html: string) =>
    findThirdPartyReferences(html, { allowedImages: [ALLOWED] }).map(
      ({ where, value, why }) => `${where} ${value} (${why})`,
    );

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

  it("reads the attributes that follow a scriptlet inside a tag, whatever the scriptlet compares", () => {
    // A `>` or a `<` in the scriptlet's code would otherwise end the tag, or
    // open another, before the attribute is reached.
    expect(scan('<script <% if (n > 0) { %> src="https://cdn.example/w.js" <% } %>></script>')).toEqual([
      "<script src> https://cdn.example/w.js (remote)",
    ]);
    expect(scan('<img <% if (a < b) { %> src="https://img.example/t.png" <% } %> alt="">')).toEqual([
      "<img src> https://img.example/t.png (remote)",
    ]);
    expect(scan('<link rel="stylesheet" <% if (v >= 2) { %>href="https://fonts.example/a.css"<% } %>>')).toEqual([
      "<link href> https://fonts.example/a.css (remote)",
    ]);
    expect(scan('<script <%_ if (n > 0) { _%> src="https://cdn.example/w.js" <%_ } -%>></script>')).toHaveLength(1);
  });

  it("reports a reference once, though it reads the source both with and without its scriptlets", () => {
    expect(scan('<% if (on) { %><script src="https://cdn.example/w.js"></script><% } %>')).toEqual([
      "<script src> https://cdn.example/w.js (remote)",
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

  describe("an inline script's string literals", () => {
    const WIDGET = "https://cdn.example/w.js";
    const flagged = [`script text ${WIDGET} (remote)`];

    it("flags a script element built and pointed at another origin", () => {
      const html = `<script>var s=document.createElement("script");s.src="${WIDGET}";document.head.appendChild(s);</script>`;

      expect(scan(html)).toEqual(flagged);
    });

    it("flags a static and a dynamic import", () => {
      expect(scan(`<script type="module">import "${WIDGET}"</script>`)).toEqual(flagged);
      expect(scan(`<script type="module">import('${WIDGET}').then(run);</script>`)).toEqual(flagged);
    });

    it("flags an image beacon and a fetch", () => {
      expect(scan(`<script>new Image().src="${WIDGET}";</script>`)).toEqual(flagged);
      expect(scan(`<script>fetch("${WIDGET}");</script>`)).toEqual(flagged);
      expect(scan('<script>var u = new URL("https://example.com/"); fetch("https://example.com/");</script>')).toEqual([
        "script text https://example.com/ (remote)",
      ]);
    });

    it("is not fooled by how the literal is written", () => {
      for (const literal of [
        "`https://cdn.example/${file}`",
        '"//cdn.example/w.js"',
        '"https:\\/\\/cdn.example\\/w.js"',
        '" HTTPS://cdn.example/w.js"',
        '"wss://cdn.example/"',
        // A loopback address that is only the user name of another host.
        '"http://127.0.0.1@cdn.example/"',
        '"http://localhost.cdn.example/"',
      ]) {
        expect(scan(`<script>load(${literal});</script>`), literal).toHaveLength(1);
      }
    });

    it("reads past a comment, an apostrophe in one and an escaped slash", () => {
      const html = `<script>
        // It's the widget:
        /* don't "quote" me */
        var clean = path.replace(/\\/\\//g, "/"); fetch("${WIDGET}");
      </script>`;

      expect(scan(html)).toEqual(flagged);
    });

    it("leaves the window's own server, a URL in a comment and a string that is no URL alone", () => {
      const html = `<script>
        // See https://example.com/docs, or fetch("https://example.com/").
        /* import "https://example.com/w.js" */
        fetch("http://127.0.0.1:8888/x");
        new WebSocket("ws://localhost:8888/ws"); fetch("http://[::1]:8888/x"); fetch('//LOCALHOST/x');
        var image = "data:image/png;base64,AAAA", local = "sdpi-components.js", empty = "";
        var text = "Served from https://example.com/ as text";
      </script>`;

      expect(scan(html)).toEqual([]);
    });

    it("does not read an EJS scriptlet as script text: that ran when the page was built", () => {
      expect(scan('<script><% var docs = "https://example.com/docs"; %>var a = 1;</script>')).toEqual([]);
      expect(scan('<% var docs = "https://example.com/docs"; %><p>Text</p>')).toEqual([]);
    });
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
    expect(scan(`<script>new Image().src = "${ALLOWED}";</script>`)).toHaveLength(1);
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
      <script>var u = new URL("/status", location.href); fetch("http://127.0.0.1:8888/x"); // https://example.com/</script>
    `;

    expect(scan(html)).toEqual([]);
  });
});
