import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidate, rankCandidates, type Candidate, type DispatchSettings } from '../src/dispatch.ts';

const S: DispatchSettings = {
  max_distance_to_store_m: 2000,
  weight_speed: 0.6,
  weight_capacity: 0.2,
  weight_grouping: 0.2,
};

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  courierId: 'c1', distanceToStoreM: 1000, remainingUnits: 4,
  canGroup: false, missionsInShift: 0, ...over,
});

describe('attribution des missions — §15', () => {
  test('les poids somment à 1', () => {
    assert.equal(S.weight_speed + S.weight_capacity + S.weight_grouping, 1);
  });

  test('le score reste dans [0, 1]', () => {
    for (const d of [0, 500, 1000, 1999, 2000]) {
      for (const group of [true, false]) {
        const s = scoreCandidate(candidate({ distanceToStoreM: d, canGroup: group }), 2, S);
        assert.ok(s >= 0 && s <= 1, `score ${s} hors bornes`);
      }
    }
  });

  test('un palettier au magasin et regroupable obtient le score maximal', () => {
    const s = scoreCandidate(
      candidate({ distanceToStoreM: 0, remainingUnits: 6, canGroup: true }), 2, S);
    assert.equal(s, 1);
  });

  test('la distance pèse davantage que les deux autres critères réunis', () => {
    const close = scoreCandidate(candidate({ distanceToStoreM: 0, canGroup: false }), 2, S);
    const far = scoreCandidate(
      candidate({ distanceToStoreM: 2000, canGroup: true, remainingUnits: 100 }), 2, S);
    assert.ok(close > far, 'la proximité doit l\'emporter');
  });

  test('un palettier trop loin est écarté, pas pénalisé', () => {
    const ranked = rankCandidates([candidate({ distanceToStoreM: 2500 })], 2, S);
    assert.equal(ranked.length, 0);
  });

  test('un palettier sans capacité suffisante est écarté', () => {
    const ranked = rankCandidates([candidate({ remainingUnits: 1 })], 3, S);
    assert.equal(ranked.length, 0,
      'un palettier qui ne peut pas porter la commande ne doit jamais la recevoir');
  });

  test('à score égal, la priorité va au moins chargé sur le créneau (§15)', () => {
    const ranked = rankCandidates([
      candidate({ courierId: 'busy', missionsInShift: 3 }),
      candidate({ courierId: 'idle', missionsInShift: 0 }),
    ], 2, S);
    assert.equal(ranked[0]?.courierId, 'idle');
  });

  test('le classement est déterministe à score et charge égaux', () => {
    const input = [
      candidate({ courierId: 'bbb' }),
      candidate({ courierId: 'aaa' }),
    ];
    assert.equal(rankCandidates(input, 2, S)[0]?.courierId, 'aaa');
    assert.equal(rankCandidates([...input].reverse(), 2, S)[0]?.courierId, 'aaa');
  });

  test('le meilleur score passe en tête', () => {
    const ranked = rankCandidates([
      candidate({ courierId: 'far', distanceToStoreM: 1800 }),
      candidate({ courierId: 'near', distanceToStoreM: 200 }),
    ], 2, S);
    assert.equal(ranked[0]?.courierId, 'near');
    assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 1));
  });

  test('une commande sans unités ne pénalise personne sur la capacité', () => {
    const s = scoreCandidate(candidate({ distanceToStoreM: 0, remainingUnits: 0 }), 0, S);
    assert.equal(s, 0.6 + 0.2);
  });
});
