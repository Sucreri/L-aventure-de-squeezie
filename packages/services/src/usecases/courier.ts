/**
 * The courier journey (spec 7).
 *
 * Two things shape this file.
 *
 * First, the prerequisites are NOT checked here. Training, signed contract,
 * confirmed Dimona, working-time limits and shift capacity are all enforced by
 * guards in Postgres. These functions call and translate; re-checking in the
 * service layer would create a second source of truth that could drift.
 *
 * Second, every mutating action is IDEMPOTENT. The courier app works offline
 * (spec 18) and replays its queue on reconnection. Without this, a replay
 * would record a second age check or accept the same mission twice. The app
 * generates the action id; the server recognises one it has already performed
 * and returns the original outcome instead of acting again.
 */

import type { Database, TransportMode, QuizResultRow, MissionDetailRow } from '../ports/database.ts';
import type { Clock } from '../ports/clock.ts';
import type { ReceiptReader } from '../ports/receipt-reader.ts';
import type { PaymentProvider } from '../ports/payment.ts';
import { refusalAware, RuleRefusedError } from '../errors.ts';
import { settleTicket, type SettleOutcome } from './settle-ticket.ts';

export interface CourierDeps {
  readonly db: Database;
  readonly clock: Clock;
}

/**
 * Runs an action once, however many times it is submitted.
 *
 * The stored result is returned verbatim on a replay, so the app sees the same
 * answer it would have seen had the first attempt reached it.
 */
export async function idempotent<T>(
  deps: CourierDeps,
  input: { actionId?: string; courierId: string; kind: string },
  run: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!input.actionId) {
    return { result: await run(), replayed: false };
  }

  const recalled = await deps.db.courier.recallAction(input.actionId);
  if (recalled) {
    if (recalled.kind !== input.kind) {
      throw new Error(
        `cet identifiant d'action a déjà servi pour « ${recalled.kind} »`);
    }
    return { result: recalled.result as T, replayed: true };
  }

  const result = await run();

  await deps.db.courier.rememberAction({
    actionId: input.actionId,
    courierId: input.courierId,
    kind: input.kind,
    result: result as unknown,
  });

  return { result, replayed: false };
}

// ---------------------------------------------------------------- onboarding

export interface OnboardingStatus {
  readonly applied: boolean;
  readonly trainingPassed: boolean;
  readonly contractSigned: boolean;
  readonly dimonaConfirmed: boolean;
  readonly status: string;
  /** The next thing the courier has to do, in plain words. */
  readonly nextStep: string;
  readonly canWork: boolean;
}

export async function onboardingStatus(
  deps: CourierDeps,
  courierId: string,
): Promise<OnboardingStatus> {
  const profile = await deps.db.courier.profile(courierId);

  if (!profile) {
    return {
      applied: false, trainingPassed: false, contractSigned: false,
      dimonaConfirmed: false, status: 'none',
      nextStep: 'Déposer ta candidature.',
      canWork: false,
    };
  }

  const trainingPassed = profile.trainingPassedAt !== null;
  const canWork = profile.status === 'active'
    && trainingPassed && profile.contractSigned && profile.dimonaConfirmed;

  const nextStep = !trainingPassed
    ? 'Passer la formation obligatoire.'
    : !profile.contractSigned
      ? 'Signer ton contrat d\'occupation d\'étudiant.'
      : !profile.dimonaConfirmed
        ? 'Attendre la confirmation de ta déclaration Dimona par l\'équipe.'
        : 'Réserver un créneau.';

  return {
    applied: true,
    trainingPassed,
    contractSigned: profile.contractSigned,
    dimonaConfirmed: profile.dimonaConfirmed,
    status: profile.status,
    nextStep,
    canWork,
  };
}

export async function applyAsCourier(
  deps: CourierDeps,
  input: {
    userId: string; transport: TransportMode; enrolmentProofRef: string; actionId?: string;
  },
): Promise<OnboardingStatus> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.userId, kind: 'apply' },
    async () => {
      await refusalAware(() => deps.db.courier.apply({
        userId: input.userId,
        transport: input.transport,
        // Capacity comes from the parameter for that transport, never from
        // the applicant (spec 14).
        capacityUnits: 0,
        enrolmentProofRef: input.enrolmentProofRef,
      }));
      return onboardingStatus(deps, input.userId);
    });

  return result;
}

export async function submitTraining(
  deps: CourierDeps,
  input: { courierId: string; answers: Record<string, number>; actionId?: string },
): Promise<QuizResultRow> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'training' },
    () => refusalAware(() => deps.db.courier.gradeQuiz(input.courierId, input.answers)));

  return result;
}

/**
 * Signing the student employment contract (spec 7.3).
 *
 * The signature must happen BEFORE any work, and the account only becomes
 * active once the admin has also confirmed the Dimona declaration. Both
 * conditions live in a database constraint, so this cannot be short-circuited.
 */
export async function signContract(
  deps: CourierDeps,
  input: { courierId: string; actionId?: string },
): Promise<OnboardingStatus> {
  const profile = await deps.db.courier.profile(input.courierId);

  if (!profile) throw new Error('aucune candidature pour ce compte');
  if (profile.trainingPassedAt === null) {
    throw new RuleRefusedError('courier_not_employable',
      'La formation obligatoire doit être validée avant la signature du contrat.',
      'training not passed');
  }

  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'sign_contract' },
    async () => {
      await refusalAware(() => deps.db.courier.signContract(input.courierId));
      return onboardingStatus(deps, input.courierId);
    });

  return result;
}

// ---------------------------------------------------------------- shifts

export async function bookShift(
  deps: CourierDeps,
  input: { courierId: string; shiftId: string; actionId?: string },
): Promise<{ bookingId: string }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'book_shift' },
    () => refusalAware(() => deps.db.courier.bookShift(input.shiftId, input.courierId)));

  return result;
}

export async function cancelShiftBooking(
  deps: CourierDeps,
  input: { courierId: string; shiftId: string; actionId?: string },
): Promise<{ cancelled: true }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'cancel_shift' },
    async () => {
      await refusalAware(() => deps.db.courier.cancelBooking(input.shiftId, input.courierId));
      return { cancelled: true as const };
    });

  return result;
}

// ---------------------------------------------------------------- mission

export type MissionStep =
  | 'go_to_store' | 'shop' | 'pay_and_photograph' | 'travel' | 'handover' | 'done';

export interface GuidedMission {
  readonly mission: MissionDetailRow;
  readonly step: MissionStep;
  readonly instruction: string;
}

/**
 * The mission as the courier app shows it: the data, plus where they are in
 * the sequence and what to do next.
 *
 * The step is derived from the mission status rather than held in the app, so
 * a courier who reinstalls, or whose phone dies mid-mission, resumes exactly
 * where they were (spec 18: "reprise après crash").
 */
export async function guidedMission(
  deps: CourierDeps,
  courierId: string,
): Promise<GuidedMission | null> {
  const mission = await deps.db.courier.currentMission(courierId);
  if (!mission) return null;

  const step: MissionStep =
    mission.status === 'assigned' ? 'go_to_store'
    : mission.status === 'at_store' ? 'shop'
    : mission.status === 'purchased' ? 'travel'
    : mission.status === 'en_route' ? 'handover'
    : 'done';

  const instruction = {
    go_to_store: `Rends-toi au ${mission.storeName}, ${mission.storeStreet} ${mission.storeNumber}.`,
    shop: 'Coche les articles au fur et à mesure. Si un article manque, signale-le : le client a quelques minutes pour répondre.',
    pay_and_photograph: 'Paie avec la carte de dépense, puis photographie le ticket.',
    travel: 'Direction le kot. Ta position est partagée avec le client pendant le trajet.',
    handover: 'À la porte : contrôle l\'âge si la commande contient de l\'alcool, puis demande le code PIN.',
    done: 'Mission terminée.',
  }[step];

  return { mission, step, instruction };
}

export async function arriveAtStore(
  deps: CourierDeps,
  input: { courierId: string; missionId: string; actionId?: string },
): Promise<{ step: MissionStep }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'at_store' },
    async () => {
      const mission = await deps.db.courier.currentMission(input.courierId);
      if (!mission || mission.missionId !== input.missionId) {
        throw new Error('cette mission ne t\'est pas attribuée');
      }

      for (const order of mission.orders) {
        await refusalAware(() => deps.db.orders.setStatus(order.orderId, 'AT_STORE', {
          id: input.courierId, role: 'courier', reason: 'arrivé au magasin',
        }));
      }

      await deps.db.courier.setMissionStatus(input.missionId, 'at_store');
      return { step: 'shop' as const };
    });

  return result;
}

/**
 * Raising a substitution (spec 6.5, 7.6).
 *
 * The courier never decides what happens to the line. They report the problem;
 * the client answers within the configured window, and failing that the rule
 * the client chose at checkout applies. Both the window and the fallback are
 * enforced by the database.
 */
export async function requestSubstitution(
  deps: CourierDeps,
  input: {
    courierId: string; orderItemId: string;
    reason: 'out_of_stock' | 'price_gap' | 'other';
    proposedLabel?: string; proposedPriceCents?: number;
    actionId?: string;
  },
): Promise<{ requestId: string; expiresAt: Date; waitSeconds: number }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'substitution' },
    async () => {
      const request = await refusalAware(() => deps.db.courier.requestSubstitution({
        orderItemId: input.orderItemId,
        courierId: input.courierId,
        reason: input.reason,
        ...(input.proposedLabel === undefined ? {} : { proposedLabel: input.proposedLabel }),
        ...(input.proposedPriceCents === undefined
          ? {} : { proposedPriceCents: input.proposedPriceCents }),
      }));

      const waitSeconds = Math.max(
        0, Math.round((new Date(request.expiresAt).getTime() - deps.clock.now().getTime()) / 1000));

      return { requestId: request.id, expiresAt: request.expiresAt, waitSeconds };
    });

  return result;
}

/** Applies the client's default rule once the window has closed. */
export async function applyDefaultSubstitution(
  deps: CourierDeps,
  input: { courierId: string; requestId: string; actionId?: string },
): Promise<{ outcome: string }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'substitution_default' },
    async () => {
      const resolved = await refusalAware(
        () => deps.db.courier.resolveSubstitution(input.requestId, null));
      return { outcome: resolved.outcome };
    });

  return result;
}

/**
 * Paying and photographing the receipt (spec 7.6 and 10).
 *
 * Delegates the money decisions to settleTicket, which owns the gap rules.
 * The mission only moves to PURCHASED once the amount is settled, because an
 * order that left the shop without a validated receipt would have nothing to
 * reconcile against (spec 4.5).
 */
export async function recordReceipt(
  deps: CourierDeps & { payments: PaymentProvider; receipts: ReceiptReader },
  input: {
    courierId: string; missionId: string; orderId: string;
    photoPath: string; amountOverrideCents?: number; actionId?: string;
  },
): Promise<SettleOutcome & { step: MissionStep }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'receipt' },
    async () => {
      const outcome = await settleTicket(
        { db: deps.db, payments: deps.payments, receipts: deps.receipts },
        {
          orderId: input.orderId,
          courierId: input.courierId,
          photoPath: input.photoPath,
          ...(input.amountOverrideCents === undefined
            ? {} : { amountOverrideCents: input.amountOverrideCents }),
        });

      if (outcome.kind !== 'settled') {
        // Either the reading was unreliable, or the overrun needs the
        // client's agreement. Either way the mission does not move on.
        return { ...outcome, step: 'pay_and_photograph' as const };
      }

      await refusalAware(() => deps.db.orders.setStatus(input.orderId, 'PURCHASED', {
        id: input.courierId, role: 'courier', reason: 'articles achetés, ticket validé',
      }));
      await deps.db.courier.setMissionStatus(input.missionId, 'purchased');

      return { ...outcome, step: 'travel' as const };
    });

  return result;
}

export async function departForDelivery(
  deps: CourierDeps,
  input: { courierId: string; missionId: string; orderId: string; actionId?: string },
): Promise<{ step: MissionStep }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'depart' },
    async () => {
      await refusalAware(() => deps.db.orders.setStatus(input.orderId, 'EN_ROUTE', {
        id: input.courierId, role: 'courier', reason: 'départ vers le kot',
      }));
      await deps.db.courier.setMissionStatus(input.missionId, 'en_route');
      return { step: 'handover' as const };
    });

  return result;
}

export async function announceArrival(
  deps: CourierDeps,
  input: { courierId: string; orderId: string; actionId?: string },
): Promise<{ step: MissionStep }> {
  const { result } = await idempotent(
    deps, { ...(input.actionId ? { actionId: input.actionId } : {}), courierId: input.courierId, kind: 'arrive' },
    async () => {
      await refusalAware(() => deps.db.orders.setStatus(input.orderId, 'ARRIVED', {
        id: input.courierId, role: 'courier', reason: 'arrivé à l\'adresse',
      }));
      return { step: 'handover' as const };
    });

  return result;
}

// ---------------------------------------------------------------- pay

export interface EarningsSummary {
  readonly period: { from: Date; to: Date };
  readonly estimate: Awaited<ReturnType<Database['courier']['earnings']>>;
  readonly quota: Awaited<ReturnType<Database['courier']['quotaStatus']>>;
  /** Shown verbatim: this is an estimate, not a payslip (spec 7.8). */
  readonly disclaimer: string;
}

export async function earningsSummary(
  deps: CourierDeps,
  input: { courierId: string; from: Date; to: Date },
): Promise<EarningsSummary> {
  const [estimate, quota] = await Promise.all([
    deps.db.courier.earnings(input.courierId, input.from, input.to),
    deps.db.courier.quotaStatus(input.courierId),
  ]);

  return {
    period: { from: input.from, to: input.to },
    estimate,
    quota,
    disclaimer:
      'Estimation. Ta paie officielle et ta fiche de paie viennent du secrétariat '
      + 'social, qui applique les cotisations et le précompte. Le compteur de '
      + 'quota ne connaît que les heures prestées ici : si tu travailles ailleurs, '
      + 'vérifie ton solde réel sur Student@work.',
  };
}
