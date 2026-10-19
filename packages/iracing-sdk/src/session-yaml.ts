import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

import type { SessionInfo } from "./types.js";

export interface ParsedSessionYaml {
  info: SessionInfo | null;
  /** Dotted paths of the map keys that appeared more than once, e.g. `CarSetup.Tires` */
  repeatedKeys: string[];
}

/**
 * Parse iRacing's session-info YAML, tolerating a map key that appears twice.
 *
 * iRacing's YAML is not always valid: the Euro NASCAR car's setup has two
 * `CarSetup.Tires` sections, the first holding only `TireType` and the second
 * the per-corner data (#1461). A repeated key whose values are both maps is
 * merged, so neither section is lost; for any other repeat the later value wins.
 *
 * @throws the first parse error when the text is not YAML at all
 */
export function parseSessionInfoYaml(text: string): ParsedSessionYaml {
  const doc = parseDocument(text, { uniqueKeys: false });

  if (doc.errors.length > 0) {
    throw doc.errors[0];
  }

  const repeatedKeys: string[] = [];

  if (isMap(doc.contents)) {
    mergeRepeatedKeys(doc.contents, "", repeatedKeys);
  }

  return { info: doc.toJS() as SessionInfo | null, repeatedKeys: [...new Set(repeatedKeys)] };
}

function mergeRepeatedKeys(map: YAMLMap, path: string, repeatedKeys: string[]): void {
  const byKey = new Map<unknown, (typeof map.items)[number]>();
  const kept: typeof map.items = [];

  for (const pair of map.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    const earlier = byKey.get(key);

    if (!earlier) {
      byKey.set(key, pair);
      kept.push(pair);
      continue;
    }

    repeatedKeys.push(path ? `${path}.${String(key)}` : String(key));

    if (isMap(earlier.value) && isMap(pair.value)) {
      earlier.value.items.push(...pair.value.items);
    } else {
      earlier.value = pair.value;
    }
  }

  map.items = kept;

  for (const pair of kept) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    const childPath = path ? `${path}.${String(key)}` : String(key);

    if (isMap(pair.value)) {
      mergeRepeatedKeys(pair.value, childPath, repeatedKeys);
    } else if (isSeq(pair.value)) {
      // Each item of a sequence that is a map is walked on its own
      for (const item of pair.value.items) {
        if (isMap(item)) mergeRepeatedKeys(item, `${childPath}[]`, repeatedKeys);
      }
    }
  }
}
