import { parseImportArg } from "./import-takes.ts";
import { parseScopeArgs, type Scope } from "./scope.ts";

/** Every flag the generator reads, as the refusal lists them. */
export const VALID_FLAGS = [
  "--dry-run",
  "--voice <name>[,<name>...]",
  "--group <name>[,<name>...]",
  "--entry <name>[,<name>...]",
  "--import <dir>",
] as const;

export interface GenerateArgs {
  scope: Scope;
  dryRun: boolean;
  importDir: string | null;
}

/**
 * Parse the generator's whole command line, refusing any argument it does
 * not read (#1643). The generator spends ElevenLabs credit unless
 * `--dry-run` is given, so a misspelled `--dryrun` that was silently
 * ignored started a paid run; now it stops the generator before anything
 * is loaded, naming the argument and the valid flags.
 */
export function parseGenerateArgs(argv: readonly string[]): GenerateArgs {
  const { importDir, rest } = parseImportArg(argv);
  const { scope, remaining } = parseScopeArgs(rest);
  const unknown = remaining.filter((arg) => arg !== "--dry-run");

  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument${unknown.length === 1 ? "" : "s"} ${unknown.map((arg) => JSON.stringify(arg)).join(", ")}; ` +
        `nothing was run.\n  Valid flags: ${VALID_FLAGS.join(", ")}`,
    );
  }

  return { scope, dryRun: remaining.includes("--dry-run"), importDir };
}
