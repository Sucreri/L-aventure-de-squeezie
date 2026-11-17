/**
 * Order lifecycle (spec 12).
 *
 * The authoritative matrix lives in the `order_transitions` TABLE, not here.
 * scripts/check-parity.sh asserts that this constant and that table agree, so
 * a transition added on one side without the other fails the suite.
 */

export type OrderStatus =
  | 'WAITLISTED' | 'CREATED' | 'PAID' | 'SEARCHING_COURIER' | 'COURIER_ASSIGNED'
  | 'AT_STORE' | 'PURCHASED' | 'EN_ROUTE' | 'ARRIVED' | 'DELIVERED'
  | 'CANCELLED_BY_CLIENT' | 'CANCELLED_BY_OPS' | 'NO_COURIER_FOUND'
  | 'DELIVERY_FAILED' | 'HELD_AT_HUB' | 'REFUNDED_PARTIAL' | 'REFUNDED_FULL';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'WAITLISTED', 'CREATED', 'PAID', 'SEARCHING_COURIER', 'COURIER_ASSIGNED',
  'AT_STORE', 'PURCHASED', 'EN_ROUTE', 'ARRIVED', 'DELIVERED',
  'CANCELLED_BY_CLIENT', 'CANCELLED_BY_OPS', 'NO_COURIER_FOUND',
  'DELIVERY_FAILED', 'HELD_AT_HUB', 'REFUNDED_PARTIAL', 'REFUNDED_FULL',
] as const;

export const ALLOWED_TRANSITIONS: readonly (readonly [OrderStatus, OrderStatus])[] = [
  ['WAITLISTED', 'CREATED'],
  ['WAITLISTED', 'CANCELLED_BY_CLIENT'],
  ['CREATED', 'PAID'],
  ['CREATED', 'CANCELLED_BY_CLIENT'],
  ['CREATED', 'CANCELLED_BY_OPS'],
  ['PAID', 'SEARCHING_COURIER'],
  ['PAID', 'CANCELLED_BY_CLIENT'],
  ['PAID', 'CANCELLED_BY_OPS'],
  ['PAID', 'REFUNDED_FULL'],
  ['SEARCHING_COURIER', 'COURIER_ASSIGNED'],
  ['SEARCHING_COURIER', 'NO_COURIER_FOUND'],
  ['SEARCHING_COURIER', 'CANCELLED_BY_CLIENT'],
  ['SEARCHING_COURIER', 'CANCELLED_BY_OPS'],
  ['NO_COURIER_FOUND', 'SEARCHING_COURIER'],
  ['NO_COURIER_FOUND', 'CANCELLED_BY_CLIENT'],
  ['NO_COURIER_FOUND', 'REFUNDED_FULL'],
  ['NO_COURIER_FOUND', 'CANCELLED_BY_OPS'],
  ['COURIER_ASSIGNED', 'AT_STORE'],
  ['COURIER_ASSIGNED', 'SEARCHING_COURIER'],
  ['COURIER_ASSIGNED', 'CANCELLED_BY_CLIENT'],
  ['COURIER_ASSIGNED', 'CANCELLED_BY_OPS'],
  ['AT_STORE', 'PURCHASED'],
  ['AT_STORE', 'SEARCHING_COURIER'],
  ['AT_STORE', 'CANCELLED_BY_CLIENT'],
  ['AT_STORE', 'CANCELLED_BY_OPS'],
  ['PURCHASED', 'EN_ROUTE'],
  ['PURCHASED', 'CANCELLED_BY_CLIENT'],
  ['PURCHASED', 'CANCELLED_BY_OPS'],
  ['PURCHASED', 'DELIVERY_FAILED'],
  ['EN_ROUTE', 'ARRIVED'],
  ['EN_ROUTE', 'DELIVERY_FAILED'],
  ['EN_ROUTE', 'CANCELLED_BY_OPS'],
  ['ARRIVED', 'DELIVERED'],
  ['ARRIVED', 'DELIVERY_FAILED'],
  ['DELIVERY_FAILED', 'HELD_AT_HUB'],
  ['DELIVERY_FAILED', 'REFUNDED_PARTIAL'],
  ['HELD_AT_HUB', 'DELIVERED'],
  ['HELD_AT_HUB', 'REFUNDED_PARTIAL'],
  ['DELIVERED', 'REFUNDED_PARTIAL'],
  ['DELIVERED', 'REFUNDED_FULL'],
  ['CANCELLED_BY_CLIENT', 'REFUNDED_FULL'],
  ['CANCELLED_BY_CLIENT', 'REFUNDED_PARTIAL'],
  ['CANCELLED_BY_OPS', 'REFUNDED_FULL'],
  ['CANCELLED_BY_OPS', 'REFUNDED_PARTIAL'],
  ['REFUNDED_PARTIAL', 'REFUNDED_FULL'],
] as const;

const TRANSITION_SET = new Set(ALLOWED_TRANSITIONS.map(([a, b]) => `${a}>${b}`));

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITION_SET.has(`${from}>${to}`);
}

/**
 * Spec 12: cancellation is free up to and including AT_STORE. After PURCHASED
 * the items and a share of the delivery fee remain due. The client sees these
 * terms BEFORE paying, never afterwards.
 */
const FREE_CANCELLATION_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'WAITLISTED', 'CREATED', 'PAID', 'SEARCHING_COURIER',
  'NO_COURIER_FOUND', 'COURIER_ASSIGNED', 'AT_STORE',
]);

export function isCancellationFree(status: OrderStatus): boolean {
  return FREE_CANCELLATION_STATUSES.has(status);
}

/** Statuses in which an order still occupies the operator and the courier. */
export function isInFlight(status: OrderStatus): boolean {
  return !([
    'DELIVERED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_OPS',
    'REFUNDED_FULL', 'REFUNDED_PARTIAL', 'NO_COURIER_FOUND',
  ] as OrderStatus[]).includes(status);
}
