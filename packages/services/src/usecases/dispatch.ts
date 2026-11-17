/**
 * Mission allocation (spec 15).
 *
 *   The offer goes to the best score for dispatch.offer_timeout_s, then to the
 *   next. After dispatch.broadcast_after_declines refusals it is offered to
 *   every candidate. An admin can always reassign by hand.
 *
 * Design note. This is a time-driven process, so it is NOT written as a loop
 * that sleeps. It is three operations a scheduler calls — start, respond,
 * sweep — with the clock injected. That makes every deadline testable without
 * waiting, and it survives a crash: the state lives in mission_offers, not in
 * a running process.
 *
 * Note also what is NOT here: declining carries no penalty of any kind
 * (spec 7.5, 15). There is deliberately no code path that records a strike,
 * lowers a score or hides future offers from someone who said no.
 */

import type { Database, CandidateRow } from '../ports/database.ts';
import type { Clock } from '../ports/clock.ts';
import { refusalAware } from '../errors.ts';

export interface DispatchDeps {
  readonly db: Database;
  readonly clock: Clock;
}

export type DispatchOutcome =
  | { readonly kind: 'offered'; readonly missionId: string; readonly offerId: string;
      readonly courierId: string; readonly score: number; readonly expiresAt: Date }
  | { readonly kind: 'broadcast'; readonly missionId: string;
      readonly offers: readonly { offerId: string; courierId: string }[] }
  | { readonly kind: 'no_courier'; readonly reason: string };

/**
 * Starts looking for a courier for an order that has been paid.
 * Returns the first offer, or no_courier when nobody is eligible.
 */
export async function startDispatch(
  deps: DispatchDeps,
  orderId: string,
): Promise<DispatchOutcome> {
  const { db } = deps;

  const order = await db.orders.byId(orderId);
  if (!order) throw new Error(`commande inconnue : ${orderId}`);

  const candidates = await db.dispatch.candidates(orderId);
  if (candidates.length === 0) {
    return { kind: 'no_courier', reason: 'aucun palettier éligible sur ce créneau' };
  }

  const mission = await db.dispatch.createMission({ storeId: order.storeId });
  await db.dispatch.attachOrder(mission.id, orderId);

  return offerToNext(deps, mission.id, candidates);
}

/**
 * Offers the mission to the best candidate who has not already been asked.
 * Once the refusal count reaches the threshold, offers to everyone left.
 *
 * Who has already been asked is read from mission_offers rather than tracked
 * by the caller. That keeps the process crash-safe — a restarted scheduler
 * picks up exactly where it left off — and removes a class of bug where a
 * caller's bookkeeping drifts from reality and the same courier is offered
 * the same mission twice.
 */
export async function offerToNext(
  deps: DispatchDeps,
  missionId: string,
  candidates: readonly CandidateRow[],
): Promise<DispatchOutcome> {
  const { db, clock } = deps;

  const alreadyAsked = await db.dispatch.offeredCouriers(missionId);
  const remaining = candidates.filter(c => !alreadyAsked.includes(c.courierId));
  if (remaining.length === 0) {
    return { kind: 'no_courier', reason: 'tous les palettiers candidats ont été sollicités' };
  }

  const timeoutSeconds = await db.settings.int('dispatch.offer_timeout_s');
  const broadcastAfter = await db.settings.int('dispatch.broadcast_after_declines');

  // Spec 15: after three refusals, stop going one by one and offer to all.
  if (alreadyAsked.length >= broadcastAfter) {
    const offers = [];
    for (const candidate of remaining) {
      const offer = await db.dispatch.offer(missionId, candidate.courierId, candidate.score);
      offers.push({ offerId: offer.id, courierId: candidate.courierId });
    }
    return { kind: 'broadcast', missionId, offers };
  }

  // candidates arrive already ordered by score, then fewest missions (spec 15)
  const next = remaining[0]!;
  const offer = await db.dispatch.offer(missionId, next.courierId, next.score);

  return {
    kind: 'offered',
    missionId,
    offerId: offer.id,
    courierId: next.courierId,
    score: next.score,
    expiresAt: new Date(clock.now().getTime() + timeoutSeconds * 1000),
  };
}

export interface OfferResponse {
  readonly missionId: string;
  readonly offerId: string;
  readonly courierId: string;
  readonly orderId: string;
  readonly accepted: boolean;
  /** Optional and consequence-free (spec 7.5). */
  readonly declineReason?: string;
}

export type ResponseOutcome =
  | { readonly kind: 'assigned'; readonly missionId: string; readonly courierId: string }
  | DispatchOutcome;

export async function respondToOffer(
  deps: DispatchDeps,
  response: OfferResponse,
  candidates: readonly CandidateRow[],
): Promise<ResponseOutcome> {
  const { db } = deps;

  if (!response.accepted) {
    await db.dispatch.respondToOffer(response.offerId, 'declined', response.declineReason);
    return offerToNext(deps, response.missionId, candidates);
  }

  await db.dispatch.respondToOffer(response.offerId, 'accepted');

  const booking = await db.dispatch.activeShiftBooking(response.courierId);

  // The assignment guard refuses a courier without a signed contract and a
  // confirmed Dimona, so this can legitimately throw (spec 4.3).
  await refusalAware(() => db.dispatch.assign(response.missionId, response.courierId, booking));

  await refusalAware(() => db.orders.setStatus(response.orderId, 'COURIER_ASSIGNED', {
    id: response.courierId, role: 'courier', reason: 'offre acceptée',
  }));

  return { kind: 'assigned', missionId: response.missionId, courierId: response.courierId };
}

/**
 * Marks an order as having found nobody (spec 12).
 * The client may then cancel free of charge, with a full automatic refund.
 */
export async function giveUpSearching(
  deps: DispatchDeps,
  orderId: string,
  reason: string,
): Promise<void> {
  await refusalAware(() => deps.db.orders.setStatus(orderId, 'NO_COURIER_FOUND', {
    id: null, role: 'system', reason,
  }));
}
