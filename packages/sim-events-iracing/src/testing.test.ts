import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { captureFixturePath } from "./testing.js";

/** The folder, without a trailing separator, as `dirname` reports it. */
const FIXTURES = resolve(fileURLToPath(new URL("./diff/__fixtures__/", import.meta.url)));

describe("captureFixturePath", () => {
  it("resolves a fixture into this package's src/diff/__fixtures__ folder", () => {
    const path = captureFixturePath("caution-road-20260918.json");

    expect(dirname(path)).toBe(FIXTURES);
    expect(basename(path)).toBe("caution-road-20260918.json");
    expect(Array.isArray(JSON.parse(readFileSync(path, "utf-8")))).toBe(true);
  });

  it("resolves every JSON capture in the folder", () => {
    const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));

    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(basename(captureFixturePath(name))).toBe(name);
    }
  });

  it.each([
    "../index.ts",
    "diff/caution.ts",
    "caution-road-20260918",
    "/etc/passwd.json",
    "a\\b.json",
    "Caution.JSON",
    "",
  ])("refuses %j, which is not a bare .json file name", (name) => {
    expect(() => captureFixturePath(name)).toThrow(/not a bare fixture file name/);
  });

  it("refuses a name the folder does not hold, naming the folder", () => {
    expect(() => captureFixturePath("no-such-capture-20000101.json")).toThrow(
      /no fixture "no-such-capture-20000101\.json" in /,
    );
  });
});
