/**
 * Auto Group on Car Change's pure half (#1656,
 * `docs/superpowers/specs/2026-11-08-issue-1656-auto-camera-group-on-car-change.md`):
 * the two settings fields a key and a dial store, the list they resolve to,
 * the candidates that list leaves in the current session, and the pick of the
 * next group. The run itself (ticks, the settle timer, the send) is in
 * `auto-group.ts`; this leaf reads no telemetry, settings or SDK, so the key,
 * the dial and the run share one answer.
 */
import type { CameraGroup } from "@iracedeck/iracing-sdk";
import z from "zod";

import { foldGroupName, matchSessionGroup, parseGroupSubset, resolveEnabledSessionGroups } from "./camera-groups.js";

/**
 * The groups a fresh key or dial has ticked (spec decision 6): the three every
 * track has, so the automation works out of the box.
 */
export const AUTO_GROUP_DEFAULT_GROUPS: readonly string[] = ["TV1", "TV2", "TV3"];

/**
 * The list's stored shape (`autoGroupSubset`, `dial.autoGroupSubset`): Cycle
 * Camera's subset since #1653, a JSON string or an object holding a
 * name → boolean `groups` map. Junk reads as nothing stored, which is the
 * default list, and never fails the action's parse.
 */
export const AutoGroupSubsetField = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .optional()
  .catch(undefined);

/** How the next group is chosen (`autoGroupPick`, `dial.autoGroupPick`): in the session's order, or at random. */
export const AutoGroupPickField = z.enum(["in-order", "random"]).default("in-order").catch("in-order");

/** In order, or at random. */
export type AutoGroupPick = z.infer<typeof AutoGroupPickField>;

/**
 * The names a stored list ticks, canonically spelled. Nothing stored, or
 * something unreadable, is the default list ({@link AUTO_GROUP_DEFAULT_GROUPS}).
 * Unlike Cycle Camera's `getEnabledGroupNames` there is no legacy global
 * fallback: this list never lived in the global settings.
 */
export function autoGroupNames(raw: string | Record<string, unknown> | undefined): string[] {
  return parseGroupSubset(raw) ?? [...AUTO_GROUP_DEFAULT_GROUPS];
}

/** The list resolved against the session: what can be picked, and the names that could not be. */
export interface AutoGroupCandidates {
  /** The session groups the names resolve to, each once, in the session's order. */
  readonly groups: CameraGroup[];
  /** Ticked names the session has no group for, skipped silently (logged at debug). */
  readonly missing: string[];
  /** Ticked names matching several groups that differ only in case, skipped. */
  readonly ambiguous: string[];
}

/**
 * The candidates for the next pick: the ticked names the session has, matched
 * with #1653's lookup (`resolveEnabledSessionGroups`), in the sim's group
 * order. Expects `normalizeSessionGroups` output.
 */
export function autoGroupCandidates(names: readonly string[], sessionGroups: CameraGroup[]): AutoGroupCandidates {
  const resolved = resolveEnabledSessionGroups([...names], sessionGroups);
  const missing = names.filter((name) => matchSessionGroup(sessionGroups, name).kind === "absent");

  return { groups: resolved.groups, missing, ambiguous: resolved.ambiguous };
}

/**
 * Whether the key or dial is drawn with the unavailable look (spec decision 5,
 * plan decision 2): a session's group list is loaded and the list leaves no
 * candidate in it, an empty list included. With no session there is nothing
 * to judge by, so never.
 */
export function isAutoGroupUnavailable(names: readonly string[], sessionGroups: CameraGroup[]): boolean {
  return sessionGroups.length > 0 && autoGroupCandidates(names, sessionGroups).groups.length === 0;
}

/** Where `name` sits among the candidates: an exact match first, then one differing only in case; -1 when gone. */
function indexOfName(candidates: CameraGroup[], name: string): number {
  const exact = candidates.findIndex((g) => g.groupName === name);

  if (exact !== -1) return exact;

  const folded = foldGroupName(name);

  return candidates.findIndex((g) => foldGroupName(g.groupName) === folded);
}

/**
 * The group to switch to (spec decision 5), or null to send nothing.
 *
 * - **No candidates:** null.
 * - **One:** it, unless the camera is in it already.
 * - **In order:** the candidate after the one picked last, found by NAME
 *   (the sim numbers its groups per session), wrapping at the end; the first
 *   candidate when nothing was picked yet or the last pick is no longer a
 *   candidate. When that is the group the camera is in, one step further, so
 *   with two or more candidates a car change is always a new shot.
 * - **Random:** uniform over the candidates other than the camera's group,
 *   with `random` returning a number in [0, 1) like `Math.random`.
 *
 * `currentGroupNum` is telemetry's `CamGroupNumber`, null when unknown.
 */
export function pickAutoGroup(
  candidates: CameraGroup[],
  currentGroupNum: number | null,
  pick: AutoGroupPick,
  lastPickedName: string | null,
  random: () => number = Math.random,
): CameraGroup | null {
  if (candidates.length === 0) return null;

  if (pick === "random") {
    const others = candidates.filter((g) => g.groupNum !== currentGroupNum);

    if (others.length === 0) return null;

    const index = Math.min(others.length - 1, Math.max(0, Math.floor(random() * others.length)));

    return others[index];
  }

  const last = lastPickedName === null ? -1 : indexOfName(candidates, lastPickedName);
  let index = last === -1 ? 0 : (last + 1) % candidates.length;

  if (candidates[index].groupNum === currentGroupNum) index = (index + 1) % candidates.length;

  const next = candidates[index];

  // Only one candidate can step back onto the camera's own group.
  return next.groupNum === currentGroupNum ? null : next;
}
