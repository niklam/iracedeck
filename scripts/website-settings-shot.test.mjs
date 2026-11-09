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

/**
 * The index just past the `{ … }` expression that opens at `start`, or -1
 * when it never closes. Strings and template literals inside it are skipped,
 * so a brace or quote in one does not end it early.
 *
 * @param {string} text
 * @param {number} start - The index of the opening `{`.
 * @returns {number}
 */
function skipExpression(text, start) {
  let depth = 0;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === "\\") i++;
      }
      if (i >= text.length) return -1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

/** A JSX string literal inside `{ … }`, double- or single-quoted, with no escape. */
const STRING_EXPRESSION = /^(?:"([^"\\]*)"|'([^'\\]*)')$/;

/**
 * Read the attributes of the JSX tag whose name ends at `start`, up to its
 * closing `>` or `/>`: each name with its value as a literal string, as an
 * expression's source, or as absent; and whether a `{…props}` spread is there.
 * Quoted values and `{ … }` expressions are skipped whole, so a `>` inside
 * one does not end the tag. Returns a string saying why when it cannot.
 *
 * @param {string} text
 * @param {number} start
 * @returns {{ attributes: { name: string, literal?: string, expression?: string }[], spread: boolean } | string}
 */
function readTagAttributes(text, start) {
  /** @type {{ name: string, literal?: string, expression?: string }[]} */
  const attributes = [];
  let spread = false;
  const attributeName = /[^\s=/>"'{}]+/y;
  let i = start;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  for (;;) {
    skipSpace();
    if (i >= text.length) return "the tag is never closed";

    const c = text[i];
    if (c === ">" || (c === "/" && text[i + 1] === ">")) return { attributes, spread };

    if (c === "{") {
      const end = skipExpression(text, i);
      if (end < 0) return "a `{` in the tag is never closed";
      spread = true;
      i = end;
      continue;
    }

    attributeName.lastIndex = i;
    const match = attributeName.exec(text);
    if (match === null) return `the tag holds an unexpected ${JSON.stringify(c)}`;

    /** @type {{ name: string, literal?: string, expression?: string }} */
    const attribute = { name: match[0] };
    attributes.push(attribute);
    i = attributeName.lastIndex;
    skipSpace();
    if (text[i] !== "=") continue;

    i++;
    skipSpace();
    const quote = text[i];

    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, i + 1);
      if (end < 0) return `the value of ${attribute.name} is never closed`;
      attribute.literal = text.slice(i + 1, end);
      i = end + 1;
    } else if (quote === "{") {
      const end = skipExpression(text, i);
      if (end < 0) return `the value of ${attribute.name} is never closed`;
      const source = text.slice(i + 1, end - 1).trim();
      const literal = STRING_EXPRESSION.exec(source);
      if (literal === null) attribute.expression = source;
      else attribute.literal = literal[1] ?? literal[2];
      i = end;
    } else {
      return `${attribute.name}= has no value`;
    }
  }
}

/**
 * The `file` of every `<SettingsShot …>` tag in `text`, in any of the forms
 * `file="…"`, `file='…'`, `file={"…"}` or `file={'…'}`, and a problem for
 * each tag whose `file` cannot be read as a literal: missing, named twice,
 * given no value, given an expression (`file={name}`) or possibly set by a
 * spread. Each problem names the tag's line, so the guard says where to look.
 *
 * @param {string} text - An MDX or Markdown file's text.
 * @returns {{ files: string[], problems: string[] }}
 */
function settingsShotFiles(text) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const problems = [];

  for (const match of text.matchAll(/<SettingsShot(?=[\s/>])/g)) {
    const line = text.slice(0, match.index).split("\n").length;
    const problem = (/** @type {string} */ message) => problems.push(`line ${line}: <SettingsShot> ${message}`);
    const tag = readTagAttributes(text, match.index + match[0].length);

    if (typeof tag === "string") {
      problem(`cannot be read: ${tag}`);
      continue;
    }

    const named = tag.attributes.filter((attribute) => attribute.name === "file");

    if (tag.spread) {
      problem('passes props through a `{…}` spread, so its file cannot be read; name it as file="<name>.png"');
    } else if (named.length === 0) {
      problem('has no file; name the screenshot as file="<name>.png"');
    } else if (named.length > 1) {
      problem("names file more than once");
    } else if (named[0].expression !== undefined) {
      problem(`has file={${named[0].expression}}, which is not a string literal; name it as file="<name>.png"`);
    } else if (named[0].literal === undefined) {
      problem('has a file with no value; name it as file="<name>.png"');
    } else {
      files.push(named[0].literal);
    }
  }

  return { files, problems };
}

describe("settingsShotFiles", () => {
  it("reads file in each literal form", () => {
    const text = [
      '<SettingsShot file="a.png" alt="A" />',
      "<SettingsShot file='b.png' alt='B' />",
      '<SettingsShot file={"c.png"} alt="C" />',
      "<SettingsShot file={'d.png'} alt=\"D\" />",
      '<SettingsShot file = { "e.png" } alt="E"/>',
    ].join("\n");

    expect(settingsShotFiles(text)).toEqual({ files: ["a.png", "b.png", "c.png", "d.png", "e.png"], problems: [] });
  });

  it("reads file past an earlier attribute whose value holds a >", () => {
    const text = [
      '<SettingsShot alt="Before > after" file="a.png" />',
      "<SettingsShot alt='x > y' file='b.png' />",
      '<SettingsShot alt={count > 1 ? "many" : "one"} file="c.png" />',
      '<SettingsShot alt={`a } > { b`} file="d.png" />',
      '<SettingsShot alt="Tab one"\n  file="e.png"\n/>',
      '<SettingsShot alt="No self-close" file="f.png"></SettingsShot>',
    ].join("\n");

    expect(settingsShotFiles(text)).toEqual({
      files: ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"],
      problems: [],
    });
  });

  it("reads only SettingsShot tags, and none in a mention or an import", () => {
    const text = [
      'import SettingsShot from "../../../../components/SettingsShot.astro";',
      '<SettingsShots file="not-this.png" />',
      '<Image file="nor-this.png" />',
      "The SettingsShot component, written as `SettingsShot`.",
      '<SettingsShot file="yes.png" alt="Yes" />',
    ].join("\n");

    expect(settingsShotFiles(text)).toEqual({ files: ["yes.png"], problems: [] });
  });

  it("refuses a file it cannot read as a literal, naming the line", () => {
    const cases = [
      ['<SettingsShot file={name} alt="A" />', "has file={name}, which is not a string literal"],
      ["<SettingsShot file={`tab-${n}.png`} />", "which is not a string literal"],
      ['<SettingsShot alt="No file" />', "has no file"],
      ['<SettingsShot alt="Bare" file />', "a file with no value"],
      ['<SettingsShot file="a.png" file="b.png" />', "names file more than once"],
      ['<SettingsShot {...props} file="a.png" />', "spread"],
      ['<SettingsShot file="a.png" {...props} />', "spread"],
      ['<SettingsShot file="a.png" alt="never closed', "the value of alt is never closed"],
      ['<SettingsShot file="a.png"', "the tag is never closed"],
      ["<SettingsShot file=a.png />", "file= has no value"],
    ];

    for (const [tag, expected] of cases) {
      const { files, problems } = settingsShotFiles(`Intro.\n\n${tag}\n`);

      expect(files, tag).toEqual([]);
      expect(problems, tag).toHaveLength(1);
      expect(problems[0], tag).toMatch(/^line 3: <SettingsShot> /);
      expect(problems[0], tag).toContain(expected);
    }
  });

  it("keeps reading the tags after one it refuses", () => {
    const { files, problems } = settingsShotFiles('<SettingsShot file={name} />\n<SettingsShot file="b.png" />');

    expect(files).toEqual(["b.png"]);
    expect(problems).toHaveLength(1);
  });
});

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

  it("name their file as a literal, so the checks below can read it", () => {
    const problems = contentFiles().flatMap(({ file, text }) =>
      settingsShotFiles(text).problems.map((problem) => `${file} ${problem}`),
    );

    expect(problems).toEqual([]);
  });

  it("name only files the capture writes, since a misspelt one would render nothing", () => {
    const unknown = contentFiles().flatMap(({ file, text }) =>
      settingsShotFiles(text)
        .files.filter((shot) => !tabFiles.includes(shot))
        .map((shot) => `${file}: ${shot}`),
    );

    expect(unknown).toEqual([]);
  });

  it("show every tab exactly once on the Settings page", () => {
    const { files: shots } = settingsShotFiles(readFileSync(settingsPage, "utf8"));

    expect([...shots].sort()).toEqual([...tabFiles].sort());
  });
});
