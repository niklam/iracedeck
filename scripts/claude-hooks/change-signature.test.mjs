import { describe, expect, it } from "vitest";

import { changedFiles, parseChangeSignature } from "./change-signature.mjs";

/** A one-file `--unified=0 --full-index` diff, the shape `changeSignature` hands the parser. */
function textDiff(
  file,
  { hunk = "@@ -10,0 +11,2 @@", index = "index 1111111..2222222 100644", body = ["+a", "+b"] } = {},
) {
  return [`diff --git a/${file} b/${file}`, index, `--- a/${file}`, `+++ b/${file}`, hunk, ...body].join("\n");
}

const sig = (...diffs) => parseChangeSignature(diffs.join("\n"));

describe("parseChangeSignature", () => {
  it("keys each file by its path and drops hunk headers and a text file's index line", () => {
    const files = sig(textDiff("src/a.ts"));
    expect([...files.keys()]).toEqual(["src/a.ts"]);
    expect(files.get("src/a.ts")).toEqual([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "+a",
      "+b",
    ]);
  });

  it("keeps a binary file's index line, since its blob id is its content", () => {
    const files = sig(
      ["diff --git a/i.png b/i.png", "index aaaa..bbbb 100644", "Binary files a/i.png and b/i.png differ"].join("\n"),
    );
    expect(files.get("i.png")).toContain("index aaaa..bbbb 100644");
  });

  it("reads a path with spaces", () => {
    expect([...sig(textDiff("docs/a b.md")).keys()]).toEqual(["docs/a b.md"]);
  });

  it("reads CRLF output like LF", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts").replace(/\n/g, "\r\n")))).toEqual([]);
  });

  it("is empty for an empty diff", () => expect(sig("").size).toBe(0));
});

describe("changedFiles", () => {
  it("calls the same change at shifted line numbers a pure rebase", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { hunk: "@@ -40,0 +41,2 @@ ctx" })))).toEqual([]);
  });

  it("ignores a text file's post-image blob, which a rebase changes", () => {
    expect(
      changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { index: "index 3333333..4444444 100644" }))),
    ).toEqual([]);
  });

  it("names a file whose added line changed — the conflict resolution the exception must never pass", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { body: ["+a", "+B"] })))).toEqual(["a.ts"]);
  });

  it("names a file whose lines were reordered", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { body: ["+b", "+a"] })))).toEqual(["a.ts"]);
  });

  it("names a file whose removed line changed", () => {
    const before = sig(textDiff("a.ts", { body: ["-old"] }));
    expect(changedFiles(before, sig(textDiff("a.ts", { body: ["-other"] })))).toEqual(["a.ts"]);
  });

  it("names a file added to or dropped from the change", () => {
    const one = sig(textDiff("a.ts"));
    const two = sig(textDiff("a.ts"), textDiff("b.ts"));
    expect(changedFiles(one, two)).toEqual(["b.ts"]);
    expect(changedFiles(two, one)).toEqual(["b.ts"]);
  });

  it("names a file whose mode changed", () => {
    const plain = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755";
    const other = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100644";
    expect(changedFiles(sig(plain), sig(other))).toEqual(["run.sh"]);
  });

  it("names a binary file whose post-image blob changed", () => {
    const bin = (blob) =>
      ["diff --git a/i.png b/i.png", `index aaaa..${blob} 100644`, "Binary files a/i.png and b/i.png differ"].join(
        "\n",
      );
    expect(changedFiles(sig(bin("bbbb")), sig(bin("bbbb")))).toEqual([]);
    expect(changedFiles(sig(bin("bbbb")), sig(bin("cccc")))).toEqual(["i.png"]);
  });

  it("sorts the differing paths", () => {
    const a = sig(textDiff("z.ts"), textDiff("a.ts"));
    const b = sig(textDiff("z.ts", { body: ["+x"] }), textDiff("a.ts", { body: ["+y"] }));
    expect(changedFiles(a, b)).toEqual(["a.ts", "z.ts"]);
  });
});
