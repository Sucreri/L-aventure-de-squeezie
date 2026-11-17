/**
 * Database port.
 *
 * Every compliance rule lives in Postgres (constraints, triggers, functions).
 * This port therefore exposes the database's own operations rather than
 * re-expressing them: `placeOrder` INSERTs and lets the guards decide,
 * `computeDeliveryFee` calls the authoritative SQL function, `deliverOrder`
 * calls app.deliver_order.
 *
 * There is intentionally NO in-memory implementation of this port. A fake
 * would have to re-implement the rules, and the tests would then prove only
 * that the fake agrees with itself. The service tests run against a real
 * Postgres (scripts/test-services.sh).
 */

import type { Cents, DeliveryMode, OrderStatus, AgeBracket } from '@palette/domain';

export interface OrderRow {
  readonly id: string;
  readonly reference: string;
  readonly clientId: string;
  readonly status: OrderStatus;
  readonly zoneId: string;
  readonly storeId: string;
  readonly mode: DeliveryMode;
  readonly itemsEstimatedCents: Cents;
  readonly itemsActualCents: Cents | null;
  readonly deliveryFeeCents: Cents;
  readonly serviceFeeCents: Cents;
  readonly tipCents: Cents;
  readonly totalEstimatedCents: Cents;
  readonly totalChargedCents: Cents | null;
  readonly palletCount: number;
  readonly floorSnapshot: number;
  readonly hasLiftSnapshot: boolean;
  readonly surgeCoefficient: number;
}

export interface BasketLine {
  readonly productId: string;
  readonly quantity: number;
  /** Who takes this line in a group order; null for a normal order. */
  readonly participantId?: string | null;
  readonly substitutionRule?: 'other_format' | 'equivalent_ask_me' | 'refund';
}

export interface PlaceOrderInput {
  readonly clientId: string;
  readonly addressId: string;
  readonly storeId: string;
  readonly mode: DeliveryMode;
  readonly lines: readonly BasketLine[];
  readonly tipCents?: Cents;
  readonly slotStart?: Date;
  readonly slotEnd?: Date;
  readonly noteForCourier?: string;
}

export interface GapDecisionRow {
  readonly gapCents: number;
  readonly operatorAbsorbsCents: Cents;
  readonly extraCaptureCents: Cents;
  readonly refundCents: Cents;
  readonly requiresClientApproval: boolean;
  readonly explanation: string;
}

export interface CandidateRow {
  readonly courierId: string;
  readonly distanceM: number;
  readonly remainingUnits: number;
  readonly score: number;
  readonly missionsInShift: number;
}

export interface PaymentRow {
  readonly id: string;
  readonly orderId: string;
  readonly providerRef: string;
  readonly status: string;
  readonly amountAuthorizedCents: Cents | null;
  readonly amountCapturedCents: Cents | null;
}

/** Who is acting, recorded on every status transition (spec 12). */
export interface Actor {
  readonly id: string | null;
  readonly role: string;
  readonly reason?: string;
}

export interface Database {
  /** Runs `fn` inside a transaction. Rolls back on any thrown error. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;

  settings: {
    int(key: string): Promise<number>;
    num(key: string): Promise<number>;
    text(key: string): Promise<string>;
    bool(key: string): Promise<boolean>;
    launchBlockers(): Promise<readonly { key: string; description: string }[]>;
  };

  orders: {
    place(input: PlaceOrderInput): Promise<OrderRow>;
    byId(orderId: string): Promise<OrderRow | null>;
    setStatus(orderId: string, status: OrderStatus, actor: Actor): Promise<void>;
    setPin(orderId: string, pin: string): Promise<void>;
    containsAlcohol(orderId: string): Promise<boolean>;
    cancellationTerms(orderId: string): Promise<{
      free: boolean; itemsDueCents: Cents; feesDueCents: Cents; explanation: string;
    }>;
    recordActualItems(orderId: string, itemsActualCents: Cents, totalChargedCents: Cents): Promise<void>;
  };

  pricing: {
    deliveryFee(input: {
      pallets: number; floor: number; hasLift: boolean; surge: number; mode: DeliveryMode;
    }): Promise<Cents>;
    ticketGapDecision(orderId: string, itemsActualCents: Cents): Promise<GapDecisionRow>;
  };

  payments: {
    insert(input: {
      orderId: string; provider: string; providerRef: string; method: string;
      amountAuthorizedCents: Cents; idempotencyKey: string;
    }): Promise<PaymentRow>;
    byProviderRef(providerRef: string): Promise<PaymentRow | null>;
    byIdempotencyKey(key: string): Promise<PaymentRow | null>;
    applyEvent(input: {
      providerRef: string; status: string; amountCents: Cents;
      scaCompleted: boolean; failureReason?: string;
    }): Promise<void>;
    refund(input: {
      paymentId: string; amountCents: Cents; reason: string; issuedBy: string | null;
      providerRef: string | null;
    }): Promise<void>;
  };

  dispatch: {
    candidates(orderId: string): Promise<readonly CandidateRow[]>;
    createMission(input: { storeId: string }): Promise<{ id: string }>;
    attachOrder(missionId: string, orderId: string): Promise<void>;
    offer(missionId: string, courierId: string, score: number): Promise<{ id: string }>;
    respondToOffer(offerId: string, status: 'accepted' | 'declined' | 'expired', reason?: string): Promise<void>;
    assign(missionId: string, courierId: string, shiftBookingId: string | null): Promise<void>;
    activeShiftBooking(courierId: string): Promise<string | null>;
  };

  delivery: {
    recordAgeCheck(input: {
      orderId: string; courierId: string; result: 'ok' | 'refused';
      reason?: string; documentChecked: boolean; sober: boolean;
    }): Promise<{ id: string }>;
    deliver(orderId: string, courierId: string, pin: string): Promise<void>;
    saveReceipt(input: {
      orderId: string; missionId: string | null; photoPath: string;
      amountReadCents: Cents | null; amountValidatedCents: Cents; validatedBy: string;
    }): Promise<void>;
  };

  users: {
    recordVerification(input: {
      userId: string; bracket: AgeBracket; method: string; verifiedAt: Date;
    }): Promise<void>;
    activate(userId: string): Promise<void>;
  };
}
