/**
 * Simulated payment provider.
 *
 * It reproduces the behaviours that matter for correctness, not a pretty demo:
 * authorisation then capture, strong customer authentication as a separate
 * step, signed webhooks, and refunds. Swapping it for Mollie or Stripe is a
 * change of environment variable, not of application code.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type {
  PaymentProvider, CreatePaymentRequest, CreatedPayment, CaptureRequest,
  RefundRequest, PaymentEvent,
} from '../../ports/payment.ts';
import { WebhookSignatureError } from '../../ports/payment.ts';
import type { Clock } from '../../ports/clock.ts';
import { systemClock } from '../../ports/clock.ts';

interface MockPaymentState {
  providerRef: string;
  orderId: string;
  authorizedCents: number;
  capturedCents: number;
  refundedCents: number;
  status: PaymentEvent['status'];
  scaCompleted: boolean;
  idempotencyKey: string;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  private readonly payments = new Map<string, MockPaymentState>();
  /** Keyed by idempotency key, so a replayed request returns the same payment. */
  private readonly byIdempotencyKey = new Map<string, string>();

  private readonly secret: string;
  private readonly clock: Clock;

  constructor(secret = 'mock-webhook-secret', clock: Clock = systemClock) {
    this.secret = secret;
    this.clock = clock;
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatedPayment> {
    const existing = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existing) {
      // Spec 4.5: replaying a request must not create a second payment.
      return { providerRef: existing, checkoutUrl: this.checkoutUrl(existing), status: 'pending' };
    }

    const providerRef = `mock_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.payments.set(providerRef, {
      providerRef,
      orderId: request.orderId,
      authorizedCents: request.amountCents,
      capturedCents: 0,
      refundedCents: 0,
      status: 'pending',
      scaCompleted: false,
      idempotencyKey: request.idempotencyKey,
    });
    this.byIdempotencyKey.set(request.idempotencyKey, providerRef);

    return { providerRef, checkoutUrl: this.checkoutUrl(providerRef), status: 'pending' };
  }

  /**
   * Simulates the client completing strong customer authentication.
   * Only a test or the demo calls this; in production the client does it in
   * the provider's own flow.
   */
  completeAuthentication(providerRef: string, succeed = true): PaymentEvent {
    const p = this.require(providerRef);
    p.scaCompleted = succeed;
    p.status = succeed ? 'authorized' : 'failed';
    return this.toEvent(p, succeed ? undefined : 'authentication refusée');
  }

  async capture(request: CaptureRequest): Promise<PaymentEvent> {
    const p = this.require(request.providerRef);

    if (!p.scaCompleted) {
      throw new Error('capture impossible : authentification forte non réalisée');
    }
    if (request.amountCents > p.authorizedCents) {
      throw new Error(
        `capture de ${request.amountCents} supérieure au montant autorisé ${p.authorizedCents}`);
    }

    p.capturedCents = request.amountCents;
    p.status = 'captured';
    return this.toEvent(p);
  }

  async refund(request: RefundRequest): Promise<PaymentEvent> {
    const p = this.require(request.providerRef);
    const refundable = p.capturedCents - p.refundedCents;

    if (request.amountCents > refundable) {
      throw new Error(`remboursement de ${request.amountCents} supérieur au solde ${refundable}`);
    }

    p.refundedCents += request.amountCents;
    p.status = p.refundedCents >= p.capturedCents ? 'refunded' : 'captured';
    return this.toEvent(p);
  }

  parseWebhook(rawBody: string, signature: string): PaymentEvent {
    const expected = this.sign(rawBody);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookSignatureError();
    }

    const parsed = JSON.parse(rawBody) as {
      providerRef: string; status: PaymentEvent['status'];
      amountCents: number; scaCompleted: boolean; failureReason?: string;
    };

    return {
      providerRef: parsed.providerRef,
      status: parsed.status,
      amountCents: parsed.amountCents,
      scaCompleted: parsed.scaCompleted,
      ...(parsed.failureReason === undefined ? {} : { failureReason: parsed.failureReason }),
      occurredAt: this.clock.now(),
    };
  }

  /** Builds a signed webhook payload, as the provider would send it. */
  buildWebhook(event: Omit<PaymentEvent, 'occurredAt'>): { body: string; signature: string } {
    const body = JSON.stringify(event);
    return { body, signature: this.sign(body) };
  }

  state(providerRef: string): Readonly<MockPaymentState> | undefined {
    return this.payments.get(providerRef);
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  private checkoutUrl(providerRef: string): string {
    return `https://mock-psp.invalid/checkout/${providerRef}`;
  }

  private require(providerRef: string): MockPaymentState {
    const p = this.payments.get(providerRef);
    if (!p) throw new Error(`paiement inconnu : ${providerRef}`);
    return p;
  }

  private toEvent(p: MockPaymentState, failureReason?: string): PaymentEvent {
    return {
      providerRef: p.providerRef,
      status: p.status,
      amountCents: p.status === 'captured' ? p.capturedCents : p.authorizedCents,
      scaCompleted: p.scaCompleted,
      ...(failureReason === undefined ? {} : { failureReason }),
      occurredAt: this.clock.now(),
    };
  }
}
