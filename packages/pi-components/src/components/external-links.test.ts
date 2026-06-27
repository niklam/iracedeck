// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { installExternalLinkHandler, resolveExternalUrl } from "./external-links.js";

/** Build an anchor in `doc`. Omit `href` for an anchor with no href attribute. */
function anchor(doc: Document, href?: string): HTMLAnchorElement {
  const a = doc.createElement("a");

  if (href !== undefined) a.setAttribute("href", href);

  doc.body.appendChild(a);

  return a;
}

/**
 * A fresh, browsing-context-less document per handler test. Each
 * `installExternalLinkHandler` call adds a document-level listener, so isolating
 * the document keeps listeners (and jsdom navigation) from bleeding across tests.
 */
function freshDoc(): Document {
  return document.implementation.createHTMLDocument("test");
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);

  return ev;
}

describe("resolveExternalUrl", () => {
  it("returns the resolved href for an http(s) link", () => {
    expect(resolveExternalUrl(anchor(document, "https://iracedeck.com/downloads/"))).toBe(
      "https://iracedeck.com/downloads/",
    );
    expect(resolveExternalUrl(anchor(document, "http://example.com/"))).toBe("http://example.com/");
  });

  it("resolves the closest anchor when a descendant is clicked", () => {
    const a = anchor(document, "https://iracedeck.com/docs/");
    const inner = document.createElement("span");
    a.appendChild(inner);

    expect(resolveExternalUrl(inner)).toBe("https://iracedeck.com/docs/");
  });

  it("ignores schemes the SDK cannot open", () => {
    expect(resolveExternalUrl(anchor(document, "mailto:hi@example.com"))).toBeNull();
    expect(resolveExternalUrl(anchor(document, "app://open"))).toBeNull();
  });

  it("ignores an anchor with no href", () => {
    expect(resolveExternalUrl(anchor(document))).toBeNull();
  });

  it("returns null when there is no anchor ancestor", () => {
    expect(resolveExternalUrl(document.createElement("div"))).toBeNull();
  });

  it("returns null for a non-element / null target", () => {
    expect(resolveExternalUrl(null)).toBeNull();
    expect(resolveExternalUrl(document.createTextNode("text"))).toBeNull();
  });
});

describe("installExternalLinkHandler", () => {
  it("reroutes an http(s) link through the openUrl event and prevents default", () => {
    const doc = freshDoc();
    const send = vi.fn();
    installExternalLinkHandler(doc, () => ({ send }));

    const ev = click(anchor(doc, "https://iracedeck.com/downloads/"));

    expect(send).toHaveBeenCalledWith("openUrl", { url: "https://iracedeck.com/downloads/" });
    expect(ev.defaultPrevented).toBe(true);
  });

  it("falls back to default link behavior when the sdpi-components client is absent", () => {
    const doc = freshDoc();
    installExternalLinkHandler(doc, () => undefined);

    // No client → we must not swallow the click, so the native <a> can open it.
    expect(click(anchor(doc, "https://iracedeck.com/downloads/")).defaultPrevented).toBe(false);
  });

  it("ignores non-http(s) links and never calls the client for them", () => {
    const doc = freshDoc();
    const send = vi.fn();
    installExternalLinkHandler(doc, () => ({ send }));

    const ev = click(anchor(doc, "mailto:hi@example.com"));

    expect(send).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("installs only one listener per document (idempotent)", () => {
    const doc = freshDoc();
    const send = vi.fn();
    installExternalLinkHandler(doc, () => ({ send }));
    installExternalLinkHandler(doc, () => ({ send }));

    click(anchor(doc, "https://iracedeck.com/downloads/"));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected send without throwing, still preventing default", () => {
    const doc = freshDoc();
    const send = vi.fn().mockRejectedValue(new Error("socket not ready"));
    installExternalLinkHandler(doc, () => ({ send }));

    const ev = click(anchor(doc, "https://iracedeck.com/downloads/"));

    expect(send).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
});
