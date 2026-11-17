import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext, openBiereau, createClient, anyCourier, DEMO, type TestContext } from './helpers.ts';
import { placeOrder } from '../src/usecases/place-order.ts';
import { handlePaymentWebhook } from '../src/usecases/confirm-payment.ts';
import { settleTicket } from '../src/usecases/settle-ticket.ts';

let ctx: TestContext;
let courier: string;

before(async () => {
  ctx = makeContext();
  await openBiereau(ctx);
  courier = await anyCourier(ctx);
});
after(async () => { await ctx.close(); });

/** Places a Bancontact order for 1 pallet and debits it, as the real flow does. */
async function paidOrder(quantity = 1) {
  const { userId, addressId } = await createClient(ctx, { floor: 0 });

  const placed = await placeOrder(
    { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
    {
      clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
      lines: [{ productId: DEMO.beer33, quantity }],
      method: 'bancontact',
      returnUrl: 'palette://checkout',
      webhookUrl: 'https://api.invalid/webhooks/payment',
    });

  // Bancontact debits immediately: the provider reports a capture.
  ctx.payments.completeAuthentication(placed.providerRef, true);
  await ctx.payments.capture({
    providerRef: placed.providerRef,
    amountCents: placed.authorizedCents,
    idempotencyKey: `order:${placed.order.id}:bancontact`,
  });

  const { body, signature } = ctx.payments.buildWebhook({
    providerRef: placed.providerRef, status: 'captured',
    amountCents: placed.authorizedCents, scaCompleted: true,
  });
  await handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, signature);

  return placed;
}

const deps = () => ({ db: ctx.db, payments: ctx.payments, receipts: ctx.receipts });

describe('lecture du ticket — §7.6', () => {
  test('une lecture peu fiable impose une saisie manuelle', async () => {
    const placed = await paidOrder();
    ctx.receipts.willRead('photo-floue.jpg', { amountCents: 1499, confidence: 0.4 });

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier, photoPath: 'photo-floue.jpg',
    });

    assert.equal(outcome.kind, 'manual_confirmation_required');
  });

  test('une lecture fiable est utilisée telle quelle', async () => {
    const placed = await paidOrder();
    ctx.receipts.willRead('photo-nette.jpg', { amountCents: 1499, confidence: 0.98 });

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier, photoPath: 'photo-nette.jpg',
    });

    assert.equal(outcome.kind, 'settled');
    if (outcome.kind === 'settled') assert.equal(outcome.itemsActualCents, 1499);
  });

  test('la correction du palettier prime toujours sur la lecture automatique', async () => {
    const placed = await paidOrder();
    // L'OCR est sûr de lui et se trompe : le palettier corrige.
    ctx.receipts.willRead('photo-erronee.jpg', { amountCents: 9999, confidence: 0.99 });

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier,
      photoPath: 'photo-erronee.jpg', amountOverrideCents: 1499,
    });

    assert.equal(outcome.kind, 'settled');
    if (outcome.kind === 'settled') assert.equal(outcome.itemsActualCents, 1499);
  });
});

describe('écart entre estimation et ticket — §10', () => {
  test('ticket inférieur : la différence est remboursée automatiquement', async () => {
    const placed = await paidOrder();
    ctx.receipts.willRead('p1.jpg', { amountCents: 1299, confidence: 0.99 });

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier, photoPath: 'p1.jpg',
    });

    assert.equal(outcome.kind, 'settled');
    if (outcome.kind !== 'settled') return;

    assert.equal(outcome.refundedCents, 200, 'la différence de 2,00 € doit être remboursée');

    const refunds = await ctx.sql`
      select amount_cents, reason from refunds
       where payment_id = (select id from payments where order_id = ${placed.order.id})`;
    assert.equal(refunds.length, 1);
    assert.equal(Number(refunds[0]!['amount_cents']), 200);
    assert.ok(String(refunds[0]!['reason']).length > 0, 'un remboursement porte toujours un motif');
  });

  test('dépassement sous le seuil : absorbé par l\'Opérateur, rien de plus débité', async () => {
    const placed = await paidOrder();
    ctx.receipts.willRead('p2.jpg', { amountCents: 1579, confidence: 0.99 });   // +0,80 €

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier, photoPath: 'p2.jpg',
    });

    assert.equal(outcome.kind, 'settled');
    if (outcome.kind !== 'settled') return;

    assert.equal(outcome.operatorAbsorbsCents, 80);
    assert.equal(outcome.refundedCents, 0);
    assert.equal(outcome.totalChargedCents, placed.order.totalEstimatedCents,
      'le client ne paie pas plus que ce qu\'il a vu');
  });

  test('dépassement au-delà du seuil : accord du client requis, rien n\'est débité', async () => {
    const placed = await paidOrder();
    ctx.receipts.willRead('p3.jpg', { amountCents: 1799, confidence: 0.99 });   // +3,00 €

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier, photoPath: 'p3.jpg',
    });

    assert.equal(outcome.kind, 'client_approval_required');
    if (outcome.kind !== 'client_approval_required') return;

    assert.equal(outcome.operatorAbsorbsCents, 100);
    assert.equal(outcome.extraCaptureCents, 200);

    // Rien n'a été enregistré ni débité : le palettier doit d'abord demander.
    const [order] = await ctx.sql`
      select items_actual_cents from orders where id = ${placed.order.id}`;
    assert.equal(order!['items_actual_cents'], null);

    const receipts = await ctx.sql`select count(*)::int as n from receipts
                                    where order_id = ${placed.order.id}`;
    assert.equal(receipts[0]!['n'], 0);
  });

  test('le client n\'est jamais débité de plus que le ticket', async () => {
    for (const actual of [1000, 1400, 1499, 1550, 1599]) {
      const placed = await paidOrder();
      ctx.receipts.willRead(`sweep-${actual}.jpg`, { amountCents: actual, confidence: 0.99 });

      const outcome = await settleTicket(deps(), {
        orderId: placed.order.id, courierId: courier, photoPath: `sweep-${actual}.jpg`,
      });

      if (outcome.kind !== 'settled') continue;

      const paidForItems = outcome.totalChargedCents
        - placed.order.deliveryFeeCents - placed.order.serviceFeeCents - placed.order.tipCents;

      assert.ok(paidForItems <= actual,
        `articles payés ${paidForItems} pour un ticket de ${actual}`);
    }
  });

  test('les frais annoncés ne bougent jamais après le devis', async () => {
    const placed = await paidOrder();
    ctx.receipts.willRead('p4.jpg', { amountCents: 1299, confidence: 0.99 });

    const outcome = await settleTicket(deps(), {
      orderId: placed.order.id, courierId: courier, photoPath: 'p4.jpg',
    });

    assert.equal(outcome.kind, 'settled');
    if (outcome.kind !== 'settled') return;

    const fees = outcome.totalChargedCents - outcome.itemsActualCents;
    assert.equal(fees, placed.order.deliveryFeeCents + placed.order.serviceFeeCents);
  });
});
