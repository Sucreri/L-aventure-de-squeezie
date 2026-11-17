import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mayBuyAgeRestricted, bracketMinAge, mayRegister, mayBeCourier,
  type AgeBracket, type Buyer,
} from '../src/age.ts';

const verified = (b: AgeBracket): Buyer => ({ ageBracket: b, ageVerified: true });
const unverified = (b: AgeBracket | null): Buyer => ({ ageBracket: b, ageVerified: false });

describe('contrôle d\'âge — §4.1', () => {
  test('un produit sans restriction est accessible à tous, même non vérifié', () => {
    assert.equal(mayBuyAgeRestricted(unverified(null), 0), true);
    assert.equal(mayBuyAgeRestricted(verified('b16_17'), 0), true);
  });

  test('un compte non vérifié ne peut acheter aucun alcool', () => {
    assert.equal(mayBuyAgeRestricted(unverified('b18_plus'), 16), false);
    assert.equal(mayBuyAgeRestricted(unverified('b18_plus'), 18), false);
  });

  test('la bière (16+) est accessible à un compte 16-17 vérifié', () => {
    assert.equal(mayBuyAgeRestricted(verified('b16_17'), 16), true);
  });

  test('les spiritueux (18+) sont refusés à un compte 16-17', () => {
    assert.equal(mayBuyAgeRestricted(verified('b16_17'), 18), false);
  });

  test('un compte 18+ vérifié peut tout acheter', () => {
    assert.equal(mayBuyAgeRestricted(verified('b18_plus'), 16), true);
    assert.equal(mayBuyAgeRestricted(verified('b18_plus'), 18), true);
  });

  test('un compte de moins de 16 ans ne peut rien acheter de restreint', () => {
    assert.equal(mayBuyAgeRestricted(verified('under_16'), 16), false);
    assert.equal(mayBuyAgeRestricted(verified('under_16'), 18), false);
  });

  test('table de vérité complète', () => {
    const expected: Array<[AgeBracket | null, boolean, number, boolean]> = [
      [null,       false, 0,  true],
      [null,       false, 16, false],
      ['under_16', true,  16, false],
      ['b16_17',   true,  16, true],
      ['b16_17',   true,  18, false],
      ['b18_plus', true,  16, true],
      ['b18_plus', true,  18, true],
      ['b18_plus', false, 16, false],
    ];
    for (const [bracket, isVerified, min, want] of expected) {
      const got = mayBuyAgeRestricted({ ageBracket: bracket, ageVerified: isVerified }, min);
      assert.equal(got, want, `bracket=${bracket} vérifié=${isVerified} min=${min}`);
    }
  });
});

describe('tranches d\'âge', () => {
  test('les tranches donnent le minimum garanti', () => {
    assert.equal(bracketMinAge('b18_plus'), 18);
    assert.equal(bracketMinAge('b16_17'), 16);
    assert.equal(bracketMinAge('under_16'), 0);
    assert.equal(bracketMinAge(null), 0);
  });

  test('l\'inscription est refusée aux moins de 16 ans (§6.1)', () => {
    assert.equal(mayRegister('under_16'), false);
    assert.equal(mayRegister('b16_17'), true);
    assert.equal(mayRegister('b18_plus'), true);
  });

  test('un palettier doit être majeur et vérifié (§4.3)', () => {
    assert.equal(mayBeCourier(verified('b18_plus')), true);
    assert.equal(mayBeCourier(verified('b16_17')), false);
    assert.equal(mayBeCourier(unverified('b18_plus')), false);
  });
});
