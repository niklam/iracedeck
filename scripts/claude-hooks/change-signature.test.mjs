import { describe, expect, it } from "vitest";

import { changedFiles, parseChangeSignature } from "./change-signature.mjs";

const header = (file) => `diff --git a/${file} b/${file}`;

/** A one-file `--unified=0 --full-index` diff, the shape the replay's line check hands the parser. */
function textDiff(
  file,
  { hunk = "@@ -10,0 +11,2 @@", index = "index 1111111..2222222 100644", body = ["+a", "+b"] } = {},
) {
  return [header(file), index, `--- a/${file}`, `+++ b/${file}`, hunk, ...body].join("\n");
}

const sig = (...diffs) => parseChangeSignature(diffs.join("\n") + "\n");

describe("parseChangeSignature", () => {
  it("keys each file by its whole header and drops hunk headers and a text file's index line", () => {
    const files = sig(textDiff("src/a.ts"));
    expect([...files.keys()]).toEqual([header("src/a.ts")]);
    expect(files.get(header("src/a.ts"))).toEqual([header("src/a.ts"), "--- a/src/a.ts", "+++ b/src/a.ts", "+a", "+b"]);
  });

  it("keeps a binary file's index line, since its blob id is its content", () => {
    const files = sig(
      [header("i.png"), "index aaaa..bbbb 100644", "Binary files a/i.png and b/i.png differ"].join("\n"),
    );
    expect(files.get(header("i.png"))).toEqual([
      header("i.png"),
      "index aaaa..bbbb 100644",
      "Binary files a/i.png and b/i.png differ",
    ]);
  });

  it("cannot let a path containing ' b/' shadow another file", () => {
    const files = sig(textDiff("c"), textDiff("a b/c"));
    expect(files.size).toBe(2);
  });

  it("keeps both blocks of a typechange, which git prints under one header", () => {
    const typechange = [
      header("f"),
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/f",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-master fix",
      header("f"),
      "new file mode 120000",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/f",
      "@@ -0,0 +1 @@",
      "+target",
    ].join("\n");
    expect(sig(typechange).get(header("f"))).toContain("-master fix");
    expect(sig(typechange).get(header("f"))).toContain("+target");
  });

  it("keeps a CR as part of the line — git emits LF, and a CR is the file's own byte", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { body: ["+a\r", "+b"] })))).toEqual([
      header("a.ts"),
    ]);
  });

  it("compares bytes outside UTF-8 exactly when read as latin1", () => {
    expect(
      changedFiles(sig(textDiff("a.ts", { body: ["+Ren\xe9"] })), sig(textDiff("a.ts", { body: ["+Ren\xe8"] }))),
    ).toEqual([header("a.ts")]);
  });

  it("does not attach the trailing newline to the last file", () => {
    expect(sig(textDiff("a.ts")).get(header("a.ts")).at(-1)).toBe("+b");
  });

  it("is empty for an empty diff", () => expect(parseChangeSignature("").size).toBe(0));
});

describe("changedFiles", () => {
  it("calls the same lines at shifted line numbers a match", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { hunk: "@@ -40,0 +41,2 @@ ctx" })))).toEqual([]);
  });

  it("ignores a text file's post-image blob, which a rebase changes", () => {
    expect(
      changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { index: "index 3333333..4444444 100644" }))),
    ).toEqual([]);
  });

  it("names a file whose added line changed", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { body: ["+a", "+B"] })))).toEqual([
      header("a.ts"),
    ]);
  });

  it("names a file whose lines were reordered", () => {
    expect(changedFiles(sig(textDiff("a.ts")), sig(textDiff("a.ts", { body: ["+b", "+a"] })))).toEqual([
      header("a.ts"),
    ]);
  });

  it("names a file whose removed line changed", () => {
    const before = sig(textDiff("a.ts", { body: ["-old"] }));
    expect(changedFiles(before, sig(textDiff("a.ts", { body: ["-other"] })))).toEqual([header("a.ts")]);
  });

  it("names a file added to or dropped from the change", () => {
    const one = sig(textDiff("a.ts"));
    const two = sig(textDiff("a.ts"), textDiff("b.ts"));
    expect(changedFiles(one, two)).toEqual([header("b.ts")]);
    expect(changedFiles(two, one)).toEqual([header("b.ts")]);
  });

  it("names a file whose mode changed", () => {
    const plain = `${header("run.sh")}\nold mode 100644\nnew mode 100755`;
    const other = `${header("run.sh")}\nold mode 100644\nnew mode 100644`;
    expect(changedFiles(sig(plain), sig(other))).toEqual([header("run.sh")]);
  });

  it("names a binary file whose post-image blob changed", () => {
    const bin = (blob) =>
      [header("i.png"), `index aaaa..${blob} 100644`, "Binary files a/i.png and b/i.png differ"].join("\n");
    expect(changedFiles(sig(bin("bbbb")), sig(bin("bbbb")))).toEqual([]);
    expect(changedFiles(sig(bin("bbbb")), sig(bin("cccc")))).toEqual([header("i.png")]);
  });
});
