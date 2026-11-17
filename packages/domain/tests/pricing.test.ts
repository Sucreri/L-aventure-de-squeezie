import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  computeDeliveryFee, computeOrderTotal, floorFee, SurgeOutOfRangeError,
  type PricingSettings, type DeliveryMode,
} from '../src/pricing.ts';
import { roundCents, formatEur } from '../src/money.ts';

const vectors = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/pricing-vectors.json', import.meta.url)), 'utf8',
)) as {
  settings: PricingSettings;
  cases: Array<{
    name: string; pallets: number; floor: number; hasLift: boolean;
    surge: number; mode: DeliveryMode;
    expectedDeliveryCents: number; expectedServiceCents: number;
  }>;
  invalidCases: Array<{
    name: string; pallets: number; floor: number; hasLift: boolean;
    surge: number; mode: DeliveryMode;
  }>;
};

const S = vectors.settings;

describe('tarification — vecteurs partagés avec SQL', () => {
  for (const c of vectors.cases) {
    test(`${c.name}`, () => {
      const fee = computeDeliveryFee(
        { pallets: c.pallets, floor: c.floor, hasLift: c.hasLift, surge: c.surge, mode: c.mode },
        S,
      );
      assert.equal(fee, c.expectedDeliveryCents,
        `frais de livraison attendus ${c.expectedDeliveryCents}, obtenus ${fee}`);
      assert.equal(S.service_fee_cents, c.expectedServiceCents);
    });
  }

  for (const c of vectors.invalidCases) {
    test(`refus : ${c.name}`, () => {
      assert.throws(
        () => computeDeliveryFee(
          { pallets: c.pallets, floor: c.floor, hasLift: c.hasLift, surge: c.surge, mode: c.mode }, S,
        ),
        SurgeOutOfRangeError,
      );
    });
  }
});

describe('tarification — règles du §9', () => {
  test("l'exemple de référence du cahier des charges donne 6,50 €", () => {
    const fee = computeDeliveryFee(
      { pallets: 2, floor: 3, hasLift: false, surge: 1.0, mode: 'express' }, S);
    assert.equal(fee, 650);
    // Normalise the separator: which space Intl picks is an ICU detail,
    // not a business rule.
    assert.equal(formatEur(fee).replace(/\s/gu, ' '), '6,50 €');
  });

  test('le rez-de-chaussée ne coûte aucun frais d\'étage', () => {
    assert.equal(floorFee({ floor: 0, hasLift: false }, S), 0);
    assert.equal(floorFee({ floor: 0, hasLift: true }, S), 0);
  });

  test("avec ascenseur le forfait ne dépend pas de l'étage", () => {
    assert.equal(floorFee({ floor: 1, hasLift: true }, S), 100);
    assert.equal(floorFee({ floor: 9, hasLift: true }, S), 100);
  });

  test('sans ascenseur les frais sont proportionnels aux étages', () => {
    assert.equal(floorFee({ floor: 3, hasLift: false }, S), 150);
  });

  test('les frais de base couvrent la première palette', () => {
    const noPallet = computeDeliveryFee({ pallets: 0, floor: 0, hasLift: false, surge: 1, mode: 'express' }, S);
    const onePallet = computeDeliveryFee({ pallets: 1, floor: 0, hasLift: false, surge: 1, mode: 'express' }, S);
    assert.equal(noPallet, onePallet);
  });

  test('chaque palette supplémentaire ajoute exactement le tarif prévu', () => {
    const two = computeDeliveryFee({ pallets: 2, floor: 0, hasLift: false, surge: 1, mode: 'express' }, S);
    const three = computeDeliveryFee({ pallets: 3, floor: 0, hasLift: false, surge: 1, mode: 'express' }, S);
    assert.equal(three - two, S.extra_pallet_fee_cents);
  });

  test('la tournée groupée applique −40 % sur les frais de livraison', () => {
    const express = computeDeliveryFee({ pallets: 2, floor: 3, hasLift: false, surge: 1, mode: 'express' }, S);
    const grouped = computeDeliveryFee({ pallets: 2, floor: 3, hasLift: false, surge: 1, mode: 'grouped_round' }, S);
    assert.equal(grouped, roundCents(express * 0.6));
  });

  test('le coefficient d\'affluence ne s\'applique jamais aux frais de service', () => {
    const total = computeOrderTotal(
      { pallets: 1, floor: 0, hasLift: false, surge: 1.5, mode: 'express' }, 1000, S);
    assert.equal(total.serviceCents, S.service_fee_cents);
  });
});

describe('total de commande — critère 20.5', () => {
  test('le total est la somme exacte de ses composantes', () => {
    const t = computeOrderTotal(
      { pallets: 2, floor: 3, hasLift: false, surge: 1.0, mode: 'express' }, 2998, S, 200);
    assert.equal(t.totalCents, t.itemsCents + t.deliveryCents + t.serviceCents + t.tipCents);
    assert.equal(t.totalCents, 2998 + 650 + 49 + 200);
  });

  test('tous les montants restent des entiers de centimes', () => {
    for (const surge of [1.0, 1.07, 1.13, 1.25, 1.5]) {
      const t = computeOrderTotal(
        { pallets: 3, floor: 2, hasLift: false, surge, mode: 'express' }, 4497, S, 37);
      for (const [key, value] of Object.entries(t)) {
        assert.ok(Number.isInteger(value), `${key} = ${value} n'est pas un entier`);
      }
    }
  });
});

describe('arrondi', () => {
  test('l\'arrondi est demi vers le haut', () => {
    assert.equal(roundCents(649.5), 650);
    assert.equal(roundCents(649.4999), 649);
    assert.equal(roundCents(0.5), 1);
    assert.equal(roundCents(0.4), 0);
  });
});
