/**
 * Handover (spec 13).
 *
 * The order is strict and enforced by the database: age check first, PIN
 * second. This use case exists to give the courier app one call per step and
 * to turn a refusal into a message, not to decide anything.
 */

import type { Database } from '../ports/database.ts';
import type { NotificationSender } from '../ports/notifications.ts';
import { refusalAware, RuleRefusedError, translateDatabaseError } from '../errors.ts';

export interface DeliveryDeps {
  readonly db: Database;
  readonly notifications?: NotificationSender;
}

export type AgeRefusalReason =
  | 'age_not_proven' | 'underage' | 'visibly_intoxicated' | 'recipient_absent' | 'other';

export interface AgeCheckCommand {
  readonly orderId: string;
  readonly courierId: string;
  /** Spec 13.2: the courier looked at the document. */
  readonly documentChecked: boolean;
  /** Spec 13.2: "personne en état normal". */
  readonly personAppearsSober: boolean;
  readonly refusalReason?: AgeRefusalReason;
}

export interface AgeCheckOutcome {
  readonly ageCheckId: string;
  readonly passed: boolean;
  /** What the courier app should do next. */
  readonly next: 'ask_pin' | 'delivery_failed';
  readonly message: string;
}

/**
 * Records the age check at the door.
 *
 * Refusing is never penalised (spec 13.5) and the database stores only the
 * outcome, the reason, the time and the courier — never the year the courier
 * read, never a photograph.
 */
export async function recordAgeCheck(
  deps: DeliveryDeps,
  command: AgeCheckCommand,
): Promise<AgeCheckOutcome> {
  const passed = command.documentChecked
    && command.personAppearsSober
    && command.refusalReason === undefined;

  const result = await refusalAware(() => deps.db.delivery.recordAgeCheck({
    orderId: command.orderId,
    courierId: command.courierId,
    result: passed ? 'ok' : 'refused',
    ...(passed ? {} : { reason: command.refusalReason ?? 'age_not_proven' }),
    documentChecked: command.documentChecked,
    sober: command.personAppearsSober,
  }));

  return {
    ageCheckId: result.id,
    passed,
    next: passed ? 'ask_pin' : 'delivery_failed',
    message: passed
      ? 'Contrôle validé. Demande maintenant le code PIN.'
      : "Remise refusée. Tu as eu raison : aucune sanction n'en découle.",
  };
}

export interface HandoverOutcome {
  readonly delivered: boolean;
  readonly message: string;
  readonly remainingAttempts?: number;
}

/**
 * Completes the handover with the PIN.
 *
 * Whether an age check was required and passed is decided by the database, not
 * here: app.deliver_order refuses otherwise, and a trigger refuses even a
 * direct UPDATE.
 */
export async function completeHandover(
  deps: DeliveryDeps,
  input: { orderId: string; courierId: string; pin: string },
): Promise<HandoverOutcome> {
  try {
    await deps.db.delivery.deliver(input.orderId, input.courierId, input.pin);
    return { delivered: true, message: 'Commande livrée.' };
  } catch (error) {
    // A refusal here is the system working: no age check, or a wrong PIN.
    // The courier is told which, so they know what to do next — not handed a
    // 500 at someone's door.
    const refusal = error instanceof RuleRefusedError
      ? error
      : translateDatabaseError(error);

    if (refusal) {
      return { delivered: false, message: refusal.userMessage };
    }
    throw error;
  }
}

/**
 * Handover failed (spec 12): client absent, address not found, age refused.
 * The goods are then held at the operator's premises for a parameterised
 * number of hours.
 */
export async function failDelivery(
  deps: DeliveryDeps,
  input: { orderId: string; courierId: string; reason: string; holdAtHub: boolean },
): Promise<{ status: string; message: string }> {
  const order = await deps.db.orders.byId(input.orderId);
  if (!order) throw new Error(`commande inconnue : ${input.orderId}`);

  if (order.status !== 'DELIVERY_FAILED') {
    await refusalAware(() => deps.db.orders.setStatus(input.orderId, 'DELIVERY_FAILED', {
      id: input.courierId, role: 'courier', reason: input.reason,
    }));
  }

  if (!input.holdAtHub) {
    return { status: 'DELIVERY_FAILED', message: 'Échec de remise enregistré.' };
  }

  const hours = await deps.db.settings.int('orders.hub_hold_hours');

  await refusalAware(() => deps.db.orders.setStatus(input.orderId, 'HELD_AT_HUB', {
    id: input.courierId, role: 'courier', reason: 'articles déposés au local',
  }));

  return {
    status: 'HELD_AT_HUB',
    message: `Articles gardés ${hours} h au local. Le client peut les retirer sur pièce d'identité.`,
  };
}
