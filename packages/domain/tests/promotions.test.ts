import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPromotion, validatePromotion, ForbiddenPromotionError,
  ALLOWED_CONDITION_KEYS, type Promotion,
} from '../src/promotions.ts';

const feeOnly = (conditions: Record<string, unknown> = {}): Promotion => ({
  name: 'Frais réduits', target: 'delivery_fee', discountType: 'percent',
  discountPercent: 0.5, conditions,
});

describe('moteur de promotions — critère 20.4', () => {
  test('une règle liée à une quantité de palettes est refusée', () => {
    assert.throws(() => validatePromotion(feeOnly({ min_pallets: 2 })),
      ForbiddenPromotionError);
  });

  test('une règle ciblant des produits est refusée', () => {
    assert.throws(() => validatePromotion(feeOnly({ product_ids: ['abc'] })),
      ForbiddenPromotionError);
  });

  test('une règle dont la valeur mentionne de l\'alcool est refusée', () => {
    assert.throws(
      () => validatePromotion(feeOnly({ max_per_user: 'une bière offerte' })),
      ForbiddenPromotionError);
  });

  test('une règle mentionnant « palette » est refusée même dans une clé autorisée', () => {
    assert.throws(
      () => validatePromotion(feeOnly({ modes: ['palette_express'] })),
      ForbiddenPromotionError);
  });

  test('toutes les clés autorisées sont acceptées', () => {
    assert.doesNotThrow(() => validatePromotion(feeOnly({
      min_order_cents: 1500,
      modes: ['express'],
      zone_ids: ['zone-1'],
      first_order_only: true,
      valid_weekdays: [4, 5],
      max_per_user: 1,
    })));
  });

  test('la liste blanche est bien celle du cahier des charges', () => {
    assert.deepEqual([...ALLOWED_CONDITION_KEYS].sort(), [
      'first_order_only', 'max_per_user', 'min_order_cents',
      'modes', 'valid_weekdays', 'zone_ids',
    ]);
  });
});

describe('application d\'une promotion', () => {
  const fees = { deliveryCents: 650, serviceCents: 49 };

  test('une remise en pourcentage ne touche que la cible', () => {
    const out = applyPromotion(fees, feeOnly({ first_order_only: true }));
    assert.equal(out.deliveryCents, 325);
    assert.equal(out.serviceCents, 49);
  });

  test('une remise fixe en centimes est plafonnée au montant des frais', () => {
    const out = applyPromotion(fees, {
      name: 'Frais offerts', target: 'delivery_fee', discountType: 'fixed',
      discountFixedCents: 10_000, conditions: {},
    });
    assert.equal(out.deliveryCents, 0, 'les frais ne peuvent pas devenir négatifs');
    assert.equal(out.serviceCents, 49);
  });

  test('une remise sur les frais de service laisse la livraison intacte', () => {
    const out = applyPromotion(fees, {
      name: 'Service offert', target: 'service_fee', discountType: 'fixed',
      discountFixedCents: 49, conditions: {},
    });
    assert.equal(out.deliveryCents, 650);
    assert.equal(out.serviceCents, 0);
  });

  test('100 % de réduction sur la livraison donne 0', () => {
    const out = applyPromotion(fees, {
      name: 'Première commande', target: 'delivery_fee', discountType: 'percent',
      discountPercent: 1, conditions: { first_order_only: true },
    });
    assert.equal(out.deliveryCents, 0);
  });

  test('un pourcentage hors bornes est refusé', () => {
    assert.throws(() => applyPromotion(fees, {
      name: 'Trop', target: 'delivery_fee', discountType: 'percent',
      discountPercent: 1.5, conditions: {},
    }), ForbiddenPromotionError);
  });

  test('le total des articles n\'est pas un argument de la fonction', () => {
    // Structural guarantee: applyPromotion cannot discount a product because
    // it never receives the item total. This test documents that on purpose.
    assert.equal(applyPromotion.length, 2);
  });
});
