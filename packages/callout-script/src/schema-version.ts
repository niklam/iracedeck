/**
 * Whether a parsed document declares a format NEWER than `current`: its
 * `schema` is a number above it.
 *
 * Package-internal — the grammar (`schema.ts`) and the pack manifest
 * (`voice-pack.ts`) both word a `schema` problem as "written for a newer
 * version of iRaceDeck" only when this holds, and it is here, rather than in
 * either, so the two cannot come to disagree about what "newer" means. Not
 * exported from the package index: it is a rule about how this package phrases
 * its own problems, not something a consumer decides with.
 *
 * Only a NUMBER above the current version counts (#1134). A missing `schema`,
 * a `0` or a string is an author's mistake, not a pack from a newer toolchain,
 * and telling that author to update the plugin would send them away from the
 * one line they need to fix.
 */
export function declaresNewerSchema(json: unknown, current: number): boolean {
  if (json === null || typeof json !== "object") return false;

  const schema = (json as { schema?: unknown }).schema;

  return typeof schema === "number" && schema > current;
}
