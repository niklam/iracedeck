import ejs from "ejs";
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Press Sounds card (#269). Its select writes `pressSound`, a persisted
 * global setting, so the key and the four stored values are a contract with
 * `GlobalSettingsSchema`: a renamed option value would be written by the
 * window, caught by the schema's `.catch`, and silently read back as "none".
 * The two Test buttons name preview kinds that `runAudioPreview` must accept;
 * both sides are literals that cannot import each other, so they are pinned here.
 */
const partialsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../partials");
const settingsWindowEjs = path.resolve(
  partialsDir,
  "../../iracing-actions/src/actions/settings-window/settings-window.ejs",
);

function render(template: string): string {
  return ejs.render(template, {}, { views: [partialsDir], filename: path.join(partialsDir, "_test.ejs") });
}

const html = render("<%- include('global-common-press-sounds') %>");

describe("global-common-press-sounds.ejs", () => {
  it("binds one global select to pressSound, defaulting to none", () => {
    expect(html.split('setting="pressSound"').length - 1).toBe(1);
    expect(html).toContain('<sdpi-select setting="pressSound" default="none" global>');
  });

  it("offers exactly the four stored values, in order, with their labels", () => {
    const options = [...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

    expect(options).toEqual([
      ["none", "No sound"],
      ["taps", "Taps"],
      ["long-press", "Long-press"],
      ["both", "Both"],
    ]);
  });

  it("has one Test button per sound, naming the press-tap and press-long preview kinds", () => {
    const buttons = [...html.matchAll(/<ird-audio-test ([^>]*)><\/ird-audio-test>/g)].map((m) => m[1]);

    expect(buttons).toEqual(['preview="press-tap" label="Test tap"', 'preview="press-long" label="Test long press"']);
  });

  it("says what each bleep means, where the threshold is set and that sounds need iRacing connected", () => {
    const text = html.replace(/\s+/g, " ");

    expect(text).toContain("A single bleep confirms a tap, and a double bleep tells you");
    expect(text).toContain("long-press threshold set in Dual-Press");
    expect(text).toContain("Sounds play only while iRacing is connected.");
  });

  it("emits items only, never an accordion of its own", () => {
    expect(html).not.toContain("<details");
    expect(html).not.toContain("ird-sw-card");
  });
});

describe("settings window General tab (#269)", () => {
  const source = readFileSync(settingsWindowEjs, "utf-8");
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

describe("global-common-dual-press.ejs threshold text (#269)", () => {
  it("describes the threshold as the one for every key and dial-button long-press, the double bleep included", () => {
    const text = render("<%- include('global-common-dual-press') %>").replace(/\s+/g, " ");

    expect(text).toContain(
      "It applies to every long-press of a key or a dial button, including the Press Sounds double bleep; a Long Touch on the touch strip follows the Stream Deck's own timing.",
    );
    expect(text).not.toContain("before a setup View sub-mode treats it as a long-press");
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
