/**
 * Shared domain logic.
 *
 * IMPORTANT: the database is authoritative for every rule in this package.
 * Nothing here is a security boundary — these functions exist so the app can
 * display a price, hide an out-of-reach product and validate a form without a
 * round trip. Every rule is enforced again, unconditionally, in Postgres.
 */

export * from './money.ts';
export * from './age.ts';
export * from './pricing.ts';
export * from './ticket-gap.ts';
export * from './order-state.ts';
export * from './promotions.ts';
export * from './dispatch.ts';
export * from './geo.ts';
