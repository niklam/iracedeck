import {
  PROFILE_AUTO_SWITCH_ENABLED_KEY,
  PROFILE_FOR_SESSION_KIND_KEYS,
  SETTINGS_WINDOW_OPEN_WARNING_ID,
  SETTINGS_WINDOW_SERVER_WARNING_ID,
} from "@iracedeck/app-constants";
import { partialsDir, SETTINGS_WINDOW_ICON } from "@iracedeck/pi-components/build";
import {
  findThirdPartyReferences,
  SETTINGS_WINDOW_REMOTE_IMAGES,
  type ThirdPartyReference,
} from "@iracedeck/pi-components/testing";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseNavPanes } from "../../../../scripts/lib/settings-window-capture/tabs.mjs";
import { SETTINGS_WINDOW_PAGE } from "./action-templates.test-support.js";

/**
 * The settings window's page, `actions/settings-window/settings-window.ejs`,
 * held to the `@iracedeck/pi-components` partials it includes (#1375). Each
 * partial's own rendering is tested beside it in `pi-components`; what is
 * pinned here is how THIS page uses it: that it includes it, where, with which
 * flags, and what the page itself must never carry.
 */
const source = readFileSync(SETTINGS_WINDOW_PAGE, "utf-8");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the General tab's Press Sounds card (#269)", () => {
  const general = source.slice(
    source.indexOf('id="pane-general"'),
    source.indexOf("</section>", source.indexOf('id="pane-general"')),
  );

  it("includes the Press Sounds card exactly once on the whole page", () => {
    expect(source.split("include('global-common-press-sounds')").length - 1).toBe(1);
  });

  it("places it as a card directly after Dual-Press", () => {
    const dualPress =
      "<%- include('accordion', { title: 'Dual-Press', content: include('global-common-dual-press'), settingsWindow: true }) %>";
    const pressSounds =
      "<%- include('accordion', { title: 'Press Sounds', content: include('global-common-press-sounds'), settingsWindow: true }) %>";

    expect(general).toContain(dualPress);
    expect(general).toMatch(new RegExp(`${escapeRegExp(dualPress)}\\s*${escapeRegExp(pressSounds)}`));
  });
});

describe("the Profiles pane (#1111)", () => {
  const pane =
    /<% if \(locals\.platform\?\.features\?\.profiles !== false\) \{ %>\s*<section class="sw-pane" id="pane-profiles"[\s\S]*?<\/section>\s*<% \} %>/.exec(
      source,
    )?.[0];

  it("is gated on the profiles flag and holds the card after Stream Deck Profiles", () => {
    expect(pane).toBeDefined();

    const profiles = pane!.indexOf("include('global-stream-deck-profiles', __sw)");
    const auto = pane!.indexOf(
      "include('accordion', { title: 'Automatically switch to profile', content: include('global-profile-auto-switch'), settingsWindow: true })",
    );

    expect(profiles).toBeGreaterThan(-1);
    expect(auto).toBeGreaterThan(profiles);
  });

  it("binds the auto-switch keys nowhere else on the page", () => {
    for (const key of [PROFILE_AUTO_SWITCH_ENABLED_KEY, ...Object.values(PROFILE_FOR_SESSION_KIND_KEYS)]) {
      expect(source, key).not.toContain(key);
    }
  });
});

/**
 * `voice-packs.ejs` only renders when the flag is passed to THIS include (#1145):
 * the page nests it inside an `accordion` include's object literal, evaluated
 * in the page's own scope, so a caller that forgets `{ settingsWindow: true }`
 * gets an empty card.
 */
describe("the Voice Packs card (#1145)", () => {
  it("renders it as a Voice Packs card, passing settingsWindow into THIS include", () => {
    expect(source).toContain(
      "include('accordion', { title: 'Voice Packs', content: include('voice-packs', { settingsWindow: true }), settingsWindow: true })",
    );
  });

  it("stacks Voice Packs above Setup Warning Patterns in one column", () => {
    expect(source).toMatch(
      /<div class="sw-stack">\s*<%- include\('accordion', \{ title: 'Voice Packs'[^\n]*\n\s*<%- include\('accordion', \{ title: 'Setup Warning Patterns'[^\n]*\n\s*<\/div>/,
    );
  });
});

/**
 * The Callouts card's sliders are held to the settings schema in
 * `pi-components`' `race-engineer-callouts-sliders.test.ts` by rendering the
 * partial (#1376); that covers what the window ships only while the window
 * includes that partial.
 */
describe("the Race Engineer Callouts card (#1376)", () => {
  it("is the partial whose sliders are held to the settings schema", () => {
    expect(source).toContain("include('race-engineer-callouts')");
  });
});

/**
 * The Mouse to Sim card's defaults and bounds are held to `@iracedeck/app-constants`
 * in `pi-components`' `global-common-mouse-pointer-partial.test.ts` (#1029); that
 * covers what the window ships only while the window includes that partial.
 */
describe("the Mouse to Sim card (#1029)", () => {
  it("is the partial whose defaults and bounds are held to the constants", () => {
    expect(source).toContain("include('global-common-mouse-pointer')");
  });
});

/**
 * The settings window is served BY the settings server, so a banner saying that
 * server never started is disproved by the page the user is reading it on, and
 * the OPEN-failure note is advice about a button that page does not have
 * (issue #1014). Since the page has no `open-settings.ejs` include, neither has
 * a home there — both are withheld.
 *
 * It suppresses them by placing its OWN top strip: `head-common.ejs` injects
 * one only when the body has no `ird-warnings[data-auto]` yet, so the marker is
 * what makes the page's element the strip rather than a second one below it.
 * Both halves are pinned — a page that dropped `data-auto` would render two
 * strips, the injected one unfiltered.
 */
describe("the page withholds the settings-window banners (#1014)", () => {
  const strip = (): string => /<ird-warnings\s[^>]*>/.exec(source)?.[0] ?? "";

  it("places its own top strip instead of taking the injected one", () => {
    expect(strip()).toContain("data-auto");
  });

  it("excludes both settings-window ids from it", () => {
    expect(strip()).toContain(`except="`);
    expect(strip()).toContain(SETTINGS_WINDOW_SERVER_WARNING_ID);
    expect(strip()).toContain(SETTINGS_WINDOW_OPEN_WARNING_ID);
  });

  /**
   * Suppressing the injection means the page inherits none of its filtering:
   * whatever `head-common.ejs` excludes because it has a dedicated home
   * elsewhere on the page must be excluded here too, or that banner starts
   * rendering twice (or in a place it does not belong) on this one page. Today
   * the injected list is a subset of the page's; this keeps it that way when
   * the next id is added to head-common and nobody thinks of this page.
   */
  it("excludes at least everything the injected strip excludes", () => {
    const headCommon = readFileSync(path.join(partialsDir, "head-common.ejs"), "utf8");
    const injected = /setAttribute\('except',\s*'([^']*)'\)/.exec(headCommon)?.[1] ?? "";
    const injectedIds = injected
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");

    expect(injectedIds.length).toBeGreaterThan(0);

    const placed = strip();

    for (const id of injectedIds) expect(placed).toContain(id);
  });
});

/**
 * The favicon (#1156): `pi-components` ships the committed icon and the plugin
 * factory copies it beside the page; a `<link>` whose href resolves to nothing
 * renders exactly like no link at all, so the page's hop is pinned here.
 */
describe("the settings-window favicon (#1156)", () => {
  it("is linked by the window page, by the name pi-components ships it under", () => {
    const link = /<link[^>]*rel="icon"[^>]*>/.exec(source)?.[0] ?? "";

    expect(link).toContain(`href="${SETTINGS_WINDOW_ICON}"`);
  });
});

/**
 * The Settings window runs no code from another site (#1303). `pi-components`
 * scans every partial and the built pages; the page's own source is scanned
 * here, with the same scanner and the same allow-list.
 */
describe("the page's own source (#1303)", () => {
  it("names no other origin", () => {
    const found: ThirdPartyReference[] = findThirdPartyReferences(source, {
      allowedImages: SETTINGS_WINDOW_REMOTE_IMAGES,
    });

    expect(found.map(({ where, value, why }) => `${where} ${value} (${why})`)).toEqual([]);
  });
});

/**
 * The Support iRaceDeck tab (#1303) is copy and links and nothing else; what
 * it renders is pinned beside the partial in `pi-components`. Its place in the
 * window is decided by this page: a tab that drifts up the sidebar sits
 * between the user and a setting.
 */
describe("the Support iRaceDeck tab's place in the window (#1303)", () => {
  const navButtons = [...source.matchAll(/<button[^>]*class="sw-nav-item[^"]*"[^>]*>([\s\S]*?)<\/button>/g)];

  it("is the last tab in the sidebar", () => {
    const panes = parseNavPanes(source);

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
      ...source.matchAll(/<section class="sw-pane" id="pane-([a-z-]+)"( hidden)?>([\s\S]*?)<\/section>/g),
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
      source,
      ...readdirSync(partialsDir)
        .filter((name) => name.endsWith(".ejs"))
        .map((name) => readFileSync(path.join(partialsDir, name), "utf-8")),
    ];

    for (const page of sources) {
      expect(page).not.toMatch(/data-jump=["']support["']/);
    }
  });
});
