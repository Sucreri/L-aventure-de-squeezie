/**
 * Handling a payment webhook (spec 4.5).
 *
 * Two properties matter more than anything else here:
 *   1. the signature is verified before the payload is trusted;
 *   2. processing is idempotent — providers retry, and a retry must not move
 *      the order forward twice.
 */

import type { Database } from '../ports/database.ts';
import type { PaymentProvider } from '../ports/payment.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import { startDispatch } from './dispatch.ts';
import { refusalAware } from '../errors.ts';

export interface ConfirmPaymentDeps {
  readonly db: Database;
  readonly payments: PaymentProvider;
  readonly clock?: Clock;
}

export interface WebhookOutcome {
  readonly handled: boolean;
  readonly reason: string;
  readonly orderId?: string;
  readonly newStatus?: string;
}

export async function handlePaymentWebhook(
  deps: ConfirmPaymentDeps,
  rawBody: string,
  signature: string,
): Promise<WebhookOutcome> {
  // Throws WebhookSignatureError on a forged payload; the caller answers 400.
  const event = deps.payments.parseWebhook(rawBody, signature);

  const payment = await deps.db.payments.byProviderRef(event.providerRef);
  if (!payment) {
    // An unknown reference is not an error we should retry forever: it usually
    // means a payment from another environment. Acknowledge and move on.
    return { handled: false, reason: `référence de paiement inconnue : ${event.providerRef}` };
  }

  await deps.db.payments.applyEvent({
    providerRef: event.providerRef,
    status: event.status,
    amountCents: event.amountCents,
    scaCompleted: event.scaCompleted,
    ...(event.failureReason === undefined ? {} : { failureReason: event.failureReason }),
  });

  const order = await deps.db.orders.byId(payment.orderId);
  if (!order) {
    return { handled: false, reason: 'commande introuvable', orderId: payment.orderId };
  }

  // Idempotence: the order only advances from the state the event implies.
  // A replayed "authorized" webhook on an order already PAID changes nothing.
  if (event.status === 'authorized' || event.status === 'captured') {
    if (order.status !== 'CREATED') {
      return {
        handled: true,
        reason: `aucun changement : la commande est déjà en ${order.status}`,
        orderId: order.id,
        newStatus: order.status,
      };
    }

    await refusalAware(() => deps.db.orders.setStatus(order.id, 'PAID',
      { id: null, role: 'system', reason: `paiement ${event.status} (${event.providerRef})` }));

    // Spec 6.8: the search for a courier starts as soon as the payment is in.
    await refusalAware(() => deps.db.orders.setStatus(order.id, 'SEARCHING_COURIER',
      { id: null, role: 'system', reason: 'recherche d\'un palettier' }));

    // And it starts HERE, not on a timer somewhere: a paid order that sits
    // waiting for a scheduler is an order nobody is looking for.
    //
    // Finding nobody is not a failure of the payment. The order stays in
    // SEARCHING_COURIER, a scheduler retries, and after
    // cancellation.no_courier_timeout_s the client may cancel free of charge
    // (spec 12). So a dispatch failure is reported, never thrown.
    let dispatched: string | undefined;
    try {
      const outcome = await startDispatch(
        { db: deps.db, clock: deps.clock ?? systemClock }, order.id);
      dispatched = outcome.kind;
    } catch (error) {
      dispatched = `erreur d'attribution : ${(error as Error).message}`;
    }

    return {
      handled: true,
      reason: `paiement confirmé (attribution : ${dispatched})`,
      orderId: order.id,
      newStatus: 'SEARCHING_COURIER',
    };
  }

  if (event.status === 'failed' || event.status === 'cancelled') {
    if (order.status !== 'CREATED') {
      return {
        handled: true,
        reason: `aucun changement : la commande est en ${order.status}`,
        orderId: order.id,
        newStatus: order.status,
      };
    }

    await refusalAware(() => deps.db.orders.setStatus(order.id, 'CANCELLED_BY_OPS',
      { id: null, role: 'system', reason: event.failureReason ?? 'paiement échoué' }));

    return { handled: true, reason: 'paiement échoué', orderId: order.id, newStatus: 'CANCELLED_BY_OPS' };
  }

  return { handled: true, reason: `statut ${event.status} enregistré`, orderId: order.id };
}
