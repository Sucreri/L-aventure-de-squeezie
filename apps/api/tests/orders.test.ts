import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startApi, registerVerifiedClient, DEMO, BIEREAU_PIN, type ApiHarness,
} from './harness.ts';

let api: ApiHarness;

before(async () => {
  api = await startApi();
  await api.sql`update zones set client_threshold = 1, courier_threshold = 1
                 where id = ${DEMO.zoneBiereau}`;
  const [zone] = await api.sql`select status from zones where id = ${DEMO.zoneBiereau}`;
  if (zone!['status'] !== 'open') {
    await api.sql`select app.open_zone(${DEMO.zoneBiereau}, ${DEMO.admin})`;
  }
});

after(async () => { await api.close(); });

async function clientWithAddress(floor = 3, hasLift = false) {
  const { userId, token } = await registerVerifiedClient(api);
  const created = await api.request('/addresses', {
    method: 'POST', token,
    body: JSON.stringify({
      label: 'Kot', street: 'Rue des Blancs Chevaux', number: '12',
      floor, hasLift, isDefault: true, ...BIEREAU_PIN,
    }),
  });
  return { userId, token, addressId: created.body.addressId as string };
}

async function placeOrderVia(token: string, addressId: string, quantity = 2) {
  return api.request('/orders', {
    method: 'POST', token,
    body: JSON.stringify({
      addressId, storeId: DEMO.storeCentre, mode: 'express', method: 'bancontact',
      lines: [{ productId: DEMO.beer33, quantity }],
    }),
  });
}

describe('passer commande', () => {
  test("le total correspond à l'exemple du §9 et aux composantes affichées", async () => {
    const { token, addressId } = await clientWithAddress(3, false);
    const { status, body } = await placeOrderVia(token, addressId, 2);

    assert.equal(status, 201);
    assert.equal(body.amounts.deliveryCents, 650);
    assert.equal(body.amounts.serviceCents, 49);
    assert.equal(
      body.amounts.totalCents,
      body.amounts.itemsCents + body.amounts.deliveryCents
        + body.amounts.serviceCents + body.amounts.tipCents);
  });

  test("les conditions d'annulation sont renvoyées AVANT le paiement (§4.6)", async () => {
    const { token, addressId } = await clientWithAddress();
    const { body } = await placeOrderVia(token, addressId);

    assert.equal(body.cancellationTerms.free, true);
    assert.ok(body.cancellationTerms.explanation.length > 0);
    assert.ok(body.checkoutUrl.startsWith('https://'));
  });

  test('un compte sans consentements ne peut pas commander', async () => {
    const { token } = await registerVerifiedClient(api, { skipConsents: true });
    const created = await api.request('/addresses', {
      method: 'POST', token,
      body: JSON.stringify({
        street: 'Rue des Blancs Chevaux', number: '3', floor: 0, ...BIEREAU_PIN,
      }),
    });

    const { status, body } = await placeOrderVia(token, created.body.addressId);

    assert.equal(status, 400);
    assert.equal(body.details?.kind, 'account_not_verified');
  });

  test('un panier vide est refusé', async () => {
    const { token, addressId } = await clientWithAddress();
    const { status } = await api.request('/orders', {
      method: 'POST', token,
      body: JSON.stringify({
        addressId, storeId: DEMO.storeCentre, mode: 'express', lines: [],
      }),
    });
    assert.equal(status, 400);
  });

  test('le paiement fait avancer la commande, et le rejeu ne change rien', async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);

    const [payment] = await api.sql`
      select provider_ref, amount_authorized_cents from payments
       where order_id = ${placed.body.orderId}`;

    const webhook = api.payments.buildWebhook({
      providerRef: payment!['provider_ref'] as string,
      status: 'authorized',
      amountCents: Number(payment!['amount_authorized_cents']),
      scaCompleted: true,
    });

    const first = await api.request('/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify({ payload: webhook.body, signature: webhook.signature }),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.newStatus, 'SEARCHING_COURIER');

    const second = await api.request('/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify({ payload: webhook.body, signature: webhook.signature }),
    });
    assert.match(second.body.reason, /aucun changement/i);

    const [{ n }] = await api.sql`
      select count(*)::int as n from audit.order_events
       where order_id = ${placed.body.orderId} and to_status = 'PAID'` as any;
    assert.equal(n, 1);
  });

  test('un webhook mal signé est rejeté', async () => {
    const { status } = await api.request('/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify({ payload: '{"providerRef":"x"}', signature: 'faux' }),
    });
    assert.equal(status, 400);
  });
});

describe('suivi de commande', () => {
  test('la chronologie montre les statuts et leurs horodatages', async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);

    await api.request(`/orders/${placed.body.orderId}/cancel`, {
      method: 'POST', token, body: JSON.stringify({ reason: 'test' }),
    });

    const { body } = await api.request(`/orders/${placed.body.orderId}`, { token });

    assert.ok(Array.isArray(body.timeline));
    assert.ok(body.timeline.length >= 1);
    assert.ok(body.timeline[0].status);
    assert.ok(body.timeline[0].occurred_at);
  });

  test("la chronologie n'expose ni acteur ni motif interne", async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);
    await api.request(`/orders/${placed.body.orderId}/cancel`, {
      method: 'POST', token, body: JSON.stringify({ reason: 'motif interne confidentiel' }),
    });

    const { body } = await api.request(`/orders/${placed.body.orderId}`, { token });
    const serialised = JSON.stringify(body.timeline);

    assert.ok(!/actor|motif interne|reason/i.test(serialised),
      `la chronologie ne doit contenir que statut et horodatage : ${serialised}`);
  });

  test('le journal d\'audit lui-même reste inaccessible au client', async () => {
    const { userId } = await clientWithAddress();

    await assert.rejects(
      () => api.sql.begin(async tx => {
        await tx`select set_config('app.current_user_id', ${userId}, true)`;
        await tx`set local role authenticated`;
        return tx`select * from audit.order_events limit 1`;
      }),
      /permission denied/i);
  });
});

describe('cloisonnement entre clients — Row Level Security', () => {
  test("un client ne voit pas la commande d'un autre", async () => {
    const alice = await clientWithAddress();
    const bob = await clientWithAddress();

    const placed = await placeOrderVia(alice.token, alice.addressId);
    assert.equal(placed.status, 201);

    const asAlice = await api.request(`/orders/${placed.body.orderId}`, { token: alice.token });
    assert.equal(asAlice.status, 200);

    const asBob = await api.request(`/orders/${placed.body.orderId}`, { token: bob.token });
    assert.equal(asBob.status, 404,
      "la commande d'autrui ne doit pas simplement être refusée : elle doit être invisible");
  });

  test("la liste des commandes ne contient que les siennes", async () => {
    const alice = await clientWithAddress();
    const bob = await clientWithAddress();

    await placeOrderVia(alice.token, alice.addressId);
    const bobOrders = await api.request('/orders', { token: bob.token });

    assert.equal(bobOrders.body.orders.length, 0);
  });

  test("un client ne peut pas annuler la commande d'un autre", async () => {
    const alice = await clientWithAddress();
    const bob = await clientWithAddress();

    const placed = await placeOrderVia(alice.token, alice.addressId);
    const attempt = await api.request(`/orders/${placed.body.orderId}/cancel`, {
      method: 'POST', token: bob.token, body: JSON.stringify({ reason: 'tentative' }),
    });

    assert.notEqual(attempt.status, 200);

    const stillThere = await api.request(`/orders/${placed.body.orderId}`, { token: alice.token });
    assert.notEqual(stillThere.body.order.status, 'CANCELLED_BY_CLIENT');
  });

  test("un client ne voit pas les adresses d'un autre", async () => {
    const alice = await clientWithAddress();
    const bob = await clientWithAddress();

    const bobAddresses = await api.request('/addresses', { token: bob.token });
    const ids = bobAddresses.body.addresses.map((a: any) => a.id);

    assert.ok(!ids.includes(alice.addressId));
    assert.equal(bobAddresses.body.addresses.length, 1);
  });

  test("un client ne peut pas noter la commande d'un autre", async () => {
    const alice = await clientWithAddress();
    const bob = await clientWithAddress();

    const placed = await placeOrderVia(alice.token, alice.addressId);
    const attempt = await api.request(`/orders/${placed.body.orderId}/rate`, {
      method: 'POST', token: bob.token, body: JSON.stringify({ score: 1 }),
    });

    assert.notEqual(attempt.status, 201);
  });
});

describe('annulation et notation', () => {
  test('annuler avant achat est gratuit (§12)', async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);

    const cancelled = await api.request(`/orders/${placed.body.orderId}/cancel`, {
      method: 'POST', token, body: JSON.stringify({ reason: 'changement de plan' }),
    });

    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.terms.free, true);

    const after = await api.request(`/orders/${placed.body.orderId}`, { token });
    assert.equal(after.body.order.status, 'CANCELLED_BY_CLIENT');
  });

  test('une commande non livrée ne peut pas être notée (§16)', async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);

    const { status, body } = await api.request(`/orders/${placed.body.orderId}/rate`, {
      method: 'POST', token, body: JSON.stringify({ score: 5 }),
    });

    assert.equal(status, 400);
    assert.match(body.message, /livrée/i);
  });

  test('une note hors de 1 à 5 est refusée', async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);

    const { status } = await api.request(`/orders/${placed.body.orderId}/rate`, {
      method: 'POST', token, body: JSON.stringify({ score: 9 }),
    });
    assert.equal(status, 400);
  });
});

describe('droits RGPD en libre-service — §6.13', () => {
  test("l'export contient les données du compte et aucune date de naissance", async () => {
    const { token, addressId } = await clientWithAddress();
    await placeOrderVia(token, addressId);

    const { status, body } = await api.request('/me/export', { token });

    assert.equal(status, 200);
    assert.ok(body.account);
    assert.ok(Array.isArray(body.orders));
    assert.ok(!/birth|naissance/i.test(JSON.stringify(body)));
  });

  test('la suppression est immédiate sans commande en cours', async () => {
    const { userId, token } = await registerVerifiedClient(api);

    const { status, body } = await api.request('/me', { method: 'DELETE', token });

    assert.equal(status, 200);
    assert.equal(body.status, 'completed');

    const [user] = await api.sql`select status, email from users where id = ${userId}`;
    assert.equal(user!['status'], 'deleted');
    assert.equal(user!['email'], null);
  });

  test('la suppression est différée, jamais ignorée, avec une commande en cours (§19)', async () => {
    const { token, addressId } = await clientWithAddress();
    const placed = await placeOrderVia(token, addressId);

    const [payment] = await api.sql`
      select provider_ref, amount_authorized_cents from payments
       where order_id = ${placed.body.orderId}`;
    const webhook = api.payments.buildWebhook({
      providerRef: payment!['provider_ref'] as string, status: 'authorized',
      amountCents: Number(payment!['amount_authorized_cents']), scaCompleted: true,
    });
    await api.request('/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify({ payload: webhook.body, signature: webhook.signature }),
    });

    const { body } = await api.request('/me', { method: 'DELETE', token });

    assert.equal(body.status, 'deferred');
    assert.match(body.message, /en cours/i);
  });
});
