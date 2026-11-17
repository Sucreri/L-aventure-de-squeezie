import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { makeContext, openBiereau, createClient, DEMO, type TestContext } from './helpers.ts';
import { placeOrder } from '../src/usecases/place-order.ts';
import { RuleRefusedError } from '../src/errors.ts';

let ctx: TestContext;

before(async () => {
  ctx = makeContext();
  await openBiereau(ctx);
});

after(async () => { await ctx.close(); });

const checkout = {
  method: 'bancontact' as const,
  returnUrl: 'palette://checkout',
  webhookUrl: 'https://api.invalid/webhooks/payment',
};

describe('placer une commande', () => {
  test('tarifie la commande avec la formule du §9', async () => {
    const { userId, addressId } = await createClient(ctx, { floor: 3, hasLift: false });

    const result = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.beer33, quantity: 2 }],
        ...checkout,
      });

    // 2 palettes, 3e étage sans ascenseur, c = 1,0 → 6,50 € (exemple du §9)
    assert.equal(result.order.deliveryFeeCents, 650);
    assert.equal(result.order.serviceFeeCents, 49);
    assert.equal(result.order.itemsEstimatedCents, 2 * 1499);
    assert.equal(result.order.totalEstimatedCents, 2 * 1499 + 650 + 49);
  });

  test('le total enregistré est la somme exacte de ses composantes', async () => {
    const { userId, addressId } = await createClient(ctx);

    const { order } = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.water, quantity: 1 }, { productId: DEMO.chips, quantity: 3 }],
        ...checkout,
      });

    assert.equal(
      order.totalEstimatedCents,
      order.itemsEstimatedCents + order.deliveryFeeCents + order.serviceFeeCents + order.tipCents);
  });

  test('affiche les conditions d\'annulation AVANT le paiement (§4.6)', async () => {
    const { userId, addressId } = await createClient(ctx);

    const result = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.water, quantity: 1 }],
        ...checkout,
      });

    assert.equal(result.cancellationTerms.free, true);
    assert.match(result.cancellationTerms.explanation, /gratuite/i);
  });

  test('en carte, autorise l\'estimation majorée de la marge du §10', async () => {
    const { userId, addressId } = await createClient(ctx, { floor: 0 });

    const result = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.beer33, quantity: 1 }],
        ...checkout, method: 'card',
      });

    const expected = Math.round(result.order.totalEstimatedCents * 1.10);
    assert.equal(result.authorizedCents, expected);
  });

  test('en Bancontact, débite exactement l\'estimation', async () => {
    const { userId, addressId } = await createClient(ctx, { floor: 0 });

    const result = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.beer33, quantity: 1 }],
        ...checkout,
      });

    assert.equal(result.authorizedCents, result.order.totalEstimatedCents);
  });

  test('enregistre un PIN haché, jamais en clair', async () => {
    const { userId, addressId } = await createClient(ctx);

    const result = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock, generatePin: () => '0427' },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.water, quantity: 1 }],
        ...checkout,
      });

    const [row] = await ctx.sql`select pin_hash from orders where id = ${result.order.id}`;
    assert.ok(row!['pin_hash'], 'un PIN doit avoir été posé');
    assert.ok(!String(row!['pin_hash']).includes('0427'), 'le PIN ne doit jamais apparaître en clair');
  });

  test('fige la version des CGV acceptée (§4.6)', async () => {
    const { userId, addressId } = await createClient(ctx);

    const result = await placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.water, quantity: 1 }],
        ...checkout,
      });

    const [row] = await ctx.sql`
      select sales_terms_document_id from orders where id = ${result.order.id}`;
    assert.ok(row!['sales_terms_document_id'], 'la version des CGV doit être figée sur la commande');
  });
});

describe('refus par les règles serveur', () => {
  test('un compte non vérifié ne peut pas commander', async () => {
    const { userId, addressId } = await createClient(ctx, { verified: false });

    await assert.rejects(
      () => placeOrder(
        { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
        {
          clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
          lines: [{ productId: DEMO.water, quantity: 1 }],
          ...checkout,
        }),
      (error: unknown) => {
        assert.ok(error instanceof RuleRefusedError);
        assert.equal(error.kind, 'account_not_verified');
        return true;
      });
  });

  test('aucun paiement n\'est créé quand la commande est refusée', async () => {
    const { userId, addressId } = await createClient(ctx, { verified: false });
    const before = await ctx.sql`select count(*)::int as n from payments`;

    await assert.rejects(() => placeOrder(
      { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
      {
        clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
        lines: [{ productId: DEMO.water, quantity: 1 }],
        ...checkout,
      }));

    const after = await ctx.sql`select count(*)::int as n from payments`;
    assert.equal(after[0]!['n'], before[0]!['n'],
      'la commande est refusée AVANT toute création de paiement');
  });

  test('un client 16-17 ne peut pas commander un produit 18+', async () => {
    const { userId, addressId } = await createClient(ctx, { bracket: 'b16_17' });
    const [spirit] = await ctx.sql`select id from products where sku = 'SPIRIT-DEMO'`;

    await assert.rejects(
      () => placeOrder(
        { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
        {
          clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
          lines: [{ productId: spirit!['id'] as string, quantity: 1 }],
          ...checkout,
        }),
      () => true);
  });

  test("un article indisponible dans ce magasin fait refuser TOUTE la commande", async () => {
    // Régression : une version antérieure de l'adaptateur retirait
    // silencieusement la ligne du panier, et le client payait une commande
    // amputée sans en être informé.
    const { userId, addressId } = await createClient(ctx);
    const [spirit] = await ctx.sql`select id from products where sku = 'SPIRIT-DEMO'`;

    await assert.rejects(
      () => placeOrder(
        { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
        {
          clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
          lines: [
            { productId: DEMO.water, quantity: 1 },
            { productId: spirit!['id'] as string, quantity: 1 },
          ],
          ...checkout,
        }),
      /ne sont pas disponibles dans ce magasin/i);

    const orders = await ctx.sql`select id from orders where client_id = ${userId}`;
    assert.equal(orders.length, 0, 'aucune commande ne doit subsister');
  });

  test('un panier vide est refusé', async () => {
    const { userId, addressId } = await createClient(ctx);

    await assert.rejects(
      () => placeOrder(
        { db: ctx.db, payments: ctx.payments, clock: ctx.clock },
        {
          clientId: userId, addressId, storeId: DEMO.storeCentre, mode: 'express',
          lines: [], ...checkout,
        }),
      /panier est vide/i);
  });
});
