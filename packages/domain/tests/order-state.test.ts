import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition, isCancellationFree, isInFlight,
  ALLOWED_TRANSITIONS, ORDER_STATUSES, type OrderStatus,
} from '../src/order-state.ts';

describe('machine à états des commandes — §12', () => {
  test('les 17 statuts du cahier des charges sont présents', () => {
    assert.equal(ORDER_STATUSES.length, 17);
  });

  test('le parcours nominal est intégralement autorisé', () => {
    const happyPath: OrderStatus[] = [
      'CREATED', 'PAID', 'SEARCHING_COURIER', 'COURIER_ASSIGNED',
      'AT_STORE', 'PURCHASED', 'EN_ROUTE', 'ARRIVED', 'DELIVERED',
    ];
    for (let i = 0; i < happyPath.length - 1; i++) {
      const from = happyPath[i]!;
      const to = happyPath[i + 1]!;
      assert.ok(canTransition(from, to), `${from} -> ${to} devrait être autorisé`);
    }
  });

  test('aucune transition ne saute une étape', () => {
    assert.equal(canTransition('CREATED', 'DELIVERED'), false);
    assert.equal(canTransition('PAID', 'EN_ROUTE'), false);
    assert.equal(canTransition('AT_STORE', 'DELIVERED'), false);
  });

  test('un état terminal ne revient pas en arrière', () => {
    assert.equal(canTransition('DELIVERED', 'EN_ROUTE'), false);
    assert.equal(canTransition('REFUNDED_FULL', 'PAID'), false);
    assert.equal(canTransition('CANCELLED_BY_CLIENT', 'PAID'), false);
  });

  test('un statut ne transitionne jamais vers lui-même', () => {
    for (const s of ORDER_STATUSES) {
      assert.equal(canTransition(s, s), false, `${s} -> ${s}`);
    }
  });

  test('la matrice ne contient aucun doublon', () => {
    const keys = ALLOWED_TRANSITIONS.map(([a, b]) => `${a}>${b}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('toute la matrice est exercée, dans les deux sens', () => {
    let allowed = 0;
    let refused = 0;
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue;
        const expected = ALLOWED_TRANSITIONS.some(([a, b]) => a === from && b === to);
        assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
        expected ? allowed++ : refused++;
      }
    }
    assert.equal(allowed, ALLOWED_TRANSITIONS.length);
    assert.equal(allowed + refused, 17 * 16);
  });
});

describe('conditions d\'annulation — §12', () => {
  test("l'annulation est gratuite jusqu'à AT_STORE inclus", () => {
    for (const s of ['WAITLISTED', 'CREATED', 'PAID', 'SEARCHING_COURIER',
                     'NO_COURIER_FOUND', 'COURIER_ASSIGNED', 'AT_STORE'] as OrderStatus[]) {
      assert.equal(isCancellationFree(s), true, s);
    }
  });

  test("après l'achat, l'annulation n'est plus gratuite", () => {
    for (const s of ['PURCHASED', 'EN_ROUTE', 'ARRIVED'] as OrderStatus[]) {
      assert.equal(isCancellationFree(s), false, s);
    }
  });

  test('les états clos ne sont plus en cours', () => {
    assert.equal(isInFlight('DELIVERED'), false);
    assert.equal(isInFlight('REFUNDED_FULL'), false);
    assert.equal(isInFlight('EN_ROUTE'), true);
    assert.equal(isInFlight('HELD_AT_HUB'), true);
  });
});
