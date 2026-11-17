import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext, openBiereau, createClient, DEMO, type TestContext } from './helpers.ts';
import { placeOrder } from '../src/usecases/place-order.ts';
import { handlePaymentWebhook } from '../src/usecases/confirm-payment.ts';
import { WebhookSignatureError } from '../src/ports/payment.ts';

let ctx: TestContext;

before(async () => { ctx = makeContext(); await openBiereau(ctx); });
after(async () => { await ctx.close(); });

const checkout = {
  method: 'bancontact' as const,
  returnUrl: 'palette://checkout',
  webhookUrl: 'https://api.invalid/webhooks/payment',
};

async function anOrder() {
  const { userId, addressId } = await createClient(ctx);
  return placeOrder(
    { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
    {
      clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
      lines: [{ productId: DEMO.beer33, quantity: 1 }],
      ...checkout,
    });
}

describe('webhook de paiement — §4.5', () => {
  test('une signature invalide est rejetée', async () => {
    const placed = await anOrder();
    const { body } = ctx.payments.buildWebhook({
      providerRef: placed.providerRef, status: 'authorized',
      amountCents: placed.authorizedCents, scaCompleted: true,
    });

    await assert.rejects(
      () => handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, 'signature-bidon'),
      WebhookSignatureError);
  });

  test('un paiement authentifié fait avancer la commande', async () => {
    const placed = await anOrder();
    const { body, signature } = ctx.payments.buildWebhook({
      providerRef: placed.providerRef, status: 'authorized',
      amountCents: placed.authorizedCents, scaCompleted: true,
    });

    const outcome = await handlePaymentWebhook(
      { db: ctx.db, payments: ctx.payments }, body, signature);

    assert.equal(outcome.handled, true);
    assert.equal(outcome.newStatus, 'SEARCHING_COURIER');

    const order = await ctx.db.orders.byId(placed.order.id);
    assert.equal(order?.status, 'SEARCHING_COURIER');
  });

  test('rejouer le même webhook ne refait pas avancer la commande', async () => {
    const placed = await anOrder();
    const { body, signature } = ctx.payments.buildWebhook({
      providerRef: placed.providerRef, status: 'authorized',
      amountCents: placed.authorizedCents, scaCompleted: true,
    });

    await handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, signature);
    const second = await handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, signature);
    const third = await handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, signature);

    assert.equal(second.handled, true);
    assert.match(second.reason, /aucun changement/i);
    assert.match(third.reason, /aucun changement/i);

    const events = await ctx.sql`
      select count(*)::int as n from audit.order_events
       where order_id = ${placed.order.id} and to_status = 'PAID'`;
    assert.equal(events[0]!['n'], 1, 'la commande ne doit être passée à PAID qu\'une seule fois');
  });

  test('un paiement échoué annule la commande', async () => {
    const placed = await anOrder();
    const { body, signature } = ctx.payments.buildWebhook({
      providerRef: placed.providerRef, status: 'failed',
      amountCents: placed.authorizedCents, scaCompleted: false,
      failureReason: 'fonds insuffisants',
    });

    const outcome = await handlePaymentWebhook(
      { db: ctx.db, payments: ctx.payments }, body, signature);

    assert.equal(outcome.newStatus, 'CANCELLED_BY_OPS');
  });

  test('une référence inconnue est acquittée sans effet', async () => {
    const { body, signature } = ctx.payments.buildWebhook({
      providerRef: 'mock_inexistant', status: 'authorized',
      amountCents: 1000, scaCompleted: true,
    });

    const outcome = await handlePaymentWebhook(
      { db: ctx.db, payments: ctx.payments }, body, signature);

    assert.equal(outcome.handled, false);
    assert.match(outcome.reason, /inconnue/i);
  });

  test("le prestataire refuse une capture sans authentification forte", async () => {
    const placed = await anOrder();

    await assert.rejects(
      () => ctx.payments.capture({
        providerRef: placed.providerRef,
        amountCents: placed.order.totalEstimatedCents,
        idempotencyKey: 'test-capture',
      }),
      /authentification forte/i);
  });

  test('créer deux fois le même paiement ne crée qu\'une transaction', async () => {
    const first = await ctx.payments.createPayment({
      orderId: 'o1', orderReference: 'REF1', amountCents: 1000, method: 'bancontact',
      description: 'test', idempotencyKey: 'idem-partage',
      returnUrl: 'x', webhookUrl: 'y',
    });
    const second = await ctx.payments.createPayment({
      orderId: 'o1', orderReference: 'REF1', amountCents: 1000, method: 'bancontact',
      description: 'test', idempotencyKey: 'idem-partage',
      returnUrl: 'x', webhookUrl: 'y',
    });

    assert.equal(first.providerRef, second.providerRef);
  });
});
