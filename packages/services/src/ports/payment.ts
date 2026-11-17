/**
 * Payment provider (spec 4.5).
 *
 * The operator never holds card data: the provider tokenises it. This port is
 * deliberately narrow, and NO method returns or accepts a card number, an
 * expiry date or a CVC. A provider adapter that needed one would not fit.
 */

import type { Cents } from '@palette/domain';

export type PaymentMethod = 'bancontact' | 'card' | 'apple_pay' | 'google_pay';

export interface CreatePaymentRequest {
  readonly orderId: string;
  readonly orderReference: string;
  /**
   * Amount to authorise. For a card this is the estimate plus the pre-auth
   * margin; for Bancontact it is the estimate, debited immediately (spec 10).
   */
  readonly amountCents: Cents;
  readonly method: PaymentMethod;
  readonly description: string;
  /** Spec 4.5: webhooks must be idempotent. This key is the guarantee. */
  readonly idempotencyKey: string;
  readonly returnUrl: string;
  readonly webhookUrl: string;
}

export interface CreatedPayment {
  readonly providerRef: string;
  /** Where the client completes strong customer authentication. */
  readonly checkoutUrl: string;
  readonly status: 'pending';
}

export interface CaptureRequest {
  readonly providerRef: string;
  /** Never more than what was authorised, and never more than the till receipt. */
  readonly amountCents: Cents;
  readonly idempotencyKey: string;
}

export interface RefundRequest {
  readonly providerRef: string;
  readonly amountCents: Cents;
  /** Spec 4.5: a refund always carries a reason. */
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** What the provider tells us happened. Never contains card data. */
export interface PaymentEvent {
  readonly providerRef: string;
  readonly status: 'pending' | 'authorized' | 'captured' | 'failed' | 'cancelled' | 'refunded';
  readonly amountCents: Cents;
  /** Spec 4.5: strong customer authentication is mandatory before capture. */
  readonly scaCompleted: boolean;
  readonly failureReason?: string;
  readonly occurredAt: Date;
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Signature de webhook invalide.');
    this.name = 'WebhookSignatureError';
  }
}

export interface PaymentProvider {
  readonly name: 'mollie' | 'stripe' | 'mock';
  createPayment(request: CreatePaymentRequest): Promise<CreatedPayment>;
  capture(request: CaptureRequest): Promise<PaymentEvent>;
  refund(request: RefundRequest): Promise<PaymentEvent>;
  /** Throws WebhookSignatureError when the payload is not authentic. */
  parseWebhook(rawBody: string, signature: string): PaymentEvent;
}
