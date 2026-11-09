import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SETTINGS_WINDOW_TABS } from "./lib/settings-window-capture/tabs.mjs";

/**
 * `SettingsShot.astro`, the component the docs' Settings page renders its
 * Settings-window screenshots through (#1536).
 *
 * Only the stable release captures those screenshots, so a branch that adds a
 * tab to the window cannot commit its PNG. A Markdown image naming a missing
 * file fails the whole website build; the component renders nothing for it
 * instead. That tolerance is the point, and also the risk: a misspelt `file`
 * renders nothing too, for ever, with nothing red. So this holds both halves:
 * the component renders a missing tab as nothing and every captured one as an
 * image, and every `file` the docs name is a tab the capture writes.
 *
 * The component is rendered for real, through Astro's Container API on a Vite
 * server built from Astro's own config for the website package — the same
 * compiler and `astro:assets` the site build uses, without a site build. The
 * website's `astro.config.mjs` is deliberately not loaded (`configFile: false`):
 * none of its integrations touch a component's own markup, and Starlight's
 * would make every run pay for its setup.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const websiteDir = path.join(repoRoot, "packages", "website");
const componentPath = path.join(websiteDir, "src", "components", "SettingsShot.astro");
const shotsDir = path.join(websiteDir, "src", "assets", "settings-window");
const contentDir = path.join(websiteDir, "src", "content", "docs");
const settingsPage = path.join(contentDir, "docs", "getting-started", "settings.mdx");

/** Astro sets this promise on its Vite server; its own dev container awaits it before closing. */
const DEV_SERVER_APP_READY = Symbol.for("astro.devServerAppReady");

/** The PNGs the folder holds now: the tabs a release has captured. */
const capturedFiles = readdirSync(shotsDir).filter((name) => name.endsWith(".png"));

/** Every `<img …>` tag in `html`. */
const imgTags = (html) => html.match(/<img\b[^>]*>/g) ?? [];

describe("SettingsShot.astro", () => {
  let server;
  let SettingsShot;
  let container;

  beforeAll(async () => {
    // Astro and its Vite are the website's dependencies, not the root's, so
    // both are resolved from there.
    const websiteRequire = createRequire(path.join(websiteDir, "package.json"));
    const astroRequire = createRequire(websiteRequire.resolve("astro/package.json"));
    const { getViteConfig } = await import(url.pathToFileURL(websiteRequire.resolve("astro/config")).href);
    const { createServer } = await import(url.pathToFileURL(astroRequire.resolve("vite")).href);

    const viteConfig = await getViteConfig(
      {
        root: websiteDir,
        appType: "custom",
        logLevel: "error",
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      },
      { root: websiteDir, configFile: false, logLevel: "error" },
    )({ mode: "test", command: "serve" });

    server = await createServer({ ...viteConfig, configFile: false });
    ({ default: SettingsShot } = await server.ssrLoadModule(componentPath));
    const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
    container = await experimental_AstroContainer.create();
  }, 60_000);

  afterAll(async () => {
    if (!server) {
      return;
    }

    // Closing while Astro still compiles its dev app in the background makes it
    // log a "transport was disconnected" error after the test has passed.
    await server[DEV_SERVER_APP_READY];
    await server.close();
  });

  const render = (file, alt) => container.renderToString(SettingsShot, { props: { file, alt } });

  it("renders nothing, and does not throw, for a tab that has not been captured yet", async () => {
    const file = "a-tab-not-captured-yet.png";
    expect(capturedFiles).not.toContain(file);

    const html = await render(file, "A tab that has not been captured yet");

    expect(imgTags(html)).toEqual([]);
    expect(html.trim()).toBe("");
  });

  it("has screenshots to render, so the next test is not vacuous", () => {
    expect(capturedFiles.length).toBeGreaterThan(0);
  });

  it.each(capturedFiles)("renders %s as one optimized image with its alt text", async (file) => {
    const alt = `The ${file} screenshot`;
    const html = await render(file, alt);
    const tags = imgTags(html);

    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain(`alt="${alt}"`);
    // The image endpoint's URL names the source PNG (percent-encoded) and the
    // WebP the build turns it into, as it does for a Markdown image.
    expect(decodeURIComponent(tags[0])).toContain(`/settings-window/${file}`);
    expect(tags[0]).toContain("f=webp");
    expect(tags[0]).toMatch(/ width="\d+"/);
    expect(tags[0]).toMatch(/ height="\d+"/);
    expect(tags[0]).toContain('loading="lazy"');
    expect(tags[0]).toContain('decoding="async"');
  });

  it("does not match a file by a suffix of its name", async () => {
    const [file] = capturedFiles;

    expect(imgTags(await render(`x${file}`, "suffix"))).toEqual([]);
  });
});

/** Every website content file, with its path relative to the content folder and its text. */
function contentFiles(dir = contentDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return contentFiles(full);
    }

    return /\.mdx?$/.test(entry.name)
      ? [{ file: path.relative(contentDir, full).replaceAll("\\", "/"), text: readFileSync(full, "utf8") }]
      : [];
  });
}

/** The `file` prop of every `<SettingsShot … />` in `text`. */
const shotFiles = (text) => [...text.matchAll(/<SettingsShot\b[^>]*?\bfile="([^"]*)"/g)].map((match) => match[1]);

describe("the docs' Settings-window screenshots", () => {
  const tabFiles = SETTINGS_WINDOW_TABS.map((tab) => tab.file);

  it("are rendered only through SettingsShot, which survives a tab not captured yet", () => {
    // A Markdown image or a plain import of a screenshot fails the build while
    // the tab's PNG waits for the next release.
    const direct = contentFiles()
      .filter(({ text }) => /assets\/settings-window\//.test(text))
      .map(({ file }) => file);

    expect(direct).toEqual([]);
  });

  it("name only files the capture writes, since a misspelt one would render nothing", () => {
    const unknown = contentFiles().flatMap(({ file, text }) =>
      shotFiles(text)
        .filter((shot) => !tabFiles.includes(shot))
        .map((shot) => `${file}: ${shot}`),
    );

    expect(unknown).toEqual([]);
  });

  it("show every tab exactly once on the Settings page", () => {
    const shots = shotFiles(readFileSync(settingsPage, "utf8"));

    expect([...shots].sort()).toEqual([...tabFiles].sort());
  });
});
