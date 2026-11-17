import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startApi, registerVerifiedClient, DEMO, BIEREAU_PIN, type ApiHarness,
} from './harness.ts';

let api: ApiHarness;

before(async () => {
  api = await startApi();
  // Ouvre Biéreau pour que les commandes soient possibles.
  await api.sql`update zones set client_threshold = 1, courier_threshold = 1
                 where id = ${DEMO.zoneBiereau}`;
  const [zone] = await api.sql`select status from zones where id = ${DEMO.zoneBiereau}`;
  if (zone!['status'] !== 'open') {
    await api.sql`select app.open_zone(${DEMO.zoneBiereau}, ${DEMO.admin})`;
  }
});

after(async () => { await api.close(); });

async function addressFor(token: string, floor = 3, hasLift = false) {
  const created = await api.request('/addresses', {
    method: 'POST', token,
    body: JSON.stringify({
      label: 'Kot', street: 'Rue des Blancs Chevaux', number: '12',
      floor, hasLift, isDefault: true, ...BIEREAU_PIN,
    }),
  });
  return created.body.addressId as string;
}

describe('informations publiques', () => {
  test('les paramètres publics viennent de la base, pas du client', async () => {
    const { status, body } = await api.request('/public/settings');

    assert.equal(status, 200);
    assert.equal(body.payButtonLabel, 'Commander et payer');
    assert.match(body.healthWarning, /modération/i);
    assert.equal(body.minAgeBeerWine, 16);
    assert.ok(body.operator.legalName.length > 0);
  });

  test('la jauge publique des quartiers est accessible sans compte', async () => {
    const { status, body } = await api.request('/public/zones');
    assert.equal(status, 200);
    assert.equal(body.zones.length, 3);
    assert.ok(Object.hasOwn(body.zones[0], 'clients_waiting'));
  });

  test('les CGV sont consultables avant toute commande (§4.6)', async () => {
    const { status, body } = await api.request('/public/legal/sales_terms');
    assert.equal(status, 200);
    assert.ok(body.version);
  });
});

describe('inscription et vérification d\'âge', () => {
  test('un compte est créé inactif et devient actif après vérification', async () => {
    const registered = await api.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        firstName: 'Avant', lastName: 'Vérif',
        email: `inactive-${Date.now()}@example.invalid`,
      }),
    });

    assert.equal(registered.status, 201);
    assert.equal(registered.body.nextStep, 'verify_age');

    const [before] = await api.sql`select status from users where id = ${registered.body.userId}`;
    assert.equal(before!['status'], 'pending');

    api.ageVerification.willReturn(registered.body.userId, 'b18_plus');
    const started = await api.request('/auth/verify-age/start', {
      method: 'POST', token: registered.body.token,
    });
    const completed = await api.request('/auth/verify-age/complete', {
      method: 'POST', token: registered.body.token,
      body: JSON.stringify({ sessionId: started.body.sessionId }),
    });

    assert.equal(completed.body.verified, true);
    const [after] = await api.sql`select status, age_verified from users
                                   where id = ${registered.body.userId}`;
    assert.equal(after!['status'], 'active');
    assert.equal(after!['age_verified'], true);
  });

  test('un moins de 16 ans est refusé (§6.1)', async () => {
    const registered = await api.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        firstName: 'Trop', lastName: 'Jeune',
        email: `minor-${Date.now()}@example.invalid`,
      }),
    });

    api.ageVerification.willReturn(registered.body.userId, 'under_16');
    const started = await api.request('/auth/verify-age/start', {
      method: 'POST', token: registered.body.token,
    });
    const completed = await api.request('/auth/verify-age/complete', {
      method: 'POST', token: registered.body.token,
      body: JSON.stringify({ sessionId: started.body.sessionId }),
    });

    assert.equal(completed.status, 403);
    assert.equal(completed.body.verified, false);

    const [user] = await api.sql`select status from users where id = ${registered.body.userId}`;
    assert.notEqual(user!['status'], 'active');
  });

  test('aucune date de naissance ne transite ni n\'est stockée', async () => {
    const { userId, token } = await registerVerifiedClient(api);
    const me = await api.request('/me', { token });

    const payload = JSON.stringify(me.body);
    assert.ok(!/birth|naissance|date_of_birth/i.test(payload), payload);
    assert.equal(me.body.user.age_bracket, 'b18_plus');

    void userId;
  });

  test('une requête sans jeton est refusée', async () => {
    const { status } = await api.request('/me');
    assert.equal(status, 401);
  });

  test('un jeton falsifié est refusé', async () => {
    const { status } = await api.request('/me', { token: 'bidon.signature' });
    assert.equal(status, 401);
  });
});

describe('adresses et zones', () => {
  test('une adresse hors zone est refusée avec un message clair (§6.3)', async () => {
    const { token } = await registerVerifiedClient(api);

    const { status, body } = await api.request('/addresses', {
      method: 'POST', token,
      body: JSON.stringify({
        street: 'Rue de la Loi', number: '16', floor: 0,
        lat: 50.8450, lon: 4.3670,     // Bruxelles
      }),
    });

    assert.equal(status, 400);
    assert.match(body.message, /zone de service/i);
  });

  test("l'épingle sur la carte est obligatoire", async () => {
    const { token } = await registerVerifiedClient(api);

    const { status, body } = await api.request('/addresses', {
      method: 'POST', token,
      body: JSON.stringify({ street: 'Rue des Blancs Chevaux', number: '1', floor: 1 }),
    });

    assert.equal(status, 400);
    assert.match(body.message, /épingle/i);
  });

  test('une adresse valide résout son quartier', async () => {
    const { token } = await registerVerifiedClient(api);

    const { status, body } = await api.request('/addresses', {
      method: 'POST', token,
      body: JSON.stringify({
        street: 'Rue des Blancs Chevaux', number: '7', floor: 2, ...BIEREAU_PIN,
      }),
    });

    assert.equal(status, 201);
    assert.equal(body.zone.slug, 'biereau');
    assert.equal(body.serviceAvailable, true);
  });
});

describe('catalogue filtré par âge — §5', () => {
  test('un client majeur voit la bière', async () => {
    const { token } = await registerVerifiedClient(api);
    const { body } = await api.request(`/catalogue?storeId=${DEMO.storeCentre}`, { token });

    const beer = body.products.find((p: any) => p.product_id === DEMO.beer33);
    assert.ok(beer, 'la bière doit être visible pour un client majeur');
    assert.match(beer.alcohol_notice, /Contient de l'alcool/);
  });

  test('les produits sans alcool apparaissent en premier', async () => {
    const { token } = await registerVerifiedClient(api);
    const { body } = await api.request(`/catalogue?storeId=${DEMO.storeCentre}`, { token });

    const firstAlcohol = body.products.findIndex((p: any) => p.contains_alcohol);
    const lastWithout = body.products.map((p: any) => p.contains_alcohol).lastIndexOf(false);

    assert.ok(firstAlcohol > lastWithout,
      'aucun produit alcoolisé ne doit précéder un produit sans alcool');
  });

  test('aucun produit 18+ n\'apparaît, pour personne', async () => {
    const { token } = await registerVerifiedClient(api);
    const { body } = await api.request(`/catalogue?storeId=${DEMO.storeCentre}`, { token });

    assert.equal(body.products.filter((p: any) => p.age_minimum === 18).length, 0);
  });
});
