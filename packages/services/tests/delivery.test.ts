import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeContext, openBiereau, createClient, couriersOnShift, DEMO, type TestContext,
} from './helpers.ts';
import { placeOrder } from '../src/usecases/place-order.ts';
import { handlePaymentWebhook } from '../src/usecases/confirm-payment.ts';
import { startDispatch, respondToOffer } from '../src/usecases/dispatch.ts';
import { recordAgeCheck, completeHandover, failDelivery } from '../src/usecases/complete-delivery.ts';

let ctx: TestContext;

before(async () => { ctx = makeContext(); await openBiereau(ctx); await couriersOnShift(ctx, 6); });
after(async () => { await ctx.close(); });

const PIN = '5173';

/** Walks an alcoholic order all the way to ARRIVED, with a known PIN. */
async function orderAtTheDoor(productId: string = DEMO.beer33) {
  const { userId, addressId } = await createClient(ctx, { floor: 0 });

  const placed = await placeOrder(
    { db: ctx.db, payments: ctx.payments, clock: ctx.clock, generatePin: () => PIN },
    {
      clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
      lines: [{ productId, quantity: 1 }],
      method: 'bancontact', returnUrl: 'x', webhookUrl: 'y',
    });

  const { body, signature } = ctx.payments.buildWebhook({
    providerRef: placed.providerRef, status: 'authorized',
    amountCents: placed.authorizedCents, scaCompleted: true,
  });
  await handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, signature);

  const candidates = await ctx.db.dispatch.candidates(placed.order.id);
  const offered = await startDispatch({ db: ctx.db, clock: ctx.clock }, placed.order.id);
  if (offered.kind !== 'offered') throw new Error('aucun palettier candidat dans le fixture');

  await respondToOffer({ db: ctx.db, clock: ctx.clock }, {
    missionId: offered.missionId, offerId: offered.offerId, courierId: offered.courierId,
    orderId: placed.order.id, accepted: true,
  }, candidates);

  const courierId = offered.courierId;
  const actor = { id: courierId, role: 'courier' };

  for (const status of ['AT_STORE', 'PURCHASED', 'EN_ROUTE', 'ARRIVED'] as const) {
    await ctx.db.orders.setStatus(placed.order.id, status, actor);
  }

  return { orderId: placed.order.id, courierId };
}

const deps = () => ({ db: ctx.db });

describe("contrôle d'âge à la remise — §13", () => {
  test('un contrôle validé demande ensuite le PIN', async () => {
    const { orderId, courierId } = await orderAtTheDoor();

    const outcome = await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: true,
    });

    assert.equal(outcome.passed, true);
    assert.equal(outcome.next, 'ask_pin');
  });

  test("un refus pour ivresse manifeste bascule la commande en DELIVERY_FAILED", async () => {
    const { orderId, courierId } = await orderAtTheDoor();

    const outcome = await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: false,
      refusalReason: 'visibly_intoxicated',
    });

    assert.equal(outcome.passed, false);
    assert.equal(outcome.next, 'delivery_failed');
    assert.match(outcome.message, /aucune sanction/i);

    const order = await ctx.db.orders.byId(orderId);
    assert.equal(order?.status, 'DELIVERY_FAILED');
  });

  test("un contrôle sans vérification de la pièce ne peut pas être validé", async () => {
    const { orderId, courierId } = await orderAtTheDoor();

    const outcome = await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: false, personAppearsSober: true,
    });

    assert.equal(outcome.passed, false);
  });

  test("aucune donnée d'identité n'est enregistrée", async () => {
    const { orderId, courierId } = await orderAtTheDoor();
    await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: true,
    });

    const [row] = await ctx.sql`
      select to_jsonb(a) as payload from age_checks a where a.order_id = ${orderId}`;
    const payload = JSON.stringify(row!['payload']);

    assert.ok(!/birth|naissance|annee|année|photo|image/i.test(payload),
      `le contrôle ne doit contenir aucune donnée d'identité : ${payload}`);
  });
});

describe('remise avec PIN — §13.4', () => {
  test("sans contrôle d'âge, l'alcool ne peut pas être remis", async () => {
    const { orderId, courierId } = await orderAtTheDoor();

    const outcome = await completeHandover(deps(), { orderId, courierId, pin: PIN });

    assert.equal(outcome.delivered, false);
    assert.match(outcome.message, /contrôle d'âge|PIN/i);

    const order = await ctx.db.orders.byId(orderId);
    assert.equal(order?.status, 'ARRIVED');
  });

  test('un mauvais PIN ne livre pas', async () => {
    const { orderId, courierId } = await orderAtTheDoor();
    await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: true,
    });

    const outcome = await completeHandover(deps(), { orderId, courierId, pin: '0000' });

    assert.equal(outcome.delivered, false);
    const order = await ctx.db.orders.byId(orderId);
    assert.equal(order?.status, 'ARRIVED');
  });

  test("contrôle d'âge puis PIN correct : la commande est livrée", async () => {
    const { orderId, courierId } = await orderAtTheDoor();
    await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: true,
    });

    const outcome = await completeHandover(deps(), { orderId, courierId, pin: PIN });

    assert.equal(outcome.delivered, true);
    const order = await ctx.db.orders.byId(orderId);
    assert.equal(order?.status, 'DELIVERED');
  });

  test('une commande sans alcool exige quand même le PIN', async () => {
    const { orderId, courierId } = await orderAtTheDoor(DEMO.water);

    const refused = await completeHandover(deps(), { orderId, courierId, pin: '1111' });
    assert.equal(refused.delivered, false);

    const accepted = await completeHandover(deps(), { orderId, courierId, pin: PIN });
    assert.equal(accepted.delivered, true);
  });
});

describe('échec de remise — §12', () => {
  test('les articles sont gardés au local avec la durée paramétrée', async () => {
    const { orderId, courierId } = await orderAtTheDoor();
    await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: false,
      refusalReason: 'recipient_absent',
    });

    const outcome = await failDelivery(deps(), {
      orderId, courierId, reason: 'client absent', holdAtHub: true,
    });

    assert.equal(outcome.status, 'HELD_AT_HUB');
    const hours = await ctx.db.settings.int('orders.hub_hold_hours');
    assert.match(outcome.message, new RegExp(`${hours}\\s*h`));

    const order = await ctx.db.orders.byId(orderId);
    assert.equal(order?.status, 'HELD_AT_HUB');
  });

  test('chaque transition est journalisée avec son acteur', async () => {
    const { orderId, courierId } = await orderAtTheDoor();
    await recordAgeCheck(deps(), {
      orderId, courierId, documentChecked: true, personAppearsSober: true,
    });
    await completeHandover(deps(), { orderId, courierId, pin: PIN });

    const events = await ctx.sql`
      select from_status, to_status, actor_id, actor_role
        from audit.order_events where order_id = ${orderId} order by occurred_at`;

    assert.ok(events.length >= 6, 'le parcours complet doit être journalisé');
    const delivered = events.find(e => e['to_status'] === 'DELIVERED');
    assert.ok(delivered, 'la livraison doit apparaître dans le journal');
    assert.equal(delivered!['actor_role'], 'courier');
  });
});
