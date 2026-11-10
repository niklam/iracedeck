/**
 * Driver-name aliases (#1580): spellings of a first name that are SPOKEN as
 * another name in the list, and so play that name's clips rather than five
 * clips of their own per voice.
 *
 * A driver name is a slug — the `<name>` of `voice/<voice>/names/<name>.mp3`
 * and of the same pool in each greeting group. Equivalence of spellings is a
 * fact about the name, not about the voice (Geoff is said "Jeff" whichever
 * engineer says it), so one map serves every voice, a third-party pack that
 * records `jeff` serves Geoff users with no work of its own, and a pack that
 * records the alias spelling itself (`dominik`) plays its own clips for it —
 * the precedence {@link resolveDriverNameSlug} applies. Design record:
 * `docs/superpowers/specs/2026-11-01-issue-1580-name-alias-map.md`.
 */
import { TAKE_SUFFIX } from "./coverage.js";

/**
 * Alias slug → the canonical slug whose clips it plays. Flat, so an alias
 * names exactly one canonical by construction (a repeated key is a type
 * error in an object literal); one hop, so no canonical is itself a key.
 * Sorted by key. {@link validateDriverNameAliases} holds it to those rules.
 */
export const DRIVER_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  dominik: "dominic",
  geoff: "jeff",
  kris: "chris",
});

/**
 * The groups a driver name is spoken from, so no consumer keeps its own list
 * of them. `names` is the group whose clips decide whether a voice records a
 * name ({@link resolveDriverNameSlug}'s `recorded`); the other four are the
 * greeting groups the engine's name vars draw from.
 */
export const DRIVER_NAME_GROUPS = Object.freeze([
  "names",
  "session-start-greeting",
  "race-start-greeting",
  "race-end-greeting",
  "position-overtake-come-on",
] as const);

/** One of {@link DRIVER_NAME_GROUPS}. */
export type DriverNameGroup = (typeof DRIVER_NAME_GROUPS)[number];

/** A name slug: lowercase ASCII letters and digits, optionally joined by single hyphens. */
const NAME_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `slug` is not a usable name slug, or `null` when it is. */
function slugProblem(slug: string): string | null {
  if (!NAME_SLUG.test(slug)) {
    return "is not a name slug (lowercase letters and digits, optionally joined by single hyphens)";
  }

  // A stored `-NN` is folded off before the map is read, so a key or a value
  // carrying one could never be looked up or would name a take, not a name.
  if (TAKE_SUFFIX.test(slug)) return "ends in a take suffix (-NN), which is folded off before the map is read";

  return null;
}

/**
 * Every problem with an alias map, one per broken entry, each
 * `<alias>: <message>`; an empty list means the map is usable. The rules:
 * both sides are name slugs that do not end in a take suffix; an alias is
 * not its own canonical; no canonical is also a key (resolution is one hop,
 * so a chain is a second hop nobody follows); and no alias is another
 * entry's canonical (the same rule from the other side, so the message
 * names the entry that breaks it). An entry breaking several rules is
 * reported by the first, in that order.
 */
export function validateDriverNameAliases(map: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const entries = Object.entries(map);
  const canonicals = new Map<string, string[]>();

  for (const [alias, canonical] of entries) {
    if (alias === canonical) continue;

    const aliasesOf = canonicals.get(canonical) ?? [];

    aliasesOf.push(alias);
    canonicals.set(canonical, aliasesOf);
  }

  for (const [alias, canonical] of entries) {
    const aliasSlug = slugProblem(alias);

    if (aliasSlug !== null) {
      problems.push(`${alias}: the alias ${aliasSlug}`);
      continue;
    }

    const canonicalSlug = slugProblem(canonical);

    if (canonicalSlug !== null) {
      problems.push(`${alias}: the canonical "${canonical}" ${canonicalSlug}`);
      continue;
    }

    if (alias === canonical) {
      problems.push(`${alias}: an alias cannot be its own canonical`);
      continue;
    }

    if (Object.hasOwn(map, canonical)) {
      problems.push(
        `${alias}: its canonical "${canonical}" is itself an alias (of "${map[canonical]}"); resolution is one hop, so name the final canonical`,
      );
      continue;
    }

    const aliasedBy = canonicals.get(alias);

    if (aliasedBy !== undefined) {
      problems.push(
        `${alias}: is the canonical of ${aliasedBy.map((a) => `"${a}"`).join(", ")}, so it cannot be an alias`,
      );
    }
  }

  return problems;
}

/**
 * The slug whose clips speak `spelling` in a voice that records the names in
 * `recorded` — that voice's OWN take-folded `names/` bases, never the union
 * across installed voices: `spelling` itself when the voice records it (a
 * pack that records an alias spelling plays its own clips), else the alias's
 * canonical when the voice records that, else `null` (the voice has neither,
 * and the caller plays the spelling unchanged, today's behaviour for a name
 * a voice lacks). The `names/` group decides for every line, so one name is
 * always spoken from one clip set.
 */
export function resolveDriverNameSlug(
  spelling: string,
  recorded: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>> = DRIVER_NAME_ALIASES,
): string | null {
  if (recorded.has(spelling)) return spelling;

  // `hasOwn`, not a lookup: `constructor` is a well-formed name slug.
  if (!Object.hasOwn(aliases, spelling)) return null;

  const canonical = aliases[spelling];

  return recorded.has(canonical) ? canonical : null;
}
