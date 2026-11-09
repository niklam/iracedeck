import { describe, expect, it, vi } from "vitest";

import { checkPackRecords, sealPackRecords } from "../../packages/audio-assets/src/build/pack-record.mjs";
import { isModuleNotFound, loadPackRecordModule } from "./pack-record-module.mjs";

/** An error shaped the way Node throws one. */
const notFound = (code, message) => Object.assign(new Error(message), { code });

describe("isModuleNotFound", () => {
  it("recognises both of Node's codes and nothing else", () => {
    expect(isModuleNotFound(notFound("ERR_MODULE_NOT_FOUND", "x"))).toBe(true);
    expect(isModuleNotFound(notFound("MODULE_NOT_FOUND", "x"))).toBe(true);
    expect(isModuleNotFound(notFound("ERR_PACKAGE_PATH_NOT_EXPORTED", "x"))).toBe(false);
    expect(isModuleNotFound(new Error("x"))).toBe(false);
    expect(isModuleNotFound(undefined)).toBe(false);
    expect(isModuleNotFound("ERR_MODULE_NOT_FOUND")).toBe(false);
  });
});

describe("loadPackRecordModule", () => {
  it("loads the real record module and the format module's selectPacks", async () => {
    const loaded = await loadPackRecordModule();

    expect(loaded.checkPackRecords).toBe(checkPackRecords);
    expect(loaded.sealPackRecords).toBe(sealPackRecords);
    expect(typeof loaded.selectPacks).toBe("function");
    expect(loaded.selectPacks(["default"]).map((pack) => pack.id)).toEqual(["default"]);
  });

  it("asks for both modules by their file URLs and merges them", async () => {
    const importer = vi.fn(async (url) =>
      url.endsWith("pack-format.mjs") ? { selectPacks: "format" } : { sealPackRecords: "record", selectPacks: "wrong" },
    );

    const loaded = await loadPackRecordModule(importer);

    const urls = importer.mock.calls.map(([url]) => url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^file:.*\/packages\/audio-assets\/src\/build\/pack-record\.mjs$/);
    expect(urls[1]).toMatch(/^file:.*\/packages\/audio-assets\/src\/build\/pack-format\.mjs$/);
    expect(loaded).toEqual({ sealPackRecords: "record", selectPacks: "format" });
  });

  // What an unbuilt or cleaned tree throws: the record module's import of
  // `@iracedeck/callout-script` resolves to a dist/ that is not there.
  it("turns a missing module into an error naming pnpm build, with the original as its cause", async () => {
    const original = notFound(
      "ERR_MODULE_NOT_FOUND",
      "Cannot find package '@iracedeck/callout-script' imported from .../src/build/index.mjs",
    );
    const importer = vi.fn(async () => {
      throw original;
    });

    const error = await loadPackRecordModule(importer).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "The voice-pack record module could not be loaded: Cannot find package '@iracedeck/callout-script' imported " +
        "from .../src/build/index.mjs\nThe tree is not built — the record module imports @iracedeck/callout-script, " +
        "whose dist/ only the build writes. Run `pnpm build`, then run this again. Nothing was written.",
    );
    expect(error.cause).toBe(original);
  });

  it("rethrows any other failure as it is", async () => {
    const syntax = new SyntaxError("Unexpected token");
    const exported = notFound("ERR_PACKAGE_PATH_NOT_EXPORTED", "not exported");

    await expect(
      loadPackRecordModule(async () => {
        throw syntax;
      }),
    ).rejects.toBe(syntax);
    await expect(
      loadPackRecordModule(async () => {
        throw exported;
      }),
    ).rejects.toBe(exported);
  });
});
