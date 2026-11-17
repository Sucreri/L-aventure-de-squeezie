/**
 * Gap between the indicative price and the till receipt (spec 10).
 *
 * The client is never charged more than the till receipt. When the receipt is
 * higher than the estimate, the operator absorbs up to a parameterised amount;
 * beyond that, the courier must obtain the client's in-app approval (with SCA)
 * before paying.
 */

import type { Cents } from './money.ts';

export interface GapSettings {
  /** How much of an overrun the operator swallows, in cents. */
  readonly operator_absorbs_gap_cents: Cents;
}

export interface GapDecision {
  readonly gapCents: number;
  readonly operatorAbsorbsCents: Cents;
  readonly extraCaptureCents: Cents;
  readonly refundCents: Cents;
  readonly requiresClientApproval: boolean;
}

export function ticketGapDecision(
  itemsEstimatedCents: Cents,
  itemsActualCents: Cents,
  s: GapSettings,
): GapDecision {
  const gapCents = itemsActualCents - itemsEstimatedCents;

  if (gapCents <= 0) {
    return {
      gapCents,
      operatorAbsorbsCents: 0,
      extraCaptureCents: 0,
      refundCents: Math.abs(gapCents),
      requiresClientApproval: false,
    };
  }

  const operatorAbsorbsCents = Math.min(gapCents, s.operator_absorbs_gap_cents);
  const extraCaptureCents = gapCents - operatorAbsorbsCents;

  return {
    gapCents,
    operatorAbsorbsCents,
    extraCaptureCents,
    refundCents: 0,
    requiresClientApproval: extraCaptureCents > 0,
  };
}
