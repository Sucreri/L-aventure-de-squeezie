/**
 * The courier side of the API (spec 7).
 *
 * Every route runs under `withUser`, so Row Level Security applies: a courier
 * sees their own profile, their own bookings, the offers addressed to them and
 * the orders on their current mission — and nothing else.
 *
 * Mutating routes accept an `actionId`. The courier app queues actions while
 * offline and replays them on reconnection (spec 18); the server recognises an
 * id it has already handled and returns the original outcome rather than
 * acting twice.
 */

import type { Database, Clock, ReceiptReader, PaymentProvider } from '@palette/services';
import {
  onboardingStatus, applyAsCourier, submitTraining, signContract,
  bookShift, cancelShiftBooking, guidedMission, arriveAtStore,
  requestSubstitution, applyDefaultSubstitution, recordReceipt,
  departForDelivery, announceArrival, earningsSummary,
  recordAgeCheck, completeHandover, failDelivery,
  RuleRefusedError,
} from '@palette/services';
import { Router, badRequest, notFound, forbidden, type RequestContext } from './http.ts';

export interface CourierRouteDeps {
  readonly clock: Clock;
  readonly receipts: ReceiptReader;
  readonly payments: PaymentProvider;
  /** Runs the handler as the signed-in user, with RLS enforced. */
  withUser<T>(ctx: RequestContext, fn: (db: Database, userId: string) => Promise<T>): Promise<T>;
  /**
   * Runs the handler with the system's own rights, bypassing RLS.
   *
   * Used by exactly one route: settling a till receipt, which captures or
   * refunds money. A courier legitimately triggers that, but a courier must
   * not hold write access to `payments` or `refunds` — what a provider said
   * about money is the system's record, not a claim either party can make.
   *
   * The route checks that the courier owns the mission BEFORE crossing this
   * boundary, under their own role.
   */
  withServiceRole<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

type Body = Record<string, unknown> | undefined;

const str = (body: Body, name: string): string => {
  const value = body?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`Le champ « ${name} » est obligatoire.`);
  }
  return value.trim();
};

const maybeStr = (body: Body, name: string): string | undefined => {
  const value = body?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

/** Turns a rule refusal into a response the courier app can act on. */
function asHttp(error: unknown): never {
  if (error instanceof RuleRefusedError) {
    throw badRequest(error.userMessage, { kind: error.kind });
  }
  throw error;
}

export function registerCourierRoutes(router: Router, deps: CourierRouteDeps): Router {
  const { withUser } = deps;

  const base = (db: Database) => ({ db, clock: deps.clock });

  // ---------------------------------------------------------------- onboarding

  router.get('/courier/me', async ctx =>
    withUser(ctx, async (db, userId) => {
      const [status, profile] = await Promise.all([
        onboardingStatus(base(db), userId),
        db.courier.profile(userId),
      ]);
      return { status: 200, body: { onboarding: status, profile } };
    }));

  router.post('/courier/apply', async ctx =>
    withUser(ctx, async (db, userId) => {
      const body = ctx.body as Body;
      const transport = str(body, 'transport');

      if (!['foot_trolley', 'bike_trailer', 'cargo_bike'].includes(transport)) {
        throw badRequest('Moyen de transport inconnu.');
      }

      try {
        const status = await applyAsCourier(base(db), {
          userId,
          transport: transport as 'foot_trolley' | 'bike_trailer' | 'cargo_bike',
          enrolmentProofRef: str(body, 'enrolmentProofRef'),
          ...(maybeStr(body, 'actionId') ? { actionId: maybeStr(body, 'actionId')! } : {}),
        });
        return { status: 201, body: status };
      } catch (error) { asHttp(error); }
    }));

  /** The quiz without the answer key — the server grades it (spec 7.2). */
  router.get('/courier/training', async ctx =>
    withUser(ctx, async (db, userId) => {
      // A per-courier seed so the choice order is stable across a reload but
      // differs between people.
      const seed = Number.parseInt(userId.replace(/\D/g, '').slice(0, 6) || '0', 10);
      const questions = await db.courier.quiz(seed);
      return { status: 200, body: { questions } };
    }));

  router.post('/courier/training', async ctx =>
    withUser(ctx, async (db, userId) => {
      const answers = (ctx.body as Body)?.['answers'];
      if (!answers || typeof answers !== 'object') {
        throw badRequest('Aucune réponse fournie.');
      }

      try {
        const result = await submitTraining(base(db), {
          courierId: userId,
          answers: answers as Record<string, number>,
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  /**
   * The student employment contract, filled from parameters.
   *
   * Marked as a template awaiting legal validation, because it is one: the
   * official model comes from the social secretariat (see docs/legal/06).
   */
  router.get('/courier/contract', async ctx =>
    withUser(ctx, async (db, userId) => {
      const profile = await db.courier.profile(userId);
      if (!profile) throw notFound('Aucune candidature pour ce compte.');

      const [operator, address, vat, bce, jointCommittee, insurance, prevention, workRules] =
        await Promise.all([
          db.settings.text('operator.legal_name'),
          db.settings.text('operator.address'),
          db.settings.text('operator.vat_number'),
          db.settings.text('operator.bce_number'),
          db.settings.text('pay.joint_committee_ref'),
          db.settings.text('labour.work_accident_insurance_ref'),
          db.settings.text('labour.prevention_service_ref'),
          db.settings.text('labour.work_rules_document_id'),
        ]);

      // Spec 11: no default wage exists; the parameter raises when unset, and
      // the shift guard blocks work until it is filled.
      let hourlyWageCents: number | null = null;
      try { hourlyWageCents = await db.settings.int('pay.hourly_wage_cents'); } catch { /* unset */ }

      return {
        status: 200,
        body: {
          awaitingLegalValidation: true,
          employer: { legalName: operator, address, vatNumber: vat, bceNumber: bce },
          jointCommittee,
          hourlyWageCents,
          bonuses: {
            perDeliveryCents: await db.settings.int('pay.bonus_per_delivery_cents'),
            perFloorCents: await db.settings.int('pay.bonus_per_floor_cents'),
            tipsShare: await db.settings.num('pay.tips_share_to_courier'),
          },
          workingTime: {
            serviceEndTime: await db.settings.text('work.service_end_time'),
            nightThreshold: await db.settings.text('work.night_work_threshold_time'),
            maxHoursPerDay: await db.settings.int('work.max_hours_per_day'),
            maxHoursPerWeek: await db.settings.int('work.max_hours_per_week'),
            annualQuotaHours: await db.settings.int('work.annual_quota_hours'),
          },
          employerObligations: { insurance, prevention, workRules },
          transport: profile.transport,
          capacityUnits: profile.capacityUnits,
        },
      };
    }));

  router.post('/courier/contract/sign', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const status = await signContract(base(db), {
          courierId: userId,
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: status };
      } catch (error) { asHttp(error); }
    }));

  // ---------------------------------------------------------------- shifts

  router.get('/courier/shifts', async ctx =>
    withUser(ctx, async (db, userId) => ({
      status: 200,
      body: { shifts: await db.courier.openShifts(userId) },
    })));

  router.get('/courier/bookings', async ctx =>
    withUser(ctx, async (db, userId) => ({
      status: 200,
      body: { bookings: await db.courier.bookings(userId) },
    })));

  router.post('/courier/shifts/:id/book', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const booked = await bookShift(base(db), {
          courierId: userId, shiftId: ctx.params['id']!,
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 201, body: booked };
      } catch (error) { asHttp(error); }
    }));

  router.post('/courier/shifts/:id/cancel', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const cancelled = await cancelShiftBooking(base(db), {
          courierId: userId, shiftId: ctx.params['id']!,
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: cancelled };
      } catch (error) { asHttp(error); }
    }));

  // ---------------------------------------------------------------- offers

  router.get('/courier/offers', async ctx =>
    withUser(ctx, async (db, userId) => ({
      status: 200,
      body: { offers: await db.courier.offers(userId) },
    })));

  router.post('/courier/offers/:id/accept', async ctx =>
    withUser(ctx, async db => {
      try {
        // One atomic call: the mission row is locked, so of two couriers
        // tapping accept on a broadcast mission, the first wins and the
        // second is told it is gone (migration 0029).
        const accepted = await db.courier.acceptOffer(ctx.params['id']!);
        return { status: 200, body: { kind: 'assigned', ...accepted } };
      } catch (error) {
        const message = String((error as Error).message);
        if (/offer not found/i.test(message)) {
          throw notFound("Cette offre n'est plus disponible.");
        }
        if (/already been taken/i.test(message)) {
          throw badRequest('Cette mission vient d\'être prise par un autre palettier.',
                           { kind: 'mission_taken' });
        }
        if (/no longer open/i.test(message)) {
          throw badRequest("Cette offre n'est plus ouverte.", { kind: 'offer_closed' });
        }
        if (/no active shift booking/i.test(message)) {
          throw badRequest('Tu dois être en créneau réservé pour accepter une mission.',
                           { kind: 'no_shift' });
        }
        asHttp(error);
      }
    }));

  /** Declining carries no penalty of any kind (spec 7.5 and 15). */
  router.post('/courier/offers/:id/decline', async ctx =>
    withUser(ctx, async (db, userId) => {
      const offers = await db.courier.offers(userId);
      const offer = offers.find(o => o.offerId === ctx.params['id']);
      if (!offer) throw notFound('Cette offre n\'est plus disponible.');

      await db.dispatch.respondToOffer(
        offer.offerId, 'declined', maybeStr(ctx.body as Body, 'reason'));

      return {
        status: 200,
        body: {
          declined: true,
          message: 'Offre refusée. Aucune conséquence : refuser n\'entraîne aucune sanction.',
        },
      };
    }));

  // ---------------------------------------------------------------- mission

  router.get('/courier/mission', async ctx =>
    withUser(ctx, async (db, userId) => {
      const guided = await guidedMission(base(db), userId);
      if (!guided) return { status: 200, body: { mission: null } };

      // Substitutions still waiting on the client, so the app can show the
      // countdown rather than letting the courier stand there guessing.
      const pending = [];
      for (const order of guided.mission.orders) {
        pending.push(...await db.courier.pendingSubstitutions(order.orderId));
      }

      return { status: 200, body: { ...guided, pendingSubstitutions: pending } };
    }));

  router.post('/courier/mission/at-store', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const result = await arriveAtStore(base(db), {
          courierId: userId, missionId: str(ctx.body as Body, 'missionId'),
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  router.post('/courier/mission/substitutions', async ctx =>
    withUser(ctx, async (db, userId) => {
      const body = ctx.body as Body;
      const reason = str(body, 'reason');

      if (!['out_of_stock', 'price_gap', 'other'].includes(reason)) {
        throw badRequest('Motif de remplacement inconnu.');
      }

      try {
        const result = await requestSubstitution(base(db), {
          courierId: userId,
          orderItemId: str(body, 'orderItemId'),
          reason: reason as 'out_of_stock' | 'price_gap' | 'other',
          ...(maybeStr(body, 'proposedLabel')
            ? { proposedLabel: maybeStr(body, 'proposedLabel')! } : {}),
          ...(typeof body?.['proposedPriceCents'] === 'number'
            ? { proposedPriceCents: body['proposedPriceCents'] } : {}),
          ...(maybeStr(body, 'actionId') ? { actionId: maybeStr(body, 'actionId')! } : {}),
        });
        return { status: 201, body: result };
      } catch (error) { asHttp(error); }
    }));

  router.post('/courier/mission/substitutions/:id/default', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const result = await applyDefaultSubstitution(base(db), {
          courierId: userId, requestId: ctx.params['id']!,
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  /**
   * Paying and photographing the till receipt (spec 7.6 and 10).
   *
   * Two phases, on purpose. The courier's ownership of the mission is checked
   * under THEIR role, so Row Level Security decides whether this mission is
   * theirs. Only then does the settlement run with the system's rights,
   * because it captures or refunds money — and a courier holds no write
   * access to payments or refunds.
   */
  router.post('/courier/mission/receipt', async ctx => {
    const body = ctx.body as Body;
    const missionId = str(body, 'missionId');
    const orderId = str(body, 'orderId');
    const photoPath = str(body, 'photoPath');

    const courierId = await withUser(ctx, async (db, userId) => {
      const mission = await db.courier.currentMission(userId);

      if (!mission || mission.missionId !== missionId) {
        throw notFound("Cette mission ne t'est pas attribuée.");
      }
      if (!mission.orders.some(o => o.orderId === orderId)) {
        throw notFound('Cette commande ne fait pas partie de ta mission.');
      }

      return userId;
    });

    try {
      const result = await deps.withServiceRole(db => recordReceipt(
        { db, clock: deps.clock, payments: deps.payments, receipts: deps.receipts },
        {
          courierId,
          missionId,
          orderId,
          photoPath,
          ...(typeof body?.['amountOverrideCents'] === 'number'
            ? { amountOverrideCents: body['amountOverrideCents'] } : {}),
          ...(maybeStr(body, 'actionId') ? { actionId: maybeStr(body, 'actionId')! } : {}),
        }));
      return { status: 200, body: result };
    } catch (error) { asHttp(error); }
  });

  router.post('/courier/mission/depart', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const result = await departForDelivery(base(db), {
          courierId: userId,
          missionId: str(ctx.body as Body, 'missionId'),
          orderId: str(ctx.body as Body, 'orderId'),
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  router.post('/courier/mission/arrive', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const result = await announceArrival(base(db), {
          courierId: userId, orderId: str(ctx.body as Body, 'orderId'),
          ...(maybeStr(ctx.body as Body, 'actionId')
            ? { actionId: maybeStr(ctx.body as Body, 'actionId')! } : {}),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  // ---------------------------------------------------------------- handover

  /**
   * The age check at the door (spec 13.2).
   *
   * Note what the request carries: two booleans and an optional reason. The
   * year the courier read is computed against in their app and never sent, so
   * it cannot be stored here even by mistake.
   */
  router.post('/courier/orders/:id/age-check', async ctx =>
    withUser(ctx, async (db, userId) => {
      const body = ctx.body as Body;
      try {
        const result = await recordAgeCheck({ db }, {
          orderId: ctx.params['id']!,
          courierId: userId,
          documentChecked: Boolean(body?.['documentChecked']),
          personAppearsSober: Boolean(body?.['personAppearsSober']),
          ...(maybeStr(body, 'refusalReason')
            ? { refusalReason: maybeStr(body, 'refusalReason') as
                'age_not_proven' | 'underage' | 'visibly_intoxicated' | 'recipient_absent' | 'other' }
            : {}),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  router.post('/courier/orders/:id/deliver', async ctx =>
    withUser(ctx, async (db, userId) => {
      const outcome = await completeHandover({ db }, {
        orderId: ctx.params['id']!,
        courierId: userId,
        pin: str(ctx.body as Body, 'pin'),
      });
      return { status: outcome.delivered ? 200 : 400, body: outcome };
    }));

  router.post('/courier/orders/:id/fail', async ctx =>
    withUser(ctx, async (db, userId) => {
      try {
        const result = await failDelivery({ db }, {
          orderId: ctx.params['id']!,
          courierId: userId,
          reason: str(ctx.body as Body, 'reason'),
          holdAtHub: Boolean((ctx.body as Body)?.['holdAtHub']),
        });
        return { status: 200, body: result };
      } catch (error) { asHttp(error); }
    }));

  // ---------------------------------------------------------------- misc

  /**
   * Position, only during a booked shift.
   *
   * The booking is resolved server-side rather than taken from the request:
   * a courier could otherwise send a booking id that is not theirs, or one
   * from a shift that has ended. The database refuses both, but resolving it
   * here means the app never has to know a booking id at all.
   */
  router.post('/courier/position', async ctx =>
    withUser(ctx, async (db, userId) => {
      const body = ctx.body as Body;
      const lat = Number(body?.['lat']);
      const lon = Number(body?.['lon']);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw badRequest('Position invalide.');
      }

      const bookingId = await db.dispatch.activeShiftBooking(userId);
      if (!bookingId) {
        throw forbidden(
          "Aucun créneau en cours : ta position n'est pas partagée en dehors d'un créneau réservé.");
      }

      try {
        await db.courier.recordPosition({ courierId: userId, bookingId, lat, lon });
        return { status: 201, body: { recorded: true } };
      } catch (error) { asHttp(error); }
    }));

  router.get('/courier/earnings', async ctx =>
    withUser(ctx, async (db, userId) => {
      const days = Number(ctx.query.get('days') ?? 30);
      const to = deps.clock.now();
      const from = new Date(to.getTime() - Math.min(Math.max(days, 1), 400) * 86_400_000);

      const summary = await earningsSummary(base(db), { courierId: userId, from, to });
      return { status: 200, body: summary };
    }));

  /** Spec 7.9: a direct line to the team, not a chatbot. */
  router.post('/courier/help', async ctx =>
    withUser(ctx, async (db, userId) => {
      const contact = await db.settings.text('courier.help_contact');
      const description = maybeStr(ctx.body as Body, 'description')
        ?? 'Demande d\'aide depuis l\'app palettier';

      const mission = await db.courier.currentMission(userId);

      return {
        status: 200,
        body: {
          contact,
          missionId: mission?.missionId ?? null,
          message: 'L\'équipe est joignable directement. Tu peux mettre ta mission en pause.',
          description,
        },
      };
    }));

  return router;
}
