/**
 * Mission allocation scoring (spec 15).
 *
 *   score = 0.6 x speed to store + 0.2 x capacity fit + 0.2 x grouping
 *
 * Each criterion is normalised to [0, 1]. Ties go to the courier who has done
 * the fewest missions in the shift.
 *
 * Spec 15 and EU directive 2024/2831 require this to be explainable to the
 * courier. `app.dispatch_explanation()` generates that text from the same
 * parameters, so the explanation cannot drift from the behaviour.
 */

export interface DispatchSettings {
  readonly max_distance_to_store_m: number;
  readonly weight_speed: number;
  readonly weight_capacity: number;
  readonly weight_grouping: number;
}

export interface Candidate {
  readonly courierId: string;
  readonly distanceToStoreM: number;
  readonly remainingUnits: number;
  readonly canGroup: boolean;
  readonly missionsInShift: number;
}

export interface ScoredCandidate extends Candidate {
  readonly score: number;
}

export function scoreCandidate(
  c: Candidate,
  neededUnits: number,
  s: DispatchSettings,
): number {
  const speed = Math.max(0, 1 - c.distanceToStoreM / s.max_distance_to_store_m);
  const capacity = neededUnits === 0 ? 1 : Math.min(1, c.remainingUnits / neededUnits);
  const grouping = c.canGroup ? 1 : 0;

  return s.weight_speed * speed + s.weight_capacity * capacity + s.weight_grouping * grouping;
}

/**
 * Eligible candidates, best first.
 *
 * A courier is eligible only with enough remaining capacity and within the
 * maximum distance. Those are hard filters, not score penalties: a courier who
 * physically cannot carry the order must never be offered it.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  neededUnits: number,
  s: DispatchSettings,
): ScoredCandidate[] {
  return candidates
    .filter(c => c.distanceToStoreM <= s.max_distance_to_store_m && c.remainingUnits >= neededUnits)
    .map(c => ({ ...c, score: scoreCandidate(c, neededUnits, s) }))
    .sort((a, b) =>
      b.score - a.score ||                      // best score first
      a.missionsInShift - b.missionsInShift ||  // tie-break (spec 15)
      a.courierId.localeCompare(b.courierId));  // stable, deterministic
}
