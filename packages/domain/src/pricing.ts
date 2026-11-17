/**
 * Pricing (spec 9).
 *
 *   delivery fee = (base + extra pallets + floors) x c x (1 - round discount)
 *
 * This is the SECOND implementation of that formula. `app.compute_delivery_fee`
 * in SQL is the authoritative one; this copy exists so the app can show a price
 * instantly and offline. The two are kept in step by the shared vectors in
 * pricing-vectors.json, replayed against both by scripts/check-parity.sh.
 */

import { roundCents, type Cents } from './money.ts';

export type DeliveryMode = 'express' | 'scheduled' | 'grouped_round';

/** Every value here comes from app_settings; nothing is hard-coded. */
export interface PricingSettings {
  readonly base_fee_cents: Cents;
  readonly extra_pallet_fee_cents: Cents;
  readonly floor_fee_no_lift_cents: Cents;
  readonly floor_fee_with_lift_cents: Cents;
  readonly service_fee_cents: Cents;
  readonly grouped_round_discount: number;
  readonly surge_min: number;
  readonly surge_max: number;
}

export interface DeliveryInput {
  readonly pallets: number;
  readonly floor: number;
  readonly hasLift: boolean;
  readonly surge: number;
  readonly mode: DeliveryMode;
}

export class SurgeOutOfRangeError extends Error {
  constructor(surge: number, min: number, max: number) {
    super(`Le coefficient d'affluence ${surge} est hors des bornes [${min}, ${max}].`);
    this.name = 'SurgeOutOfRangeError';
  }
}

/**
 * Floor component of the fee.
 *
 * With a lift it is a flat fee whatever the floor; without one it is charged
 * per floor. The ground floor is always free.
 */
export function floorFee(input: Pick<DeliveryInput, 'floor' | 'hasLift'>, s: PricingSettings): Cents {
  if (input.floor <= 0) return 0;
  return input.hasLift ? s.floor_fee_with_lift_cents : input.floor * s.floor_fee_no_lift_cents;
}

export function computeDeliveryFee(input: DeliveryInput, s: PricingSettings): Cents {
  if (input.surge < s.surge_min || input.surge > s.surge_max) {
    throw new SurgeOutOfRangeError(input.surge, s.surge_min, s.surge_max);
  }

  // The base fee covers the first pallet, or an order with no pallet at all.
  const extraPallets = Math.max(input.pallets - 1, 0);

  const subtotal =
    s.base_fee_cents +
    extraPallets * s.extra_pallet_fee_cents +
    floorFee(input, s);

  const discount = input.mode === 'grouped_round' ? s.grouped_round_discount : 0;

  // Single rounding step, at the very end (H-14).
  return roundCents(subtotal * input.surge * (1 - discount));
}

export interface OrderTotal {
  readonly itemsCents: Cents;
  readonly deliveryCents: Cents;
  readonly serviceCents: Cents;
  readonly tipCents: Cents;
  readonly totalCents: Cents;
}

/**
 * Spec 6.7 and 4.6: the client sees the full breakdown before committing, and
 * the total is the exact sum of its parts. Criterion 20.5 depends on this.
 */
export function computeOrderTotal(
  input: DeliveryInput,
  itemsCents: Cents,
  s: PricingSettings,
  tipCents: Cents = 0,
): OrderTotal {
  const deliveryCents = computeDeliveryFee(input, s);
  const serviceCents = s.service_fee_cents;
  return {
    itemsCents,
    deliveryCents,
    serviceCents,
    tipCents,
    totalCents: itemsCents + deliveryCents + serviceCents + tipCents,
  };
}
