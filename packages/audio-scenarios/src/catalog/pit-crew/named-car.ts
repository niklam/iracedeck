/**
 * The engineer's memory of the car he last told the driver to line up behind
 * (issue #1286), shared by the two families that name one off the pace
 * lineup: the full-course caution (`caution.ts`) and the rolling-start
 * formation (`rolling-start.ts`, issue #1167).
 *
 * Both have the same problem. Several calls name the car ahead by reading the
 * lineup live at speak time, and one more reports a CHANGE to it; judged
 * against the previous pace-row reading, the change call repeats what was just
 * said — a follow car that flickers away and back, or a change queued behind a
 * call that then names the new car itself. So the change is judged against
 * what was actually SAID: each naming call records the lineup's follow car
 * when its speak-time gate admits it, and the change call speaks only when the
 * car ahead differs from that record.
 *
 * One memory per build of a family, scoped to an EPISODE — one caution, or one
 * formation — through an id that never repeats, so a car named in an earlier
 * episode, or session, never counts. The two families keep separate memories:
 * their ids come from different counters and must never be compared.
 *
 * The record is committed in a `speakGate` and nowhere else, the one place a
 * claim may be made (#1137): it runs after the script expanded and right
 * before the ops take the bus, while a `where:` record would mark a car named
 * for a call later dropped.
 */
import type { SpeakGate } from "../../dsl.js";

/**
 * What a memory is scoped to: a caution (`CautionEpisode`) or a formation
 * (`RollingStartFormation`), each as its translator reader reports it.
 */
export type NamingEpisode = {
  /** Never repeats within the process. */
  readonly id: number;
  /** The episode's first readable follow car — the lineup its diff does not report as a change. */
  readonly firstFollowCarIdx: number | null;
};

/** The car last named, tagged with the episode it was named in. */
export type LastNamedCar = { episodeId: number; followCarIdx: number };

export type NamedCarMemoryDeps<E extends NamingEpisode> = {
  /** Which episode is running — `null` while none is. */
  getEpisode: () => E | null;
  /** The pace lineup as of the latest tick — only its follow car is read. */
  getPaceLineup: () => { readonly followCarIdx: number | null } | null;
};

export type NamedCarMemory<E extends NamingEpisode> = {
  /** The record itself, for the Telemetry Snapshot (issue #1387). A pure read. */
  read: () => LastNamedCar | null;
  /** A speak-time gate that also records the car the call names — on admission only. */
  naming: (gate: SpeakGate) => SpeakGate;
  /**
   * The change call's judgement, and its record: whether the car ahead NOW is
   * news — an episode is running, the lineup names a car, and it is not the
   * car last named in this episode. Before anything is named the car is judged
   * against `unnamedReference(episode)` instead, and a `null` from that is "no
   * reference yet", which is silence. Answering yes records the car, since the
   * change call names it. Call it last in a gate: it commits.
   */
  admitChange: (unnamedReference: (episode: E) => number | null) => boolean;
};

export function createNamedCarMemory<E extends NamingEpisode>({
  getEpisode,
  getPaceLineup,
}: NamedCarMemoryDeps<E>): NamedCarMemory<E> {
  let lastNamed: LastNamedCar | null = null;

  /** Record the car ahead now as named — nothing while no episode runs or the lineup names no car. */
  const recordNamed = (): void => {
    const episode = getEpisode();
    const followCarIdx = getPaceLineup()?.followCarIdx ?? null;

    if (episode === null || followCarIdx === null) return;

    lastNamed = { episodeId: episode.id, followCarIdx };
  };

  return {
    read: () => lastNamed,
    naming: (gate) => ({
      description: gate.description,
      admit: (ctx) => {
        if (!gate.admit(ctx)) return false;

        recordNamed();

        return true;
      },
    }),
    admitChange: (unnamedReference) => {
      const episode = getEpisode();
      const now = getPaceLineup()?.followCarIdx ?? null;

      if (episode === null || now === null) return false;

      const reference =
        lastNamed !== null && lastNamed.episodeId === episode.id ? lastNamed.followCarIdx : unnamedReference(episode);

      if (reference === null || now === reference) return false;

      // The car this call names — the one just compared, under the episode
      // just read.
      lastNamed = { episodeId: episode.id, followCarIdx: now };

      return true;
    },
  };
}
