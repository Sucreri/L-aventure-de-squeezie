import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeContext, openBiereau, createClient, couriersOnShift, DEMO, type TestContext,
} from './helpers.ts';
import { placeOrder } from '../src/usecases/place-order.ts';
import { handlePaymentWebhook } from '../src/usecases/confirm-payment.ts';
import { startDispatch, respondToOffer, giveUpSearching } from '../src/usecases/dispatch.ts';

let ctx: TestContext;

before(async () => { ctx = makeContext(); await openBiereau(ctx); });
after(async () => { await ctx.close(); });

async function paidOrder() {
  const { userId, addressId } = await createClient(ctx, { floor: 0 });
  const placed = await placeOrder(
    { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
    {
      clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
      lines: [{ productId: DEMO.beer33, quantity: 1 }],
      method: 'bancontact', returnUrl: 'x', webhookUrl: 'y',
    });

  const { body, signature } = ctx.payments.buildWebhook({
    providerRef: placed.providerRef, status: 'authorized',
    amountCents: placed.authorizedCents, scaCompleted: true,
  });
  await handlePaymentWebhook({ db: ctx.db, payments: ctx.payments }, body, signature);

  return placed;
}

const deps = () => ({ db: ctx.db, clock: ctx.clock });

describe('attribution des missions — §15', () => {
  test("sans palettier en créneau, aucune mission n'est créée", async () => {
    // Indépendance : une autre suite a pu laisser des palettiers en créneau.
    await ctx.sql`update shift_bookings set cancelled_at = now() where cancelled_at is null`;

    const placed = await paidOrder();
    const outcome = await startDispatch(deps(), placed.order.id);

    assert.equal(outcome.kind, 'no_courier');

    const missions = await ctx.sql`
      select count(*)::int as n from mission_orders where order_id = ${placed.order.id}`;
    assert.equal(missions[0]!['n'], 0);
  });

  test("l'offre part au meilleur score", async () => {
    await couriersOnShift(ctx, 3);
    const placed = await paidOrder();

    const candidates = await ctx.db.dispatch.candidates(placed.order.id);
    assert.ok(candidates.length >= 2, 'le fixture doit produire plusieurs candidats');

    const outcome = await startDispatch(deps(), placed.order.id);
    assert.equal(outcome.kind, 'offered');
    if (outcome.kind !== 'offered') return;

    assert.equal(outcome.courierId, candidates[0]!.courierId,
      "l'offre doit partir au premier du classement");
  });

  test("l'offre expire après le délai paramétré", async () => {
    await couriersOnShift(ctx, 3);
    const placed = await paidOrder();

    const outcome = await startDispatch(deps(), placed.order.id);
    assert.equal(outcome.kind, 'offered');
    if (outcome.kind !== 'offered') return;

    const timeout = await ctx.db.settings.int('dispatch.offer_timeout_s');
    const expected = new Date(ctx.clock.now().getTime() + timeout * 1000);
    assert.equal(outcome.expiresAt.getTime(), expected.getTime());
  });

  test('un refus passe au candidat suivant, sans aucune sanction', async () => {
    const onShift = await couriersOnShift(ctx, 3);
    const placed = await paidOrder();

    const candidates = await ctx.db.dispatch.candidates(placed.order.id);
    const first = await startDispatch(deps(), placed.order.id);
    assert.equal(first.kind, 'offered');
    if (first.kind !== 'offered') return;

    const second = await respondToOffer(deps(), {
      missionId: first.missionId, offerId: first.offerId, courierId: first.courierId,
      orderId: placed.order.id, accepted: false, declineReason: 'trop loin de mon kot',
    }, candidates);

    assert.equal(second.kind, 'offered');
    if (second.kind !== 'offered') return;
    assert.notEqual(second.courierId, first.courierId);

    // Spec 7.5 : refuser n'entraîne aucune sanction automatique. Le palettier
    // qui a refusé reste candidat pour les missions suivantes.
    const stillCandidate = await ctx.db.dispatch.candidates(placed.order.id);
    assert.ok(stillCandidate.some(c => c.courierId === first.courierId),
      'un palettier qui refuse reste candidat');

    void onShift;
  });

  test('après trois refus, la mission est diffusée à tous les candidats', async () => {
    await couriersOnShift(ctx, 6);
    const placed = await paidOrder();

    const candidates = await ctx.db.dispatch.candidates(placed.order.id);
    assert.ok(candidates.length >= 5, 'il faut assez de candidats pour observer la diffusion');

    let outcome = await startDispatch(deps(), placed.order.id);
    const asked: string[] = [];

    for (let i = 0; i < 3; i++) {
      assert.equal(outcome.kind, 'offered');
      if (outcome.kind !== 'offered') return;
      asked.push(outcome.courierId);

      outcome = await respondToOffer(deps(), {
        missionId: outcome.missionId, offerId: outcome.offerId, courierId: outcome.courierId,
        orderId: placed.order.id, accepted: false,
      }, candidates) as typeof outcome;
    }

    assert.equal(new Set(asked).size, 3, 'chaque offre doit viser un palettier différent');

    assert.equal(outcome.kind, 'broadcast');
    if (outcome.kind !== 'broadcast') return;
    assert.ok(outcome.offers.length >= 1);
  });

  test("accepter assigne la mission et fait passer la commande à COURIER_ASSIGNED", async () => {
    await couriersOnShift(ctx, 3);
    const placed = await paidOrder();

    const candidates = await ctx.db.dispatch.candidates(placed.order.id);
    const offered = await startDispatch(deps(), placed.order.id);
    assert.equal(offered.kind, 'offered');
    if (offered.kind !== 'offered') return;

    const result = await respondToOffer(deps(), {
      missionId: offered.missionId, offerId: offered.offerId, courierId: offered.courierId,
      orderId: placed.order.id, accepted: true,
    }, candidates);

    assert.equal(result.kind, 'assigned');

    const order = await ctx.db.orders.byId(placed.order.id);
    assert.equal(order?.status, 'COURIER_ASSIGNED');

    const [mission] = await ctx.sql`
      select courier_id, status, shift_booking_id from missions where id = ${offered.missionId}`;
    assert.equal(mission!['courier_id'], offered.courierId);
    assert.equal(mission!['status'], 'assigned');
    assert.ok(mission!['shift_booking_id'], 'la mission est rattachée au créneau réservé');
  });

  test("un palettier sans contrat ne peut pas recevoir la mission", async () => {
    await couriersOnShift(ctx, 3);
    const placed = await paidOrder();
    const candidates = await ctx.db.dispatch.candidates(placed.order.id);
    const offered = await startDispatch(deps(), placed.order.id);
    assert.equal(offered.kind, 'offered');
    if (offered.kind !== 'offered') return;

    // On retire le contrat juste avant l'acceptation.
    await ctx.sql`
      update courier_profiles
         set status = 'suspended', contract_signed = false, contract_signed_at = null
       where user_id = ${offered.courierId}`;

    await assert.rejects(() => respondToOffer(deps(), {
      missionId: offered.missionId, offerId: offered.offerId, courierId: offered.courierId,
      orderId: placed.order.id, accepted: true,
    }, candidates, []), (error: unknown) => {
      assert.match(String((error as Error).message), /contrat|dimona/i);
      return true;
    });

    await ctx.sql`
      update courier_profiles
         set contract_signed = true, contract_signed_at = now(), status = 'active'
       where user_id = ${offered.courierId}`;
  });

  test("renoncer place la commande en NO_COURIER_FOUND", async () => {
    const placed = await paidOrder();
    await giveUpSearching(deps(), placed.order.id, 'délai dépassé');

    const order = await ctx.db.orders.byId(placed.order.id);
    assert.equal(order?.status, 'NO_COURIER_FOUND');

    // §12 : le client peut alors annuler sans frais.
    const terms = await ctx.db.orders.cancellationTerms(placed.order.id);
    assert.equal(terms.free, true);
  });
});
