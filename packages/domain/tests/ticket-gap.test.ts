import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ticketGapDecision } from '../src/ticket-gap.ts';

const S = { operator_absorbs_gap_cents: 100 };

describe('écart entre prix indicatif et ticket — §10', () => {
  test('ticket identique à l\'estimation : rien ne bouge', () => {
    const d = ticketGapDecision(3000, 3000, S);
    assert.deepEqual(d, {
      gapCents: 0, operatorAbsorbsCents: 0, extraCaptureCents: 0,
      refundCents: 0, requiresClientApproval: false,
    });
  });

  test('ticket inférieur : la différence est remboursée', () => {
    const d = ticketGapDecision(3000, 2800, S);
    assert.equal(d.refundCents, 200);
    assert.equal(d.requiresClientApproval, false);
    assert.equal(d.extraCaptureCents, 0);
  });

  test('dépassement sous le seuil : entièrement absorbé par l\'Opérateur', () => {
    const d = ticketGapDecision(3000, 3080, S);
    assert.equal(d.operatorAbsorbsCents, 80);
    assert.equal(d.extraCaptureCents, 0);
    assert.equal(d.requiresClientApproval, false);
  });

  test('dépassement exactement au seuil : encore absorbé', () => {
    const d = ticketGapDecision(3000, 3100, S);
    assert.equal(d.operatorAbsorbsCents, 100);
    assert.equal(d.extraCaptureCents, 0);
    assert.equal(d.requiresClientApproval, false);
  });

  test('dépassement au-delà du seuil : accord du client requis pour le solde', () => {
    const d = ticketGapDecision(3000, 3250, S);
    assert.equal(d.operatorAbsorbsCents, 100);
    assert.equal(d.extraCaptureCents, 150);
    assert.equal(d.requiresClientApproval, true);
  });

  test('le client n\'est jamais débité de plus que le ticket', () => {
    for (const actual of [2000, 2900, 3000, 3050, 3100, 3500, 5000]) {
      const d = ticketGapDecision(3000, actual, S);
      const charged = 3000 + d.extraCaptureCents - d.refundCents;
      assert.ok(charged <= actual,
        `débité ${charged} pour un ticket de ${actual}`);
    }
  });

  test("l'Opérateur n'absorbe jamais plus que le paramètre", () => {
    for (const actual of [3001, 3100, 3500, 10000]) {
      const d = ticketGapDecision(3000, actual, S);
      assert.ok(d.operatorAbsorbsCents <= S.operator_absorbs_gap_cents);
    }
  });

  test('le seuil est un paramètre, pas une constante', () => {
    const generous = ticketGapDecision(3000, 3250, { operator_absorbs_gap_cents: 300 });
    assert.equal(generous.requiresClientApproval, false);
    assert.equal(generous.operatorAbsorbsCents, 250);
  });
});
