/**
 * Settling an order against the actual till receipt (spec 7.6 and 10).
 *
 * The rule this implements is the one the client cares about most: they are
 * never charged more than the till receipt, and never silently charged more
 * than they agreed to.
 */

import type { Database } from '../ports/database.ts';
import type { PaymentProvider } from '../ports/payment.ts';
import type { ReceiptReader } from '../ports/receipt-reader.ts';
import { refusalAware } from '../errors.ts';

export interface SettleTicketDeps {
  readonly db: Database;
  readonly payments: PaymentProvider;
  readonly receipts: ReceiptReader;
}

export interface SettleTicketCommand {
  readonly orderId: string;
  readonly courierId: string;
  readonly photoPath: string;
  /**
   * The courier's own reading. Always wins over the OCR: a machine misreading
   * a crumpled receipt must never decide what someone is charged (spec 7.6).
   */
  readonly amountOverrideCents?: number;
}

export type SettleOutcome =
  | {
      readonly kind: 'manual_confirmation_required';
      readonly readAmountCents: number | null;
      readonly confidence: number;
      readonly message: string;
    }
  | {
      readonly kind: 'client_approval_required';
      readonly itemsActualCents: number;
      readonly extraCaptureCents: number;
      readonly operatorAbsorbsCents: number;
      readonly message: string;
    }
  | {
      readonly kind: 'settled';
      readonly itemsActualCents: number;
      readonly totalChargedCents: number;
      readonly capturedCents: number;
      readonly refundedCents: number;
      readonly operatorAbsorbsCents: number;
      readonly message: string;
    };

export async function settleTicket(
  deps: SettleTicketDeps,
  command: SettleTicketCommand,
): Promise<SettleOutcome> {
  const { db, payments, receipts } = deps;

  const order = await db.orders.byId(command.orderId);
  if (!order) throw new Error(`commande inconnue : ${command.orderId}`);

  const reading = await receipts.read(command.photoPath);
  const threshold = await db.settings.num('receipts.ocr_min_confidence');

  // Decide the authoritative amount. The courier's correction always wins.
  let validatedCents: number;
  if (command.amountOverrideCents !== undefined) {
    validatedCents = command.amountOverrideCents;
  } else if (reading.amountCents !== null && reading.confidence >= threshold) {
    validatedCents = reading.amountCents;
  } else {
    return {
      kind: 'manual_confirmation_required',
      readAmountCents: reading.amountCents,
      confidence: reading.confidence,
      message: 'La lecture automatique du ticket n\'est pas assez fiable : saisis le montant à la main.',
    };
  }

  const decision = await db.pricing.ticketGapDecision(command.orderId, validatedCents);

  // Beyond what the operator absorbs, the client must agree in the app BEFORE
  // the courier pays. Nothing is charged here (spec 10).
  if (decision.requiresClientApproval) {
    return {
      kind: 'client_approval_required',
      itemsActualCents: validatedCents,
      extraCaptureCents: decision.extraCaptureCents,
      operatorAbsorbsCents: decision.operatorAbsorbsCents,
      message: decision.explanation,
    };
  }

  await db.delivery.saveReceipt({
    orderId: command.orderId,
    missionId: null,
    photoPath: command.photoPath,
    amountReadCents: reading.amountCents,
    amountValidatedCents: validatedCents,
    validatedBy: command.courierId,
  });

  // What the client finally owes.
  //
  // The items follow the till receipt, MINUS whatever the operator absorbs:
  // absorbing an overrun means the operator pays it, so it comes off the
  // client's bill rather than being added to it. When the overrun is fully
  // absorbed, the client ends up paying exactly the estimate they saw.
  //
  // The fees never move after the quote (spec 4.6): only the items follow the
  // receipt.
  const clientItemsCents = validatedCents - decision.operatorAbsorbsCents;
  const totalChargedCents =
    clientItemsCents + order.deliveryFeeCents + order.serviceFeeCents + order.tipCents;

  const payment = await db.payments.byProviderRef(
    (await currentProviderRef(db, command.orderId)) ?? '');

  let capturedCents = 0;
  let refundedCents = 0;

  if (payment) {
    if (payment.status === 'captured' && payment.amountCapturedCents !== null) {
      // Bancontact: already debited at the estimate. Refund any difference.
      const difference = payment.amountCapturedCents - totalChargedCents;
      if (difference > 0) {
        await payments.refund({
          providerRef: payment.providerRef,
          amountCents: difference,
          reason: 'Ticket de caisse inférieur à l\'estimation',
          idempotencyKey: `order:${command.orderId}:gap-refund`,
        });
        await db.payments.refund({
          paymentId: payment.id,
          amountCents: difference,
          reason: 'Ticket de caisse inférieur à l\'estimation',
          issuedBy: null,
          providerRef: payment.providerRef,
        });
        refundedCents = difference;
      }
      capturedCents = payment.amountCapturedCents;
    } else {
      // Card: authorised with a margin, captured at the real amount.
      const event = await payments.capture({
        providerRef: payment.providerRef,
        amountCents: totalChargedCents,
        idempotencyKey: `order:${command.orderId}:capture`,
      });
      await db.payments.applyEvent({
        providerRef: event.providerRef,
        status: event.status,
        amountCents: event.amountCents,
        scaCompleted: event.scaCompleted,
      });
      capturedCents = event.amountCents;
    }
  }

  await refusalAware(() =>
    db.orders.recordActualItems(command.orderId, validatedCents, totalChargedCents));

  return {
    kind: 'settled',
    itemsActualCents: validatedCents,
    totalChargedCents,
    capturedCents,
    refundedCents,
    operatorAbsorbsCents: decision.operatorAbsorbsCents,
    message: decision.explanation,
  };
}

async function currentProviderRef(db: Database, orderId: string): Promise<string | null> {
  const payment = await db.payments.byIdempotencyKey(`order:${orderId}:initial`);
  return payment?.providerRef ?? null;
}
