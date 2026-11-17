/**
 * Age gating (spec 4.1, 5, 13).
 *
 * The app NEVER holds a date of birth: only a verified bracket. See
 * HYPOTHESES.md H-04. This module mirrors `app.may_buy_age_restricted` in SQL,
 * which stays authoritative — this copy only decides what to show.
 */

export type AgeBracket = 'under_16' | 'b16_17' | 'b18_plus';

/** The minimum age a bracket is known to satisfy. */
export function bracketMinAge(bracket: AgeBracket | null): number {
  switch (bracket) {
    case 'b18_plus': return 18;
    case 'b16_17':   return 16;
    default:         return 0;
  }
}

export interface Buyer {
  readonly ageBracket: AgeBracket | null;
  readonly ageVerified: boolean;
}

/**
 * May this buyer purchase a product requiring `ageMinimum`?
 *
 * An unverified account may buy nothing age-restricted, whatever bracket it
 * claims. That is the whole point of the verification step.
 */
export function mayBuyAgeRestricted(buyer: Buyer, ageMinimum: number): boolean {
  if (!ageMinimum) return true;
  if (!buyer.ageVerified || buyer.ageBracket === null) return false;
  return bracketMinAge(buyer.ageBracket) >= ageMinimum;
}

/** Spec 6.1: under 16, registration is refused outright. */
export function mayRegister(bracket: AgeBracket): boolean {
  return bracket !== 'under_16';
}

/** Spec 4.3: a courier must be 18 or over. */
export function mayBeCourier(buyer: Buyer): boolean {
  return buyer.ageVerified && buyer.ageBracket === 'b18_plus';
}
