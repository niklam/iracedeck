/**
 * PostToolUse hook for Edit/Write: runs the generator whose source was just
 * edited (the committed output is freshness-tested, so editing without
 * regenerating fails the build later), and injects the reminders that go
 * with certain files. Reports what ran and which files it changed.
 */
import path from "node:path";

import { git, postContext, readInput, run, toplevel } from "./lib.mjs";
import { generatorsFor, remindersFor } from "./rules-post.mjs";

const input = await readInput();
const file = input.tool_input?.file_path ?? input.tool_response?.filePath;
if (typeof file === "string" && file) {
  const root = toplevel(path.dirname(file));
  if (root) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const notes = [];
    for (const g of generatorsFor(rel)) {
      const before = status(root);
      const r = run(g.cmd, g.args, { cwd: root, timeoutMs: 120_000 });
      const changed = status(root).filter((l) => !before.includes(l));
      if (r.ok)
        notes.push(
          `Ran ${g.label} (${[g.cmd, ...g.args].join(" ")})${changed.length ? `; it changed: ${changed.map((l) => l.slice(3)).join(", ")}` : "; output already fresh"}.`,
        );
      else notes.push(`${g.label} FAILED (${[g.cmd, ...g.args].join(" ")}):\n${(r.err || r.out).trim().slice(-1500)}`);
    }
    notes.push(...remindersFor(rel));
    if (notes.length) postContext(`[hook] ${notes.join("\n[hook] ")}`);
  }
}

function status(root) {
  const r = git(["status", "--porcelain"], root);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
}
