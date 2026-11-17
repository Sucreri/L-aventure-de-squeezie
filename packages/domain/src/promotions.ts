/**
 * Promotion rules (spec 4.1, acceptance criterion 20.4).
 *
 * A promotion may only ever reduce the delivery fee or the service fee. It can
 * never touch a product, and never depend on a quantity — that would be a
 * discount tied to the amount of alcohol bought, which Belgian law and the
 * advertising convention forbid.
 *
 * The server enforces this (trigger `app.guard_promotion_rule`). This module
 * mirrors the rule so the back-office can refuse a bad rule before submitting.
 */

import { roundCents, type Cents } from './money.ts';

/** Note the type itself: there is no way to name a product. */
export type PromotionTarget = 'delivery_fee' | 'service_fee';

export const ALLOWED_CONDITION_KEYS = [
  'min_order_cents', 'modes', 'zone_ids', 'first_order_only',
  'valid_weekdays', 'max_per_user',
] as const;

export type AllowedConditionKey = typeof ALLOWED_CONDITION_KEYS[number];

/** Mirrors the SQL guard: product and alcohol vocabulary is refused outright. */
const FORBIDDEN_VOCABULARY =
  /(product|article|pallet|palette|bier|biere|bière|beer|alcoo|alcohol|degre|degré)/i;

export type Promotion =
  | {
      readonly name: string;
      readonly target: PromotionTarget;
      readonly discountType: 'percent';
      /** Between 0 (exclusive) and 1 (inclusive). */
      readonly discountPercent: number;
      readonly conditions: Readonly<Record<string, unknown>>;
    }
  | {
      readonly name: string;
      readonly target: PromotionTarget;
      readonly discountType: 'fixed';
      readonly discountFixedCents: Cents;
      readonly conditions: Readonly<Record<string, unknown>>;
    };

export class ForbiddenPromotionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ForbiddenPromotionError';
  }
}

/**
 * Throws when a promotion would, directly or indirectly, bear on a product or
 * on a quantity. Whitelist first, vocabulary check second.
 */
export function validatePromotion(p: Promotion): void {
  for (const key of Object.keys(p.conditions)) {
    if (!(ALLOWED_CONDITION_KEYS as readonly string[]).includes(key)) {
      throw new ForbiddenPromotionError(
        `Condition de promotion interdite : « ${key} ». ` +
        `Une promotion ne peut porter ni sur un produit ni sur une quantité. ` +
        `Clés autorisées : ${ALLOWED_CONDITION_KEYS.join(', ')}.`,
      );
    }
  }

  const serialised = JSON.stringify(p.conditions);
  if (FORBIDDEN_VOCABULARY.test(serialised)) {
    throw new ForbiddenPromotionError(
      'Une promotion ne peut pas faire référence à un produit ou à de l\'alcool.',
    );
  }

  if (p.discountType === 'percent' && (p.discountPercent <= 0 || p.discountPercent > 1)) {
    throw new ForbiddenPromotionError('Un pourcentage de réduction doit être compris entre 0 et 1.');
  }
  if (p.discountType === 'fixed' && !Number.isInteger(p.discountFixedCents)) {
    throw new ForbiddenPromotionError('Une réduction fixe est un entier de centimes.');
  }
}

export interface Fees {
  readonly deliveryCents: Cents;
  readonly serviceCents: Cents;
}

/**
 * Applies a promotion to the fee it targets.
 *
 * Note the signature: the item total is not an argument. The function is
 * structurally unable to discount a product.
 */
export function applyPromotion(fees: Fees, p: Promotion): Fees {
  validatePromotion(p);

  const current = p.target === 'delivery_fee' ? fees.deliveryCents : fees.serviceCents;

  const cut = p.discountType === 'percent'
    ? roundCents(current * p.discountPercent)
    : Math.min(p.discountFixedCents, current);

  const reduced = Math.max(current - cut, 0);

  return p.target === 'delivery_fee'
    ? { deliveryCents: reduced, serviceCents: fees.serviceCents }
    : { deliveryCents: fees.deliveryCents, serviceCents: reduced };
}
