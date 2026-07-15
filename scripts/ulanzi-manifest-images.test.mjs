import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/ulanzi-manifest-images.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(
    join(repoRoot, "packages/iracing-plugin-ulanzi/com.ulanzi.iracedeck.ulanziPlugin/manifest.json"),
    "utf-8",
  ),
);

/** Collect every image reference in the Ulanzi manifest as [label, ref] pairs. */
function imageRefs() {
  const refs = [
    ["Icon", manifest.Icon],
    ["CategoryIcon", manifest.CategoryIcon],
  ];

  for (const action of manifest.Actions) {
    refs.push([`${action.Name} Icon`, action.Icon]);

    for (const [i, state] of (action.States ?? []).entries()) {
      refs.push([`${action.Name} States[${i}].Image`, state.Image]);
    }
  }

  return refs.filter(([, ref]) => typeof ref === "string");
}

/**
 * Map a manifest image reference to its committed source file. The plugin's own
 * `imgs/` tree is build output (gitignored): per-action icons are copied from
 * `@iracedeck/iracing-actions` and plugin-level branding from the Elgato plugin
 * (see the Ulanzi plugin's rollup `copy-assets` step), so existence is checked
 * against those committed sources.
 */
function committedSource(ref) {
  const action = ref.match(/^imgs\/actions\/([^/]+)\/(.+)$/);
  if (action) return join(repoRoot, "packages/iracing-actions/src/actions", action[1], action[2]);

  const plugin = ref.match(/^imgs\/plugin\/(.+)$/);
  if (plugin) {
    return join(repoRoot, "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/imgs/plugin", plugin[1]);
  }

  return null;
}

describe("ulanzi manifest image references", () => {
  // UlanziStudio resolves manifest image paths literally — unlike the Elgato
  // host it does not probe for .png/.svg/@2x variants, so an extensionless
  // reference (the Elgato manifest convention) renders no icon. Every
  // first-party Ulanzi plugin declares explicit extensions (issue #845).
  it.each(imageRefs())("declares an explicit file extension: %s", (_label, ref) => {
    expect(ref).toMatch(/\.(png|svg)$/);
  });

  it.each(imageRefs())("resolves to a committed source file: %s", (_label, ref) => {
    const source = committedSource(ref);

    expect(source, `unrecognized image path shape: ${ref}`).not.toBeNull();
    expect(existsSync(source), `missing source for ${ref}: ${source}`).toBe(true);
  });
});
