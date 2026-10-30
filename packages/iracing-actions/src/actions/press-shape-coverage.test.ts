import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every action with a long press or a dial declares its press shape (#269).
 *
 * The press sounds ask one member per surface at every down event —
 * `keyPressShape`, `dialPressShape`, `touchPressShape` — and an action that
 * lacks the one for its surface clicks on key down and, on a dial, clicks at a
 * short release at the default threshold and never bleeps. That is right for a
 * plain key and wrong for every dial and every dual-press key, so this pins the
 * two places a long press lives: an action whose Elgato manifest entry
 * declares the `Encoder` controller must declare `dialPressShape`, and an
 * action source that constructs a `DualPressTracker` must declare
 * `keyPressShape` (every tracker today records a key-down; Car Control's also
 * serves its dial, which declares `dialPressShape` as an `Encoder` action).
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

/** A `<name>(` member declared on a class: indented, optionally `override`, followed by its parameter list. */
function declaresMember(text: string, name: "keyPressShape" | "dialPressShape"): boolean {
  return new RegExp(`^[ \\t]+(?:override[ \\t]+)?${name}[ \\t]*\\(`, "m").test(text);
}

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

  it("recognises a declared member and nothing else (positive control)", () => {
    expect(declaresMember("  dialPressShape(ev: IDeckDialDownEvent<X>): PressShape {", "dialPressShape")).toBe(true);
    expect(declaresMember("  override keyPressShape(ev: E): PressShape {", "keyPressShape")).toBe(true);
    // A call of the free helper, a free function, a property read and the other surface's member are not it.
    expect(declaresMember("    return dialGestureShape({", "dialPressShape")).toBe(false);
    expect(declaresMember("export function dialPressShape(args: A) {", "dialPressShape")).toBe(false);
    expect(declaresMember("    const s = handler.dialPressShape?.(ev);", "dialPressShape")).toBe(false);
    expect(declaresMember("  keyPressShape(ev: E): PressShape {", "dialPressShape")).toBe(false);
    // The superseded single member satisfies neither.
    expect(declaresMember("  pressShape(ev: E): PressShape {", "dialPressShape")).toBe(false);
    expect(declaresMember("  pressShape(ev: E): PressShape {", "keyPressShape")).toBe(false);
  });

  it.each(encoders.map((uuid) => [uuid, sourceDeclaringUuid(uuid)?.file ?? "(not found)"]))(
    "dial action %s (%s) declares dialPressShape",
    (uuid) => {
      const source = sourceDeclaringUuid(uuid);

      expect(
        source && declaresMember(source.text, "dialPressShape"),
        `${source?.file ?? uuid} has no dialPressShape`,
      ).toBe(true);
    },
  );

  it.each(dualPressSources.map((s) => [s.file, s] as const))(
    "dual-press action %s declares keyPressShape",
    (_file, source) => {
      expect(declaresMember(source.text, "keyPressShape"), `${source.file} has no keyPressShape`).toBe(true);
    },
  );
});
