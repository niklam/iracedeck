import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import ejs from "ejs";
import { describe, expect, it } from "vitest";

/**
 * Renders the REAL `partials/voice-packs.ejs` (#1145), which took over the block
 * `race-engineer-settings.ejs` rendered for the settings window since #1034.
 *
 * Two properties carried over and are easy to break silently:
 *
 * 1. The block is settings-window ONLY. Its buttons are `sendToPlugin` commands
 *    routed by the settings-window command handler; from a Property Inspector
 *    the same frame goes to that PI's action instead, where nothing handles it.
 * 2. It only renders when the flag is passed to THIS include. The window nests
 *    it inside an `accordion` include's object literal, evaluated in the page's
 *    own scope, so a caller that forgets `{ settingsWindow: true }` gets an
 *    empty card.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const templatePath = path.join(partialsDir, "voice-packs.ejs");
const windowTemplate = path.resolve(
  partialsDir,
  "../../iracing-actions/src/actions/settings-window/settings-window.ejs",
);

function render(locals: Record<string, unknown>): string {
  return ejs.render(readFileSync(templatePath, "utf-8"), locals, { filename: templatePath });
}

describe("voice-packs partial (#1145)", () => {
  it("renders the installed list, rescan, folder shortcut and catalog in the settings window", () => {
    const html = render({ settingsWindow: true });

    expect(html).toContain("<ird-voice-pack-list");
    expect(html).toContain("<ird-voice-pack-refresh");
    expect(html).toContain("<ird-open-voice-packs-folder");
    expect(html).toContain("<ird-voice-pack-catalog");
  });

  it("binds the list to _voicePacks and the catalog to _voicePackStatus", () => {
    const html = render({ settingsWindow: true });

    expect(html).toContain('packs="_voicePacks"');
    expect(html).toContain('status="_voicePackStatus"');
  });

  it("tells the user where packs live, so a sideload needs no documentation lookup", () => {
    const html = render({ settingsWindow: true });

    expect(html).toContain("LOCALAPPDATA");
    expect(html).toContain("Race Engineer");
    expect(html).toContain("Voices");
  });

  it("heads the two halves with section headers, installed first", () => {
    const html = render({ settingsWindow: true });
    const installed = html.indexOf("Installed Voices");
    const available = html.indexOf("Available to Download");

    expect(html).toContain("ird-section-header");
    expect(installed).toBeGreaterThan(-1);
    expect(available).toBeGreaterThan(installed);
    expect(html.indexOf("<ird-voice-pack-list")).toBeLessThan(available);
    expect(html.indexOf("<ird-voice-pack-catalog")).toBeGreaterThan(available);
  });

  it("gives the lists the card's full width — no sdpi-item label column squeezing pack names", () => {
    const html = render({ settingsWindow: true });

    expect(html).not.toMatch(/<sdpi-item[^>]*label="Installed Voices"/);
    expect(html).not.toMatch(/<sdpi-item[^>]*label="Available to Download"/);
  });

  it("renders NOTHING voice-pack related outside the settings window", () => {
    const html = render({});

    expect(html).not.toContain("ird-voice-pack");
    expect(html).not.toContain("ird-open-voice-packs-folder");
    expect(html).not.toContain("Installed Voices");
  });

  it("the settings window renders it as a Voice Packs card, passing settingsWindow into THIS include", () => {
    const source = readFileSync(windowTemplate, "utf-8");

    expect(source).toContain(
      "include('accordion', { title: 'Voice Packs', content: include('voice-packs', { settingsWindow: true }), settingsWindow: true })",
    );
  });

  it("stacks Voice Packs above Setup Warning Patterns in one column", () => {
    const source = readFileSync(windowTemplate, "utf-8");

    expect(source).toMatch(
      /<div class="sw-stack">\s*<%- include\('accordion', \{ title: 'Voice Packs'[^\n]*\n\s*<%- include\('accordion', \{ title: 'Setup Warning Patterns'[^\n]*\n\s*<\/div>/,
    );
  });
});
