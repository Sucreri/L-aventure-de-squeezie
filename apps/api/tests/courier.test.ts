import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  startApi, registerVerifiedClient, registerReadyCourier, openShiftNow,
  DEMO, BIEREAU_PIN, type ApiHarness,
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

describe('candidature et prérequis — §7.1 à §7.3', () => {
  test('un compte neuf sait quoi faire', async () => {
    const { token } = await registerVerifiedClient(api);
    const { status, body } = await api.request('/courier/me', { token });

    assert.equal(status, 200);
    assert.equal(body.onboarding.applied, false);
    assert.equal(body.onboarding.canWork, false);
    assert.match(body.onboarding.nextStep, /candidature/i);
  });

  test('le quiz est servi sans son corrigé (§7.2)', async () => {
    const { token } = await registerVerifiedClient(api);
    await api.request('/courier/apply', {
      method: 'POST', token,
      body: JSON.stringify({ transport: 'foot_trolley', enrolmentProofRef: 'ATT-X' }),
    });

    const { body } = await api.request('/courier/training', { token });

    assert.ok(body.questions.length >= 8);
    const serialised = JSON.stringify(body.questions);
    assert.ok(!/correct_index|correctIndex|explanation/i.test(serialised),
      `le corrigé ne doit pas sortir : ${serialised.slice(0, 200)}`);
  });

  test('un quiz raté explique les erreurs sans valider la formation', async () => {
    const { token } = await registerVerifiedClient(api);
    await api.request('/courier/apply', {
      method: 'POST', token,
      body: JSON.stringify({ transport: 'foot_trolley', enrolmentProofRef: 'ATT-Y' }),
    });

    const key = await api.sql`
      select id, correct_index, jsonb_array_length(choices) as n
        from training_questions where active`;
    const wrong = Object.fromEntries(key.map(r =>
      [r['id'] as string, (Number(r['correct_index']) + 1) % Number(r['n'])]));

    const { body } = await api.request('/courier/training', {
      method: 'POST', token, body: JSON.stringify({ answers: wrong }),
    });

    assert.equal(body.passed, false);
    assert.ok(body.wrong.length > 0);
    assert.ok(body.wrong[0].explanation.length > 0,
      'une erreur doit être expliquée, pas seulement comptée');
  });

  test('le contrat reprend les paramètres et se présente comme un gabarit', async () => {
    const { token } = await registerReadyCourier(api);
    const { body } = await api.request('/courier/contract', { token });

    assert.equal(body.awaitingLegalValidation, true);
    assert.ok(body.employer.legalName.length > 0);
    assert.ok(body.employer.vatNumber.length > 0);
    assert.equal(body.workingTime.annualQuotaHours, 650);
    assert.ok(body.hourlyWageCents > 0);
    assert.ok(body.employerObligations.insurance.length > 0);
  });

  test('un palettier prêt peut travailler', async () => {
    const { token } = await registerReadyCourier(api);
    const { body } = await api.request('/courier/me', { token });

    assert.equal(body.onboarding.canWork, true);
    assert.match(body.onboarding.nextStep, /créneau/i);
  });
});

describe('créneaux — §7.4', () => {
  test('réserver puis annuler un créneau', async () => {
    const { token } = await registerReadyCourier(api);
    const shift = await openShiftNow(api);

    const booked = await api.request(`/courier/shifts/${shift}/book`, { method: 'POST', token });
    assert.equal(booked.status, 201);

    const mine = await api.request('/courier/bookings', { token });
    assert.equal(mine.body.bookings.filter((b: any) => b.cancelledAt === null).length, 1);

    const cancelled = await api.request(`/courier/shifts/${shift}/cancel`, { method: 'POST', token });
    assert.equal(cancelled.status, 200);
  });

  test('un palettier sans formation est refusé, avec le motif', async () => {
    const { token } = await registerVerifiedClient(api);
    await api.request('/courier/apply', {
      method: 'POST', token,
      body: JSON.stringify({ transport: 'foot_trolley', enrolmentProofRef: 'ATT-Z' }),
    });
    const shift = await openShiftNow(api);

    const { status, body } = await api.request(`/courier/shifts/${shift}/book`, {
      method: 'POST', token,
    });

    assert.equal(status, 400);
    assert.equal(body.details.kind, 'training_required');
    assert.match(body.message, /formation obligatoire/i);
  });
});

describe('position — §4.3 et §7.9', () => {
  test('aucune position en dehors d\'un créneau réservé', async () => {
    const { token } = await registerReadyCourier(api);

    const { status, body } = await api.request('/courier/position', {
      method: 'POST', token, body: JSON.stringify({ lat: 50.6695, lon: 4.6145 }),
    });

    assert.equal(status, 403);
    assert.match(body.message, /créneau/i);
  });

  test('position acceptée pendant un créneau réservé', async () => {
    const { userId, token } = await registerReadyCourier(api);
    const shift = await openShiftNow(api);
    await api.request(`/courier/shifts/${shift}/book`, { method: 'POST', token });
    await api.sql`insert into consents (user_id, consent_type, granted)
                  values (${userId}, 'geolocation', true)`;

    const { status } = await api.request('/courier/position', {
      method: 'POST', token, body: JSON.stringify({ lat: 50.6695, lon: 4.6145 }),
    });

    assert.equal(status, 201);
  });
});

describe('mission complète — §7.5 à §7.7', () => {
  /** A paid order waiting for a courier, in Biéreau. */
  async function paidOrder(): Promise<{ orderId: string; clientToken: string }> {
    const { token } = await registerVerifiedClient(api);
    const address = await api.request('/addresses', {
      method: 'POST', token,
      body: JSON.stringify({
        street: 'Rue des Blancs Chevaux', number: '21', floor: 2,
        isDefault: true, ...BIEREAU_PIN,
      }),
    });

    const placed = await api.request('/orders', {
      method: 'POST', token,
      body: JSON.stringify({
        addressId: address.body.addressId, storeId: DEMO.storeCentre,
        mode: 'express', method: 'bancontact',
        lines: [{ productId: DEMO.beer33, quantity: 1 }],
      }),
    });

    await api.request('/dev/simulate-payment', {
      method: 'POST', token, body: JSON.stringify({ orderId: placed.body.orderId }),
    });

    return { orderId: placed.body.orderId, clientToken: token };
  }

  /**
   * A courier on shift with a position, so dispatch can reach them.
   *
   * Other bookings are cancelled first. Dispatch offers the mission to the
   * single best candidate, so leaving couriers from earlier tests on shift
   * would make which one receives it a matter of scoring luck.
   */
  async function courierOnShift() {
    await api.sql`update shift_bookings set cancelled_at = now() where cancelled_at is null`;

    const { userId, token } = await registerReadyCourier(api);
    const shift = await openShiftNow(api);
    await api.request(`/courier/shifts/${shift}/book`, { method: 'POST', token });
    await api.sql`insert into consents (user_id, consent_type, granted)
                  values (${userId}, 'geolocation', true)`;
    await api.request('/courier/position', {
      method: 'POST', token, body: JSON.stringify({ lat: 50.6695, lon: 4.6145 }),
    });
    return { userId, token };
  }

  test('le paiement déclenche la recherche et une offre parvient au palettier', async () => {
    const courier = await courierOnShift();
    await paidOrder();

    const { body } = await api.request('/courier/offers', { token: courier.token });

    assert.ok(body.offers.length >= 1, 'une offre doit avoir été envoyée');
    const offer = body.offers[0];
    assert.ok(offer.storeName.length > 0);
    assert.ok(offer.itemCount >= 1);
    assert.ok(offer.totalWeightKg > 0, 'le poids est annoncé au palettier (§7.5)');
    assert.equal(offer.floor, 2);
  });

  test('refuser une offre est sans conséquence (§7.5)', async () => {
    const courier = await courierOnShift();
    await paidOrder();

    const offers = await api.request('/courier/offers', { token: courier.token });
    const offer = offers.body.offers[0];

    const { status, body } = await api.request(`/courier/offers/${offer.offerId}/decline`, {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ reason: 'trop loin de mon kot' }),
    });

    assert.equal(status, 200);
    assert.match(body.message, /aucune sanction/i);

    // Toujours candidat pour la suite.
    const after = await api.request('/courier/me', { token: courier.token });
    assert.equal(after.body.onboarding.canWork, true);
  });

  test('parcours complet : accepter, magasin, ticket, route, remise', async () => {
    const courier = await courierOnShift();
    const order = await paidOrder();

    const offers = await api.request('/courier/offers', { token: courier.token });
    const offer = offers.body.offers[0];

    const accepted = await api.request(`/courier/offers/${offer.offerId}/accept`, {
      method: 'POST', token: courier.token,
    });
    assert.equal(accepted.status, 200);

    // La mission guidée dit où en est le palettier.
    let mission = await api.request('/courier/mission', { token: courier.token });
    assert.equal(mission.body.step, 'go_to_store');
    assert.match(mission.body.instruction, /Rends-toi au/i);
    assert.match(mission.body.instruction, new RegExp(mission.body.mission.storeName
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(mission.body.mission.spendCardCeilingCents > 0,
      'le plafond de la carte de dépense est annoncé');

    const missionId = mission.body.mission.missionId;

    await api.request('/courier/mission/at-store', {
      method: 'POST', token: courier.token, body: JSON.stringify({ missionId }),
    });

    mission = await api.request('/courier/mission', { token: courier.token });
    assert.equal(mission.body.step, 'shop');

    // Ticket : lecture peu fiable, le palettier corrige à la main (§7.6).
    api.receipts.willRead('ticket.jpg', { amountCents: 9999, confidence: 0.3 });

    const unreliable = await api.request('/courier/mission/receipt', {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ missionId, orderId: order.orderId, photoPath: 'ticket.jpg' }),
    });
    assert.equal(unreliable.body.kind, 'manual_confirmation_required');

    const settled = await api.request('/courier/mission/receipt', {
      method: 'POST', token: courier.token,
      body: JSON.stringify({
        missionId, orderId: order.orderId, photoPath: 'ticket.jpg',
        amountOverrideCents: 1499,
      }),
    });
    assert.equal(settled.body.kind, 'settled');
    assert.equal(settled.body.step, 'travel');

    await api.request('/courier/mission/depart', {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ missionId, orderId: order.orderId }),
    });
    await api.request('/courier/mission/arrive', {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ orderId: order.orderId }),
    });

    // Sans contrôle d'âge, l'alcool ne peut pas être remis (§13.4).
    const [row] = await api.sql`select pin_hash from orders where id = ${order.orderId}`;
    assert.ok(row!['pin_hash'], 'la commande porte un PIN');

    const tooEarly = await api.request(`/courier/orders/${order.orderId}/deliver`, {
      method: 'POST', token: courier.token, body: JSON.stringify({ pin: '0000' }),
    });
    assert.equal(tooEarly.body.delivered, false);

    const ageCheck = await api.request(`/courier/orders/${order.orderId}/age-check`, {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ documentChecked: true, personAppearsSober: true }),
    });
    assert.equal(ageCheck.body.passed, true);
    assert.equal(ageCheck.body.next, 'ask_pin');

    // La requête de contrôle d'âge ne transporte aucune donnée d'identité.
    const [check] = await api.sql`
      select to_jsonb(a) as payload from age_checks a where a.order_id = ${order.orderId}`;
    assert.ok(!/birth|naissance|annee/i.test(JSON.stringify(check!['payload'])));
  });

  test("un refus pour ivresse manifeste bascule en échec de remise (§13.3)", async () => {
    const courier = await courierOnShift();
    const order = await paidOrder();

    const offers = await api.request('/courier/offers', { token: courier.token });
    await api.request(`/courier/offers/${offers.body.offers[0].offerId}/accept`, {
      method: 'POST', token: courier.token,
    });

    // Le contrôle d'âge se fait à la porte : on y conduit la commande d'abord.
    const mission = await api.request('/courier/mission', { token: courier.token });
    const missionId = mission.body.mission.missionId;

    await api.request('/courier/mission/at-store', {
      method: 'POST', token: courier.token, body: JSON.stringify({ missionId }),
    });
    api.receipts.willRead('t2.jpg', { amountCents: 1499, confidence: 0.99 });
    await api.request('/courier/mission/receipt', {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ missionId, orderId: order.orderId, photoPath: 't2.jpg' }),
    });
    await api.request('/courier/mission/depart', {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ missionId, orderId: order.orderId }),
    });
    await api.request('/courier/mission/arrive', {
      method: 'POST', token: courier.token, body: JSON.stringify({ orderId: order.orderId }),
    });

    const tooSoon = await api.request(`/courier/orders/${order.orderId}/age-check`, {
      method: 'POST', token: courier.token,
      body: JSON.stringify({ documentChecked: true, personAppearsSober: true }),
    });
    assert.equal(tooSoon.body.passed, true, 'à ce stade le contrôle est bien possible');

    const refused = await api.request(`/courier/orders/${order.orderId}/age-check`, {
      method: 'POST', token: courier.token,
      body: JSON.stringify({
        documentChecked: true, personAppearsSober: false,
        refusalReason: 'visibly_intoxicated',
      }),
    });

    assert.equal(refused.body.passed, false);
    assert.match(refused.body.message, /aucune sanction/i);

    const [o] = await api.sql`select status from orders where id = ${order.orderId}`;
    assert.equal(o!['status'], 'DELIVERY_FAILED');
  });

  test("un palettier ne voit pas la mission d'un autre", async () => {
    const working = await courierOnShift();
    const idle = await registerReadyCourier(api);
    await paidOrder();

    const offers = await api.request('/courier/offers', { token: working.token });
    await api.request(`/courier/offers/${offers.body.offers[0].offerId}/accept`, {
      method: 'POST', token: working.token,
    });

    const mine = await api.request('/courier/mission', { token: working.token });
    assert.ok(mine.body.mission);

    const other = await api.request('/courier/mission', { token: idle.token });
    assert.equal(other.body.mission, null);
  });
});

describe('mode hors ligne — §18', () => {
  test("rejouer une action ne l'exécute pas deux fois", async () => {
    const { token } = await registerReadyCourier(api);
    const shift = await openShiftNow(api);
    const actionId = randomUUID();

    const first = await api.request(`/courier/shifts/${shift}/book`, {
      method: 'POST', token, body: JSON.stringify({ actionId }),
    });
    const replay = await api.request(`/courier/shifts/${shift}/book`, {
      method: 'POST', token, body: JSON.stringify({ actionId }),
    });

    assert.equal(first.status, 201);
    assert.deepEqual(replay.body, first.body,
      'un rejeu doit renvoyer exactement le résultat initial');

    const [{ n }] = await api.sql`
      select count(*)::int as n from courier_actions where action_id = ${actionId}` as any;
    assert.equal(n, 1);
  });
});

describe('gains et quota — §7.8', () => {
  test("l'estimation est présentée comme telle, avec le quota", async () => {
    const { token } = await registerReadyCourier(api);
    const { status, body } = await api.request('/courier/earnings?days=30', { token });

    assert.equal(status, 200);
    assert.match(body.disclaimer, /estimation/i);
    assert.match(body.disclaimer, /secrétariat social/i);
    assert.match(body.disclaimer, /Student@work/);
    assert.equal(body.quota.quotaHours, 650);
    assert.ok(body.estimate.hourlyWageCents > 0);
  });

  test("le bouton d'aide donne un contact direct (§7.9)", async () => {
    const { token } = await registerReadyCourier(api);
    const { status, body } = await api.request('/courier/help', {
      method: 'POST', token, body: JSON.stringify({ description: 'test' }),
    });

    assert.equal(status, 200);
    assert.ok(body.contact.length > 0);
    assert.match(body.message, /pause/i);
  });
});
