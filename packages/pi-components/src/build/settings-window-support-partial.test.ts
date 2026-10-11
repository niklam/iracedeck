// @vitest-environment jsdom
import ejs from "ejs";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { parseNavPanes } from "../../../../scripts/lib/settings-window-capture/tabs.mjs";
import { resolveExternalUrl } from "../components/external-links.js";

/**
 * Renders the REAL `partials/settings-window-support.ejs` (not a fixture).
 *
 * The Support iRaceDeck tab (#1303) is copy and links and nothing else, so
 * what can go wrong with it is quiet: a sentence reworded away from what was
 * agreed, a link that opens inside the window instead of the user's browser,
 * a button image that is fetched every time the window opens, or a tab that
 * drifts up the sidebar to sit between the user and a setting. Each is pinned
 * here.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const repoRoot = path.resolve(partialsDir, "../../..");
const partialSource = readFileSync(path.join(partialsDir, "settings-window-support.ejs"), "utf-8");
const pageSource = readFileSync(
  path.join(repoRoot, "packages/iracing-actions/src/actions/settings-window/settings-window.ejs"),
  "utf-8",
);

/** The partial takes no data: its three URLs are its own. */
function render(): string {
  return ejs.render(
    "<%- include('settings-window-support') %>",
    {},
    { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") },
  );
}

/** Parsed, not attached: nothing here should fetch the image or follow a link. */
function renderDocument(): Document {
  return new DOMParser().parseFromString(render(), "text/html");
}

/**
 * A URL constant as the partial declares it, read the way
 * `scripts/support-link-parity.test.mjs` will read it: one `var NAME = "…";`
 * on a line of its own. Empty when that shape is gone, which fails every
 * assertion built on it.
 */
function declared(name: string): string[] {
  return [...partialSource.matchAll(new RegExp(`^[ \\t]*var ${name} = "([^"\\n]*)";[ \\t]*$`, "gm"))].map(
    (match) => match[1],
  );
}

const SUPPORT_URL = declared("SUPPORT_URL")[0] ?? "";
const MEMBERSHIP_URL = declared("MEMBERSHIP_URL")[0] ?? "";
const SUPPORT_BUTTON_IMAGE_URL = declared("SUPPORT_BUTTON_IMAGE_URL")[0] ?? "";

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();

/** Every link in the rendered pane, in document order. */
const anchors = (): HTMLAnchorElement[] => Array.from(renderDocument().querySelectorAll("a"));

describe("settings-window-support.ejs (#1303)", () => {
  describe("the copy", () => {
    // The spec's "The copy" decision, in order. The button has no text of its
    // own: its words are in the image, and its alt text stands in for it here.
    const COPY = [
      "Support iRaceDeck",
      "iRaceDeck is free — servers and Red Bull aren't. Any support is genuinely appreciated.",
      "There is no paid version and nothing is locked: every action, every Race Engineer callout and every voice is yours whether or not you ever give anything.",
      "iRaceDeck is built and maintained in spare time. Beyond that time, the main costs are AI subscriptions and the servers behind the website. If iRaceDeck has earned a place on your rig and you would like to chip in, this is where. Nothing is ever expected.",
      "[Support iRaceDeck on Buy Me a Coffee]",
      "Or become an iRaceDeck Supporter for a monthly amount and get the Supporter role on Discord.",
      "Other ways to help",
      "None of these cost anything, and they help just as much.",
      "Join the Discord",
      "Report a bug or suggest a feature",
      "Star iRaceDeck on GitHub",
    ];

    it("is on the page line for line, in order", () => {
      const blocks = Array.from(renderDocument().body.querySelectorAll("h2, h3, p, li")).map((block) => {
        const image = block.querySelector("img");

        return image && text(block) === "" ? `[${image.getAttribute("alt")}]` : text(block);
      });

      expect(blocks).toEqual(COPY);
    });

    it("is all there is: no words outside those lines", () => {
      expect(text(renderDocument().body)).toBe(COPY.filter((line) => !line.startsWith("[")).join(" "));
    });

    it("heads the pane the way every other pane is headed", () => {
      const body = renderDocument().body;

      expect(body.firstElementChild?.tagName).toBe("H2");
      expect(body.children[1]?.matches("p.sw-sub")).toBe(true);
    });

    it("keeps the subtitle's em dash and straight apostrophe, as the website writes it", () => {
      const subtitle = text(renderDocument().body.querySelector(".sw-sub") as Element);

      // By code point, so a look-alike (an en dash, a typographic apostrophe)
      // cannot stand in for either.
      expect(subtitle).toContain(`free ${String.fromCodePoint(0x2014)} servers`);
      expect(subtitle).toContain(`aren${String.fromCodePoint(0x27)}t`);
    });
  });

  describe("the three URLs", () => {
    it("are each declared once, on one line, under the website's names", () => {
      for (const name of ["SUPPORT_URL", "MEMBERSHIP_URL", "SUPPORT_BUTTON_IMAGE_URL"]) {
        expect(declared(name), name).toHaveLength(1);
        expect(partialSource.match(new RegExp(`\\bvar ${name}\\b`, "g")), name).toHaveLength(1);
        expect(declared(name)[0], name).toMatch(/^https:\/\//);
      }
    });

    it("puts the membership page under the support page", () => {
      expect(MEMBERSHIP_URL).toBe(`${SUPPORT_URL}/membership`);
    });

    it("draws the button for the same account the link goes to, with the agreed words", () => {
      const image = new URL(SUPPORT_BUTTON_IMAGE_URL);

      expect(image.searchParams.get("slug")).toBe(new URL(SUPPORT_URL).pathname.slice(1));
      expect(image.searchParams.get("text")).toBe("Support iRaceDeck");
    });
  });

  describe("the links", () => {
    it("are the five the spec lists, in order", () => {
      const links = anchors();

      expect(links.map((anchor) => anchor.getAttribute("href"))).toEqual([
        SUPPORT_URL,
        MEMBERSHIP_URL,
        "https://discord.gg/c6nRYywpah",
        "https://github.com/niklam/iracedeck/issues",
        "https://github.com/niklam/iracedeck",
      ]);
    });

    it("are plain https anchors that open outside the window", () => {
      const links = anchors();

      expect(links).toHaveLength(5);

      for (const anchor of links) {
        const href = anchor.getAttribute("href") ?? "";

        expect(href, href).toMatch(/^https:\/\//);
        expect(anchor.getAttribute("target"), href).toBe("_blank");
        expect(anchor.getAttribute("rel"), href).toBe("noopener noreferrer");
      }
    });

    it("each go through the shared external-link handler, so the click reaches openUrl", () => {
      // `resolveExternalUrl` returning the URL is the handler's whole condition
      // for sending the click to the plugin, which opens the user's own browser.
      for (const anchor of anchors()) {
        expect(resolveExternalUrl(anchor)).toBe(anchor.getAttribute("href"));
      }
    });

    it("link only the words iRaceDeck Supporter to the membership page", () => {
      const membership = anchors().filter((anchor) => anchor.getAttribute("href") === MEMBERSHIP_URL);

      expect(membership).toHaveLength(1);
      expect(membership[0].textContent).toBe("iRaceDeck Supporter");
    });
  });

  describe("the button", () => {
    const button = (): HTMLAnchorElement => renderDocument().querySelector("a.sw-support-button") as HTMLAnchorElement;

    it("is one link to the support page, wrapping one image and nothing else", () => {
      const doc = renderDocument();

      expect(doc.querySelectorAll("a.sw-support-button")).toHaveLength(1);
      expect(doc.querySelectorAll("img")).toHaveLength(1);
      expect(button().getAttribute("href")).toBe(SUPPORT_URL);
      expect(button().children).toHaveLength(1);
      expect(button().firstElementChild?.tagName).toBe("IMG");
      expect(text(button())).toBe("");
    });

    it("sends a click on the image to the support page", () => {
      expect(resolveExternalUrl(button().querySelector("img"))).toBe(SUPPORT_URL);
    });

    it("draws Buy Me a Coffee's image from the declared address", () => {
      // getAttribute returns the DECODED value, so this also proves the `&`s
      // were escaped on the way out and survive the round trip.
      expect(button().querySelector("img")?.getAttribute("src")).toBe(SUPPORT_BUTTON_IMAGE_URL);
      expect(render()).toContain(`src="${SUPPORT_BUTTON_IMAGE_URL.replaceAll("&", "&amp;")}"`);
    });

    it("is fetched only when the tab is opened, and tells the host nothing about the page", () => {
      const image = button().querySelector("img") as HTMLImageElement;

      // Lazy: the pane is `hidden` until its tab is chosen, and a lazy image
      // with no box is not requested.
      expect(image.getAttribute("loading")).toBe("lazy");
      expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    });

    it("reserves the image's box and reads as the link it is when the image cannot load", () => {
      const image = button().querySelector("img") as HTMLImageElement;

      expect(image.getAttribute("width")).toBe("253");
      expect(image.getAttribute("height")).toBe("50");
      expect(image.getAttribute("alt")).toBe("Support iRaceDeck on Buy Me a Coffee");
    });
  });

  describe("what the pane must never grow", () => {
    it("has no script, and not Buy Me a Coffee's widget", () => {
      const html = render();

      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toContain("cdnjs.buymeacoffee.com");
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    });

    it("has no element that stores a setting, and no control at all", () => {
      const html = render();

      expect(html).not.toMatch(/<(?:sdpi|ird)-/i);
      expect(html).not.toMatch(/\ssetting\s*=/i);
      expect(renderDocument().querySelectorAll("button, input, select, textarea, form")).toHaveLength(0);
    });

    it("has no inline style", () => {
      expect(render()).not.toMatch(/\sstyle\s*=/i);
    });
  });

  describe("its place in the window", () => {
    const navButtons = [...pageSource.matchAll(/<button[^>]*class="sw-nav-item[^"]*"[^>]*>([\s\S]*?)<\/button>/g)];

    it("is the last tab in the sidebar", () => {
      const panes = parseNavPanes(pageSource);

      expect(panes.filter((pane) => pane === "support")).toHaveLength(1);
      expect(panes.at(-1)).toBe("support");
    });

    it("is labelled Support iRaceDeck, with no badge", () => {
      const last = navButtons.at(-1);

      expect(last?.[0]).toContain('data-pane="support"');
      expect(last?.[1]).toBe("Support iRaceDeck");
    });

    it("is the last pane, hidden until chosen, and holds only the partial", () => {
      const sections = [
        ...pageSource.matchAll(/<section class="sw-pane" id="pane-([a-z-]+)"( hidden)?>([\s\S]*?)<\/section>/g),
      ];
      const last = sections.at(-1);

      expect(sections.filter((section) => section[1] === "support")).toHaveLength(1);
      expect(last?.[1]).toBe("support");
      // `hidden` is what keeps the lazy image unfetched until the tab is opened.
      expect(last?.[2]).toBe(" hidden");
      expect(last?.[3].trim()).toBe("<%- include('settings-window-support') %>");
    });

    it("is not jumped to from anywhere else in the window", () => {
      const sources = [
        pageSource,
        ...readdirSync(partialsDir)
          .filter((name) => name.endsWith(".ejs"))
          .map((name) => readFileSync(path.join(partialsDir, name), "utf-8")),
      ];

      for (const source of sources) {
        expect(source).not.toMatch(/data-jump=["']support["']/);
      }
    });
  });
});
