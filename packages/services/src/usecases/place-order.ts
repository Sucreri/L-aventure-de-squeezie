/**
 * Placing an order and starting its payment (spec 6.5 to 6.8).
 *
 * This use case orchestrates; it decides nothing. The price comes from SQL,
 * the age gate is applied by a trigger on every line, the zone check by the
 * creation guard. If any of those refuse, nothing is created and no payment
 * is started — which is why the two steps are ordered this way and not the
 * reverse.
 */

import type { Database, PlaceOrderInput, OrderRow } from '../ports/database.ts';
import type { PaymentProvider, PaymentMethod } from '../ports/payment.ts';
import type { Clock } from '../ports/clock.ts';
import { refusalAware } from '../errors.ts';
import { randomInt, randomUUID } from 'node:crypto';

export interface PlaceOrderCommand extends PlaceOrderInput {
  readonly method: PaymentMethod;
  readonly returnUrl: string;
  readonly webhookUrl: string;
}

export interface PlacedOrder {
  readonly order: OrderRow;
  readonly checkoutUrl: string;
  readonly providerRef: string;
  /**
   * What the client is asked to authorise. On a card this is the estimate plus
   * the pre-authorisation margin (spec 10); on Bancontact it is the estimate,
   * debited immediately.
   */
  readonly authorizedCents: number;
  readonly cancellationTerms: {
    free: boolean; itemsDueCents: number; feesDueCents: number; explanation: string;
  };
}

export interface PlaceOrderDeps {
  readonly db: Database;
  readonly payments: PaymentProvider;
  readonly clock: Clock;
  /** Overridable so tests can assert on a known PIN. */
  readonly generatePin?: () => string;
}

export async function placeOrder(
  deps: PlaceOrderDeps,
  command: PlaceOrderCommand,
): Promise<PlacedOrder> {
  const { db, payments, clock } = deps;

  if (command.lines.length === 0) {
    throw new Error('Le panier est vide.');
  }

  // 1. Create and price the order. Every guard runs here: verified account,
  //    accepted terms, open zone, age on each line.
  const order = await refusalAware(() => db.orders.place(command));

  // 2. Delivery PIN, generated now and stored hashed. The clear value is
  //    returned to the client once and never written down (spec 13.4, H-13).
  const pin = (deps.generatePin ?? defaultPin)();
  await db.orders.setPin(order.id, pin);

  // 3. The amount to authorise depends on the payment method (spec 10).
  const margin = await db.settings.num('pricing.card_preauth_margin');
  const authorizedCents = command.method === 'bancontact'
    ? order.totalEstimatedCents
    : Math.round(order.totalEstimatedCents * (1 + margin));

  // 4. Cancellation terms, computed server-side and shown BEFORE payment
  //    (spec 4.6). Discovering them afterwards would be a dark pattern.
  const cancellationTerms = await db.orders.cancellationTerms(order.id);

  // 5. Start the payment. The idempotency key is derived from the order, so a
  //    retried request never creates a second payment (spec 4.5).
  const idempotencyKey = `order:${order.id}:initial`;

  const created = await payments.createPayment({
    orderId: order.id,
    orderReference: order.reference,
    amountCents: authorizedCents,
    method: command.method,
    description: `Commande ${order.reference}`,
    idempotencyKey,
    returnUrl: command.returnUrl,
    webhookUrl: command.webhookUrl,
  });

  await db.payments.insert({
    orderId: order.id,
    provider: payments.name,
    providerRef: created.providerRef,
    method: command.method,
    amountAuthorizedCents: authorizedCents,
    idempotencyKey,
  });

  void clock;

  return {
    order,
    checkoutUrl: created.checkoutUrl,
    providerRef: created.providerRef,
    authorizedCents,
    cancellationTerms,
  };
}

/** Four digits, drawn from a cryptographic source, leading zeros preserved. */
function defaultPin(): string {
  return randomInt(0, 10_000).toString().padStart(4, '0');
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
