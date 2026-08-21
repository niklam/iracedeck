/// <reference lib="dom" />
/**
 * Upstream update notice for the Settings window's What's New tab (issue #1016).
 *
 * The tab renders the release notes THIS build ships (#1011), which is right
 * for "what did I just get?" and blind to "there is more". This asks the
 * plugin — `GET /updates/status`, answered by its update-check service — and,
 * when there is something newer, renders a banner plus one card per newer
 * release into the existing list, above the installed one.
 *
 * The only runtime on this pane (see `.claude/rules/settings-window.md`
 * rule 10), and it is deliberately quiet: `disabled`, `unavailable`, or no
 * newer releases renders nothing at all, so a machine with no internet, a
 * firewall, or the preference switched off sees the tab exactly as it was.
 *
 * Bullets arrive as HTML the PLUGIN sanitized (`sanitizeChangelogHtml` in
 * `@iracedeck/deck-core`), which is why `innerHTML` appears here for them and
 * for nothing else — every other value is `textContent`.
 *
 * Usage:
 * ```html
 * <ird-update-notice list="sw-changelog"></ird-update-notice>
 * ```
 */
import { abortAfter } from "./abort-after.js";
import { inSettingsWindow } from "./settings-window-context.js";

/** Where the plugin answers the update question. Same-origin, by design. */
const STATUS_PATH = "/updates/status";

/**
 * Deadline for that request. Comfortably longer than the plugin's own outbound
 * timeout, so a slow-but-working check still answers; short enough that a
 * handler which somehow never ends cannot leave this promise pending for the
 * lifetime of the window.
 */
const STATUS_TIMEOUT_MS = 8000;

/** Where a user goes to get the update. */
const DOWNLOADS_URL = "https://iracedeck.com/downloads/";

/**
 * Fired when a newer version was found, so the page can badge the sidebar
 * item. An event rather than the component reaching into the nav itself: the
 * nav is the page's, and the page already owns tab behaviour.
 */
export const UPDATE_AVAILABLE_EVENT = "ird-update-available";

interface PublishedCategory {
  title: string;
  items: string[];
}

interface PublishedRelease {
  version: string;
  date: string | null;
  categories: PublishedCategory[];
}

interface OkStatus {
  state: "ok";
  installedVersion: string;
  latestVersion: string;
  releases: PublishedRelease[];
}

/**
 * One release, shaped the way `renderRelease` walks it. Checked rather than
 * assumed: rendering happens outside this component's try/catch, so a payload
 * that is `ok` but malformed would otherwise throw mid-render and leave a
 * banner above no cards at all.
 */
function isRelease(value: unknown): value is PublishedRelease {
  const release = value as Partial<PublishedRelease> | null;

  if (!release || typeof release.version !== "string") return false;

  if (release.date !== null && typeof release.date !== "string") return false;

  return (
    Array.isArray(release.categories) &&
    release.categories.every((category) => {
      const c = category as Partial<PublishedCategory> | null;

      return (
        !!c && typeof c.title === "string" && Array.isArray(c.items) && c.items.every((i) => typeof i === "string")
      );
    })
  );
}

/** Narrow the response to the one state that renders anything. */
function asOkStatus(body: unknown): OkStatus | undefined {
  const status = body as Partial<OkStatus> | null;

  if (!status || status.state !== "ok") return undefined;

  if (typeof status.latestVersion !== "string" || typeof status.installedVersion !== "string") return undefined;

  if (!Array.isArray(status.releases) || status.releases.length === 0) return undefined;

  if (!status.releases.every(isRelease)) return undefined;

  return status as OkStatus;
}

export class UpdateNotice extends HTMLElement {
  private initialized = false;

  connectedCallback(): void {
    if (this.initialized) return;

    this.initialized = true;

    // Wait for the document, for two reasons that both bite mid-parse.
    // `pi-components.js` is a plain <head> script, so this element upgrades
    // while the page is still being parsed: the settings-window bridge has not
    // set its flag yet (it installs on DOMContentLoaded), and the changelog
    // list this decorates comes AFTER us in the body, so it does not exist.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.start(), { once: true });

      return;
    }

    this.start();
  }

  private start(): void {
    // Removed again before the document finished parsing: nothing to decorate,
    // so make no request either.
    if (!this.isConnected) return;

    // Inert outside the settings window: the endpoint only exists there, and a
    // Property Inspector has no What's New pane to decorate.
    if (!inSettingsWindow()) return;

    void this.load();
  }

  private async load(): Promise<void> {
    let status: OkStatus | undefined;

    try {
      const response = await fetch(STATUS_PATH, { signal: abortAfter(STATUS_TIMEOUT_MS), cache: "no-store" });

      status = response.ok ? asOkStatus(await response.json()) : undefined;
    } catch {
      // Silence is the whole failure story: the built-in notes are already on
      // the page and must never depend on this having worked.
      return;
    }

    if (!status) return;

    this.renderBanner(status);
    this.insertReleases(status.releases);
    this.dispatchEvent(
      new CustomEvent(UPDATE_AVAILABLE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { latestVersion: status.latestVersion, count: status.releases.length },
      }),
    );
  }

  private renderBanner(status: OkStatus): void {
    const banner = document.createElement("div");
    banner.className = "sw-cl-banner";

    const text = document.createElement("span");
    text.className = "sw-cl-banner-text";
    text.textContent = `Version ${status.latestVersion} is available. You're on ${status.installedVersion}.`;
    banner.appendChild(text);

    const link = document.createElement("a");
    link.href = DOWNLOADS_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Get the update";
    banner.appendChild(link);

    this.appendChild(banner);
  }

  /**
   * Put the newer releases at the TOP of the built-in list, so the pane stays
   * one continuous newest-first timeline rather than two lists.
   *
   * A version already on the list is skipped. That is not a theoretical case: on
   * a PRE-RELEASE build the pane strips the `-rc.1` / `-dev.0` suffix to decide
   * what is installed, so its card already carries the STABLE number — which the
   * published artifact then legitimately offers as an update. Without this the
   * pane would show one version twice, once "Installed" and once "Not
   * installed". The banner still names it, which is the part that is true.
   */
  private insertReleases(releases: PublishedRelease[]): void {
    const list = document.getElementById(this.getAttribute("list") ?? "");

    if (!list) return;

    const present = new Set(
      Array.from(list.querySelectorAll(".sw-cl-version")).map((node) => node.textContent?.trim() ?? ""),
    );
    const first = list.firstChild;

    for (const release of releases) {
      if (present.has(release.version)) continue;

      list.insertBefore(this.renderRelease(release), first);
    }
  }

  private renderRelease(release: PublishedRelease): HTMLElement {
    const article = document.createElement("article");
    article.className = "sw-cl-release not-installed";

    const head = document.createElement("div");
    head.className = "sw-cl-head";

    const version = document.createElement("h3");
    version.className = "sw-cl-version";
    version.textContent = release.version;
    head.appendChild(version);

    if (release.date) {
      const date = document.createElement("span");
      date.className = "sw-cl-date";
      date.textContent = release.date;
      head.appendChild(date);
    }

    const badge = document.createElement("span");
    badge.className = "sw-cl-badge sw-cl-badge-muted";
    badge.textContent = "Not installed";
    head.appendChild(badge);

    article.appendChild(head);

    for (const category of release.categories) {
      const title = document.createElement("h4");
      title.className = "sw-cl-category";
      title.textContent = category.title;
      article.appendChild(title);

      const items = document.createElement("ul");
      items.className = "sw-cl-items";

      for (const item of category.items) {
        const li = document.createElement("li");
        // Sanitized by the plugin before it ever reached this page — the one
        // place in this component where markup is allowed through.
        li.innerHTML = item;
        items.appendChild(li);
      }

      article.appendChild(items);
    }

    return article;
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-update-notice")) {
    customElements.define("ird-update-notice", UpdateNotice);
  }
}
