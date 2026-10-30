import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every action with a long press or a dial declares its press shape (#269).
 *
 * The press sounds read `pressShape` at every down event; an action that
 * declares none clicks on key down and, on a dial, clicks at a short release
 * at the default threshold and never bleeps. That is right for a plain key and
 * wrong for every dial and every dual-press key, so this pins the two places a
 * long press lives: an action whose Elgato manifest entry declares the
 * `Encoder` controller, and an action source that constructs a
 * `DualPressTracker`.
 */

const ACTIONS_DIR = import.meta.dirname;
const MANIFEST = join(ACTIONS_DIR, "../../../iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json");

interface ActionSource {
  file: string;
  text: string;
}

function actionSources(): ActionSource[] {
  const found: ActionSource[] = [];

  for (const dir of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    for (const file of readdirSync(join(ACTIONS_DIR, dir.name))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.includes(".test-")) continue;

      found.push({ file: `${dir.name}/${file}`, text: readFileSync(join(ACTIONS_DIR, dir.name, file), "utf8") });
    }
  }

  return found;
}

/** A `pressShape(` member declared on a class: indented, optionally `override`, followed by its parameter list. */
const DECLARES_PRESS_SHAPE = /^[ \t]+(?:override[ \t]+)?pressShape[ \t]*\(/m;

function encoderUuids(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    Actions: { UUID: string; Controllers?: string[] }[];
  };

  return manifest.Actions.filter((a) => a.Controllers?.includes("Encoder")).map((a) => a.UUID);
}

const sources = actionSources();

/** The source that declares an action's UUID constant, e.g. `export const SETUP_AERO_UUID = "…"`. */
function sourceDeclaringUuid(uuid: string): ActionSource | undefined {
  return sources.find((s) => new RegExp(`_UUID\\s*=\\s*"${uuid.replace(/\./g, "\\.")}"`).test(s.text));
}

const encoders = encoderUuids();
const dualPressSources = sources.filter((s) => /\bnew DualPressTracker\s*\(/.test(s.text));

describe("press shape coverage (#269)", () => {
  it("finds the Encoder actions in the Elgato manifest", () => {
    // A guard against a moved manifest or a changed controller name reading as
    // "nothing to check".
    expect(encoders.length).toBeGreaterThanOrEqual(17);
  });

  it("finds the actions that construct a DualPressTracker", () => {
    expect(dualPressSources.map((s) => s.file)).toContain("setup-aero/setup-aero.ts");
  });

  it.each(encoders)("finds the source of %s", (uuid) => {
    expect(sourceDeclaringUuid(uuid), `no action source declares ${uuid}`).toBeDefined();
  });

  it.each(encoders.map((uuid) => [uuid, sourceDeclaringUuid(uuid)?.file ?? "(not found)"]))(
    "dial action %s (%s) declares pressShape",
    (uuid) => {
      const source = sourceDeclaringUuid(uuid);

      expect(source && DECLARES_PRESS_SHAPE.test(source.text), `${source?.file ?? uuid} has no pressShape`).toBe(true);
    },
  );

  it.each(dualPressSources.map((s) => [s.file, s] as const))(
    "dual-press action %s declares pressShape",
    (_file, source) => {
      expect(DECLARES_PRESS_SHAPE.test(source.text), `${source.file} has no pressShape`).toBe(true);
    },
  );
});
