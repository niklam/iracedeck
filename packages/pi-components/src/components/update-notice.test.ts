// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_WINDOW_FLAG } from "./settings-window-context.js";
// Import the module to trigger custom element registration.
import "./update-notice.js";

const OK = {
  state: "ok",
  installedVersion: "2.4.0",
  latestVersion: "2.6.0",
  checkedAt: 1,
  releases: [
    {
      version: "2.6.0",
      date: "2026-08-14",
      categories: [{ title: "Features", items: ["A <strong>bold</strong> thing."] }],
    },
    { version: "2.5.0", date: "2026-08-02", categories: [{ title: "Bug Fixes", items: ["A fix."] }] },
  ],
};

/** Wait for the component's fetch chain to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function respondWith(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
}

async function mount(): Promise<HTMLElement> {
  const list = document.createElement("div");
  list.id = "sw-changelog";
  const installed = document.createElement("article");
  installed.className = "sw-cl-release installed";
  list.appendChild(installed);
  document.body.appendChild(list);

  const el = document.createElement("ird-update-notice");
  el.setAttribute("list", "sw-changelog");
  document.body.appendChild(el);
  await settle();

  return el;
}

describe("ird-update-notice", () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = undefined;
    Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
  });

  it("renders a banner naming both versions", async () => {
    respondWith(OK);
    const el = await mount();

    expect(el.querySelector(".sw-cl-banner")?.textContent).toContain("2.6.0");
    expect(el.querySelector(".sw-cl-banner")?.textContent).toContain("2.4.0");
  });

  it("links to the downloads page", async () => {
    respondWith(OK);
    const el = await mount();

    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://iracedeck.com/downloads/");
  });

  it("prepends one card per newer release, newest first, above the installed one", async () => {
    respondWith(OK);
    await mount();

    const versions = Array.from(document.querySelectorAll("#sw-changelog .sw-cl-version")).map((n) => n.textContent);

    expect(versions).toEqual(["2.6.0", "2.5.0"]);
    expect(document.querySelector("#sw-changelog")?.lastElementChild?.className).toContain("installed");
  });

  it("marks the fetched releases as not installed", async () => {
    respondWith(OK);
    await mount();

    expect(document.querySelectorAll("#sw-changelog .sw-cl-release.not-installed")).toHaveLength(2);
  });

  it("renders bullet HTML, which the plugin already sanitized", async () => {
    respondWith(OK);
    await mount();

    expect(document.querySelector("#sw-changelog .sw-cl-items li")?.innerHTML).toBe("A <strong>bold</strong> thing.");
  });

  it("sets version and date as text, never as markup", async () => {
    respondWith({ ...OK, releases: [{ ...OK.releases[0], version: "<img src=x>" }] });
    await mount();

    expect(document.querySelector("#sw-changelog img")).toBeNull();
    expect(document.querySelector("#sw-changelog .sw-cl-version")?.textContent).toBe("<img src=x>");
  });

  it("announces the update so the sidebar can badge it", async () => {
    respondWith(OK);
    const seen: CustomEvent[] = [];
    document.addEventListener("ird-update-available", (ev) => seen.push(ev as CustomEvent));

    await mount();

    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toEqual({ latestVersion: "2.6.0", count: 2 });
  });

  it("renders nothing when the check is unavailable", async () => {
    respondWith({ state: "unavailable", installedVersion: "2.4.0" });
    const el = await mount();

    expect(el.textContent).toBe("");
    expect(document.querySelectorAll("#sw-changelog .sw-cl-release.not-installed")).toHaveLength(0);
  });

  it("renders nothing when the check is switched off", async () => {
    respondWith({ state: "disabled", installedVersion: "2.4.0" });
    const el = await mount();

    expect(el.textContent).toBe("");
  });

  it("renders nothing when the request fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const el = await mount();

    expect(el.textContent).toBe("");
  });

  it("waits for the document before deciding it is in the settings window", async () => {
    // pi-components.js is a plain <head> script, so this element upgrades while
    // the page is still parsing — before the settings-window bridge sets its
    // flag (it installs on DOMContentLoaded) and before the changelog list that
    // follows it in the body exists (#1016).
    Object.defineProperty(document, "readyState", { value: "loading", configurable: true });
    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = undefined;
    respondWith(OK);

    const el = await mount();

    expect(el.textContent).toBe("");

    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = true;
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await settle();

    expect(el.querySelector(".sw-cl-banner")).not.toBeNull();
    expect(document.querySelectorAll("#sw-changelog .sw-cl-release.not-installed")).toHaveLength(2);
  });

  it("does not fetch at all outside the settings window", async () => {
    (window as unknown as Record<string, unknown>)[SETTINGS_WINDOW_FLAG] = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await mount();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
