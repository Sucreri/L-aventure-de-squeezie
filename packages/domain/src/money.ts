/**
 * Money is always an integer number of cents.
 *
 * Rationale (HYPOTHESES.md H-14): acceptance criterion 20.5 requires the total
 * displayed before payment to equal the amount actually debited. Floating point
 * euros make that promise impossible to keep, so every amount in this codebase
 * is an integer of cents and rounding happens exactly once, at the end of a
 * computation.
 */

/** A monetary amount, in cents. */
export type Cents = number;

/** Half-up rounding, matching `app.round_cents` in SQL. */
export function roundCents(amount: number): Cents {
  return Math.floor(amount + 0.5);
}

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, got ${value}`);
  }
  return value;
}

/** Display helper. Formatting is presentation, never used in a computation. */
export function formatEur(cents: Cents, locale = 'fr-BE'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' })
    .format(cents / 100);
}
