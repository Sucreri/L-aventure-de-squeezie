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
    /** Couriers already offered this mission, in any state. */
    offeredCouriers(missionId: string): Promise<readonly string[]>;
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

  courier: {
    profile(courierId: string): Promise<CourierProfileRow | null>;
    apply(input: {
      userId: string; transport: TransportMode; capacityUnits: number;
      enrolmentProofRef: string;
    }): Promise<void>;

    quiz(seed: number): Promise<readonly QuizQuestionRow[]>;
    gradeQuiz(courierId: string, answers: Record<string, number>): Promise<QuizResultRow>;

    signContract(courierId: string): Promise<void>;
    confirmDimona(courierId: string, adminId: string): Promise<void>;

    openShifts(courierId: string): Promise<readonly ShiftRow[]>;
    bookShift(shiftId: string, courierId: string): Promise<{ bookingId: string }>;
    cancelBooking(shiftId: string, courierId: string): Promise<void>;
    bookings(courierId: string): Promise<readonly BookingRow[]>;

    offers(courierId: string): Promise<readonly OfferRow[]>;
    currentMission(courierId: string): Promise<MissionDetailRow | null>;
    setMissionStatus(missionId: string, status: string): Promise<void>;

    requestSubstitution(input: {
      orderItemId: string; courierId: string;
      reason: 'out_of_stock' | 'price_gap' | 'other';
      proposedLabel?: string; proposedPriceCents?: number;
    }): Promise<SubstitutionRow>;
    resolveSubstitution(requestId: string, answer: string | null): Promise<SubstitutionRow>;
    pendingSubstitutions(orderId: string): Promise<readonly SubstitutionRow[]>;

    recordPosition(input: {
      courierId: string; bookingId: string; lat: number; lon: number;
    }): Promise<void>;

    hours(courierId: string, from: Date, to: Date): Promise<number>;
    quotaStatus(courierId: string): Promise<QuotaRow>;
    earnings(courierId: string, from: Date, to: Date): Promise<EarningsRow>;

    /**
     * Offline replay guard (spec 18).
     *
     * Returns the stored result when this action id has already been
     * performed, so a queued action replayed on reconnection is recognised
     * rather than applied a second time.
     */
    recallAction(actionId: string): Promise<{ kind: string; result: unknown } | null>;
    rememberAction(input: {
      actionId: string; courierId: string; kind: string; result: unknown;
    }): Promise<void>;
  };
}

export type TransportMode = 'foot_trolley' | 'bike_trailer' | 'cargo_bike';

export interface CourierProfileRow {
  readonly userId: string;
  readonly courierModel: string;
  readonly transport: TransportMode;
  readonly capacityUnits: number;
  readonly trainingPassedAt: Date | null;
  readonly contractSigned: boolean;
  readonly dimonaConfirmed: boolean;
  readonly status: string;
}

export interface QuizQuestionRow {
  readonly questionId: string;
  readonly topic: string;
  readonly prompt: string;
  readonly choices: readonly string[];
}

export interface QuizResultRow {
  readonly score: number;
  readonly total: number;
  readonly passed: boolean;
  readonly wrong: readonly { questionId: string; prompt: string; explanation: string }[];
}

export interface ShiftRow {
  readonly id: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly places: number;
  readonly taken: number;
  readonly nightDerogation: boolean;
  readonly peakBonusCents: Cents;
  readonly bookedByMe: boolean;
}

export interface BookingRow {
  readonly id: string;
  readonly shiftId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly zoneName: string;
  readonly cancelledAt: Date | null;
}

export interface OfferRow {
  readonly offerId: string;
  readonly missionId: string;
  readonly score: number;
  readonly offeredAt: Date;
  readonly storeName: string;
  readonly orderReference: string;
  readonly itemCount: number;
  readonly totalWeightKg: number;
  readonly floor: number;
  readonly hasLift: boolean;
  readonly distanceM: number | null;
  readonly estimatedBonusCents: Cents;
}

export interface MissionItemRow {
  readonly orderItemId: string;
  readonly productName: string;
  readonly format: string;
  readonly quantity: number;
  readonly indicativePriceCents: Cents;
  readonly containsAlcohol: boolean;
  readonly substitutionRule: string;
  readonly fulfilled: boolean;
  readonly refunded: boolean;
}

export interface MissionDetailRow {
  readonly missionId: string;
  readonly status: string;
  readonly storeName: string;
  readonly storeStreet: string;
  readonly storeNumber: string;
  readonly orders: readonly {
    orderId: string;
    reference: string;
    status: string;
    street: string;
    number: string;
    building: string | null;
    floor: number;
    hasLift: boolean;
    room: string | null;
    instructions: string | null;
    noteForCourier: string | null;
    containsAlcohol: boolean;
    items: readonly MissionItemRow[];
  }[];
  readonly spendCardCeilingCents: Cents;
}

export interface SubstitutionRow {
  readonly id: string;
  readonly orderItemId: string;
  readonly reason: string;
  readonly outcome: string;
  readonly askedAt: Date;
  readonly expiresAt: Date;
  readonly answeredAt: Date | null;
}

export interface QuotaRow {
  readonly year: number;
  readonly hoursWithOperator: number;
  readonly quotaHours: number;
  readonly alertThresholdHours: number;
  readonly alerting: boolean;
}

export interface EarningsRow {
  readonly hours: number;
  readonly hourlyWageCents: Cents;
  readonly wageCents: Cents;
  readonly deliveries: number;
  readonly deliveryBonusCents: Cents;
  readonly floorBonusCents: Cents;
  readonly tipsCents: Cents;
  readonly totalCents: Cents;
}
