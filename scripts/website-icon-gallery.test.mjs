import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The website's icon gallery publishes every icon as a finished picture, so a
 * `{{placeholder}}` in one of its assets is a value nobody filled, shown to
 * visitors as literal text — as `{{speedText}}` and `{{needleAngle}}` were
 * until #1352. The generated files are gitignored, so there is nothing
 * committed to read: this runs the REAL generator as a subprocess, the way a
 * build invokes it, and reads what it wrote. That is the only shape that
 * covers every class of asset and the script's own wiring; the pure halves
 * (the sample lookup, the leftover check) are unit-tested beside them in
 * packages/website/src/gallery-gen/lib.test.ts.
 *
 * `--out` sends both outputs to a scratch directory, never to
 * packages/website: a dev server, a build or the typecheck guard's own
 * `generate:gallery` may be reading or rewriting the real ones.
 *
 * The generator resolves `@iracedeck/icon-composer` and `@iracedeck/deck-core`
 * through their built `dist/`, like the website's own scripts do — `pnpm test`
 * runs after `pnpm build` in CI, and typecheck-script-coverage.test.mjs
 * already runs this generator through the website's `typecheck` script.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const generator = path.join(repoRoot, "packages", "website", "scripts", "generate-icon-gallery.mts");

// Enforced by `execFileSync`, not by the Vitest timeout below: Vitest cannot
// interrupt a synchronous child, so a hung generator would otherwise block the
// worker until the CI job limit. Generous against the ~1 s a run takes.
const GENERATOR_TIMEOUT_MS = 60_000;

/** Every file under `dir`, as `/`-separated paths relative to it. */
function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((dirent) =>
    dirent.isDirectory()
      ? listFiles(path.join(dir, dirent.name), `${prefix}${dirent.name}/`)
      : [`${prefix}${dirent.name}`],
  );
}

describe("website icon gallery", () => {
  let scratch;
  let assetsDir;
  let assets;
  let entries;

  beforeAll(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "website-icon-gallery-"));

    // `import.meta.resolve` finds tsx's CLI entry without a shell or the
    // node_modules/.bin shims, which keeps this Windows-safe (the same launch
    // as website-voice-catalog-json.test.mjs). A failing generator throws here
    // with its stderr in the message, which is where it names the icon.
    const tsxCli = url.fileURLToPath(import.meta.resolve("tsx/cli"));

    execFileSync(process.execPath, [tsxCli, generator, "--out", scratch], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GENERATOR_TIMEOUT_MS,
    });

    assetsDir = path.join(scratch, "public", "icon-gallery");
    assets = listFiles(assetsDir);
    entries = JSON.parse(readFileSync(path.join(scratch, "src", "data", "icon-gallery.json"), "utf-8"));
  }, GENERATOR_TIMEOUT_MS + 10_000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("writes one asset per gallery entry, in every class", () => {
    // What makes the scan below mean something: a run that wrote nothing, or
    // skipped a class, would pass it vacuously.
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.slice().sort()).toEqual(entries.map((entry) => entry.file.replace("/icon-gallery/", "")).sort());
    expect([...new Set(entries.map((entry) => entry.class))].sort()).toEqual([
      "category",
      "dial",
      "dynamic",
      "key",
      "template",
    ]);
  });

  it("leaves no {{placeholder}} in any generated asset", () => {
    // Scanned here with a plain substring, not with the generator's own
    // check, so a hole in that check is not also a hole in this one.
    const leaking = assets.filter((asset) => readFileSync(path.join(assetsDir, asset), "utf-8").includes("{{"));

    expect(leaking).toEqual([]);
  });

  it("draws a sample value into the template icons that carry one", () => {
    const expected = {
      "camera-focus/switch-by-car-number": ">42<",
      "camera-focus/switch-by-position": ">P3<",
      "replay-control/speed-display": ">1x<",
      "replay-control/set-speed": "rotate(0, 38, 38)",
    };

    // Each is captioned "(sample)" on its card, like the dynamic class.
    const sampled = entries
      .filter((entry) => entry.class === "template" && entry.sample)
      .map((entry) => `${entry.family}/${entry.name}`);

    for (const [iconPath, drawn] of Object.entries(expected)) {
      expect(readFileSync(path.join(assetsDir, "template", `${iconPath}.svg`), "utf-8"), iconPath).toContain(drawn);
      expect(sampled).toContain(iconPath);
    }
  });
});
