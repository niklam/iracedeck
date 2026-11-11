import { type EntryRef, isReference, type VoiceConfig } from "./config.ts";

/** The voice every other first-party voice copies from, so it always runs first. */
export const LEAD_VOICE_ID = "default";

/**
 * The order a run visits voices in: `default` first, then every other voice
 * by id. Fixed rather than the configs map's order so a voice whose entries
 * are verbatim Default's (Short callouts) always finds Default's fresh take
 * to copy, instead of paying for the same request a second time (#1643).
 */
export function orderVoices(voiceIds: Iterable<string>): string[] {
  const ids = Array.from(new Set(voiceIds));
  const rest = ids.filter((id) => id !== LEAD_VOICE_ID).sort();

  return ids.includes(LEAD_VOICE_ID) ? [LEAD_VOICE_ID, ...rest] : rest;
}

/** The `<group>/<entry-name>` references an entry is conditioned on, deduplicated, in the order written. */
export function entryReferences(entry: EntryRef["entry"]): string[] {
  const refs = [...(entry.previous_request_ids ?? []), ...(entry.next_request_ids ?? [])].filter(isReference);

  return Array.from(new Set(refs));
}

/** A config entry located in its voice, with its `<group>/<entry-name>` key. */
export type OrderedEntry = EntryRef & { key: string };

/**
 * Every entry of one voice, dependencies first (#1643).
 *
 * A stable topological sort over the `previous_request_ids` /
 * `next_request_ids` reference graph, with config order — group order, then
 * entry order within the group — as the tie-break: of the entries whose
 * dependencies have all been placed, the one written first goes next. So an
 * entry keeps its config position unless one of its dependencies is written
 * after it, in which case it waits for that dependency and nothing else
 * moves. A run cuts in this order, which is what lets a single unscoped run
 * condition every new take on its dependency's new take rather than on the
 * one the manifest held before.
 *
 * The graph must be acyclic (`detectReferenceCycles`); a cycle throws here
 * too, naming the entries left unplaced, rather than dropping them.
 */
export function topologicalEntryOrder(voice: VoiceConfig): OrderedEntry[] {
  const nodes: OrderedEntry[] = [];
  const indexOf = new Map<string, number>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      const key = `${groupName}/${entry.name}`;

      indexOf.set(key, nodes.length);
      nodes.push({ key, groupName, entry });
    }
  }

  const waitingOn = new Array<number>(nodes.length).fill(0);
  const dependents: number[][] = nodes.map(() => []);

  nodes.forEach((node, index) => {
    for (const ref of entryReferences(node.entry)) {
      const dep = indexOf.get(ref);

      if (dep === undefined) {
        // `validateReferences` refuses an unknown reference at load time.
        throw new Error(`Reference "${ref}" on "${node.key}" names no entry in this voice.`);
      }

      waitingOn[index]!++;
      dependents[dep]!.push(index);
    }
  });

  const ready = new MinHeap();

  waitingOn.forEach((count, index) => {
    if (count === 0) ready.push(index);
  });

  const order: OrderedEntry[] = [];

  while (ready.size > 0) {
    const index = ready.pop();

    order.push(nodes[index]!);

    for (const dependent of dependents[index]!) {
      if (--waitingOn[dependent]! === 0) ready.push(dependent);
    }
  }

  if (order.length !== nodes.length) {
    const unplaced = nodes.filter((_, index) => waitingOn[index]! > 0).map((node) => node.key);

    throw new Error(
      `Reference cycle among ${unplaced.join(", ")} — call detectReferenceCycles() before ordering a run.`,
    );
  }

  return order;
}

/** A binary min-heap of config indices: the ready entry written first is placed next. */
class MinHeap {
  private readonly items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: number): void {
    const items = this.items;

    items.push(value);

    let i = items.length - 1;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (items[parent]! <= items[i]!) break;

      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;

    if (items.length > 0) {
      items[0] = last;

      let i = 0;

      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;

        if (left < items.length && items[left]! < items[smallest]!) smallest = left;

        if (right < items.length && items[right]! < items[smallest]!) smallest = right;

        if (smallest === i) break;

        [items[smallest], items[i]] = [items[i]!, items[smallest]!];
        i = smallest;
      }
    }

    return top;
  }
}
