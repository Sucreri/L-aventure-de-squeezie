/**
 * Orchestration layer.
 *
 * It calls the database — which enforces every compliance rule — and the
 * external providers. It contains no business rule of its own, by design:
 * a rule that lived only here could be bypassed by any other caller.
 */

export * from './ports/clock.ts';
export * from './ports/payment.ts';
export * from './ports/age-verification.ts';
export * from './ports/notifications.ts';
export * from './ports/spend-card.ts';
export * from './ports/receipt-reader.ts';
export * from './ports/database.ts';

export * from './adapters/mock/mock-payment.ts';
export * from './adapters/mock/mock-age-verification.ts';
export * from './adapters/mock/mock-notifications.ts';
export * from './adapters/mock/mock-spend-card.ts';
export * from './adapters/mock/mock-receipt-reader.ts';
export { createPostgresDatabase, connect } from './adapters/postgres/postgres-database.ts';

export * from './errors.ts';
export * from './usecases/place-order.ts';
export * from './usecases/confirm-payment.ts';
export * from './usecases/settle-ticket.ts';
export * from './usecases/dispatch.ts';
export * from './usecases/complete-delivery.ts';
