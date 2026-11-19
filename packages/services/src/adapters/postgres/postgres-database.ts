/**
 * Postgres implementation of the Database port.
 *
 * Deliberately thin. Every method is a call into SQL that already enforces the
 * rules; this file adds no logic of its own. When a guard refuses, the Postgres
 * error travels up and is translated in errors.ts into something the client can
 * display, without losing the original message.
 */

import postgres from 'postgres';
import type {
  Database, PlaceOrderInput, OrderRow, Actor, GapDecisionRow,
  CandidateRow, PaymentRow,
} from '../../ports/database.ts';
import type { Cents, DeliveryMode, OrderStatus, AgeBracket } from '@palette/domain';

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Raised when a basket line cannot be priced at the chosen store, because the
 * product is inactive or that store does not carry it. The order is refused as
 * a whole rather than quietly shrunk.
 */
/**
 * Raised when an order cannot be seen or changed by the current caller.
 *
 * Deliberately indistinguishable from "does not exist": telling someone that
 * an order exists but is not theirs is itself a disclosure.
 */
export class OrderNotVisibleError extends Error {
  readonly orderId: string;

  constructor(orderId: string) {
    super('Commande introuvable.');
    this.name = 'OrderNotVisibleError';
    this.orderId = orderId;
  }
}

export class UnavailableProductsError extends Error {
  readonly productIds: readonly string[];

  constructor(productIds: readonly string[], message: string) {
    super(message);
    this.name = 'UnavailableProductsError';
    this.productIds = productIds;
  }
}

function toOrderRow(r: Record<string, unknown>): OrderRow {
  return {
    id: r['id'] as string,
    reference: r['reference'] as string,
    clientId: r['client_id'] as string,
    status: r['status'] as OrderStatus,
    zoneId: r['zone_id'] as string,
    storeId: r['store_id'] as string,
    mode: r['mode'] as DeliveryMode,
    itemsEstimatedCents: Number(r['items_estimated_cents']),
    itemsActualCents: r['items_actual_cents'] === null ? null : Number(r['items_actual_cents']),
    deliveryFeeCents: Number(r['delivery_fee_cents']),
    serviceFeeCents: Number(r['service_fee_cents']),
    tipCents: Number(r['tip_cents']),
    totalEstimatedCents: Number(r['total_estimated_cents']),
    totalChargedCents: r['total_charged_cents'] === null ? null : Number(r['total_charged_cents']),
    palletCount: Number(r['pallet_count']),
    floorSnapshot: Number(r['floor_snapshot']),
    hasLiftSnapshot: Boolean(r['has_lift_snapshot']),
    surgeCoefficient: Number(r['surge_coefficient']),
  };
}

/**
 * Runs `fn` atomically, whether or not we are already inside a transaction.
 *
 * postgres.js hands a transaction object that has `savepoint` but not `begin`,
 * so an adapter that always calls `begin` breaks the moment a caller wraps it
 * — which the API does, because every request runs in one transaction under
 * the `authenticated` role.
 */
async function atomically<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const nested = sql as unknown as { savepoint?: (fn: (tx: Sql) => Promise<T>) => Promise<T> };

  return typeof nested.savepoint === 'function'
    ? nested.savepoint(tx => fn(tx))
    : sql.begin(tx => fn(tx as unknown as Sql)) as Promise<T>;
}

export function createPostgresDatabase(sql: Sql): Database {
  const db: Database = {
    async transaction(fn) {
      return atomically(sql, tx => fn(createPostgresDatabase(tx)));
    },

    settings: {
      async int(key) {
        const [row] = await sql`select app.setting_int(${key}) as v`;
        return Number(row!['v']);
      },
      async num(key) {
        const [row] = await sql`select app.setting_num(${key}) as v`;
        return Number(row!['v']);
      },
      async text(key) {
        const [row] = await sql`select app.setting_text(${key}) as v`;
        return row!['v'] as string;
      },
      async bool(key) {
        const [row] = await sql`select app.setting_bool(${key}) as v`;
        return Boolean(row!['v']);
      },
      async launchBlockers() {
        const rows = await sql`select key, description from app.launch_blockers()`;
        return rows.map(r => ({ key: r['key'] as string, description: r['description'] as string }));
      },
    },

    orders: {
      /**
       * Places an order and prices it, in ONE transaction.
       *
       * The price is computed by SQL from the order's own snapshots, after the
       * creation guard has resolved the zone, the floor and the lift from the
       * address. That ordering matters: it is what makes the stored price
       * reproducible later, even if the address changes.
       */
      async place(input: PlaceOrderInput): Promise<OrderRow> {
        return atomically(sql, async tx => {
          // Pallet count and estimated item total come from the catalogue, at
          // the store's current indicative prices.
          const productIds = input.lines.map(l => l.productId);
          const quantities = input.lines.map(l => l.quantity);

          const [totals] = await tx`
            with basket as (
              select unnest(${tx.array(productIds)}::uuid[]) as product_id,
                     unnest(${tx.array(quantities)}::int[])  as quantity
            )
            select coalesce(sum(b.quantity * sp.indicative_price_cents), 0)::int as items_cents,
                   coalesce(sum(b.quantity * p.pallet_count), 0)::int            as pallets,
                   count(*)::int                                                 as priced_lines
              from basket b
              join products p on p.id = b.product_id and p.active
              join store_products sp on sp.product_id = b.product_id
                                    and sp.store_id = ${input.storeId}
                                    and sp.available
          `;

          const itemsCents = Number(totals!['items_cents']);
          const pallets = Number(totals!['pallets']);

          // Every line must be priceable at THIS store. Dropping an
          // unavailable line silently would let a client pay for a basket
          // they are not going to receive, so the whole order is refused and
          // the offending products are named.
          if (Number(totals!['priced_lines']) !== input.lines.length) {
            const missing = await tx`
              with basket as (
                select unnest(${tx.array(productIds)}::uuid[]) as product_id
              )
              select b.product_id,
                     coalesce(p.name, 'produit inconnu') as name
                from basket b
                left join products p on p.id = b.product_id
               where not exists (
                 select 1 from store_products sp
                  where sp.product_id = b.product_id
                    and sp.store_id = ${input.storeId}
                    and sp.available)
                  or p.active is not true
            `;

            const names = missing.map(r => r['name'] as string).join(', ');
            throw new UnavailableProductsError(
              missing.map(r => r['product_id'] as string),
              `Ces articles ne sont pas disponibles dans ce magasin : ${names}.`);
          }

          // Current surge for the zone. Personalising it would be unlawful
          // (spec 9), so it is read from the zone, never from the client.
          const surge = 1.0;

          const [inserted] = await tx`
            insert into orders (
              client_id, address_id, store_id, zone_id, mode,
              pallet_count, surge_coefficient,
              items_estimated_cents, delivery_fee_cents, service_fee_cents,
              tip_cents, total_estimated_cents,
              slot_start, slot_end, note_for_courier,
              sales_terms_document_id
            )
            select
              ${input.clientId}, ${input.addressId}, ${input.storeId},
              a.zone_id, ${input.mode},
              ${pallets}, ${surge},
              ${itemsCents},
              app.compute_delivery_fee(${pallets}, a.floor, a.has_lift, ${surge}, ${input.mode}),
              app.setting_int('pricing.service_fee_cents'),
              ${input.tipCents ?? 0},
              ${itemsCents}
                + app.compute_delivery_fee(${pallets}, a.floor, a.has_lift, ${surge}, ${input.mode})
                + app.setting_int('pricing.service_fee_cents')
                + ${input.tipCents ?? 0},
              ${input.slotStart ?? null}, ${input.slotEnd ?? null},
              ${input.noteForCourier ?? null},
              (select id from legal_documents
                where doc_key = 'sales_terms' and published_at is not null
                order by published_at desc limit 1)
            from addresses a
            where a.id = ${input.addressId}
            returning *
          `;

          const order = toOrderRow(inserted!);

          for (const line of input.lines) {
            await tx`
              insert into order_items (
                order_id, product_id, quantity, unit_indicative_price_cents,
                participant_id, substitution_rule,
                age_minimum_snapshot, contains_alcohol_snapshot
              )
              select ${order.id}, ${line.productId}, ${line.quantity},
                     sp.indicative_price_cents,
                     ${line.participantId ?? null},
                     ${line.substitutionRule ?? 'equivalent_ask_me'},
                     0, false
                from store_products sp
               where sp.product_id = ${line.productId} and sp.store_id = ${input.storeId}
            `;
          }

          return order;
        });
      },

      async byId(orderId) {
        const [row] = await sql`select * from orders where id = ${orderId}`;
        return row ? toOrderRow(row) : null;
      },

      /**
       * Changes an order's status.
       *
       * Checks that a row was actually affected. Under Row Level Security an
       * UPDATE that matches nothing succeeds silently, so without this check
       * a client trying to move someone else's order would be told it worked
       * while nothing happened.
       */
      async setStatus(orderId: string, status: OrderStatus, actor: Actor) {
        await atomically(sql, async tx => {
          await tx`select app.set_actor(${actor.id}, ${actor.role}, ${actor.reason ?? null})`;
          const result = await tx`update orders set status = ${status} where id = ${orderId}`;

          if (result.count === 0) {
            throw new OrderNotVisibleError(orderId);
          }
        });
      },

      async setPin(orderId, pin) {
        await sql`select app.set_order_pin(${orderId}, ${pin})`;
      },

      async containsAlcohol(orderId) {
        const [row] = await sql`select app.order_contains_alcohol(${orderId}) as v`;
        return Boolean(row!['v']);
      },

      async cancellationTerms(orderId) {
        const [row] = await sql`select * from app.cancellation_terms(${orderId})`;
        return {
          free: Boolean(row!['free']),
          itemsDueCents: Number(row!['items_due_cents']),
          feesDueCents: Number(row!['fees_due_cents']),
          explanation: row!['explanation'] as string,
        };
      },

      async recordActualItems(orderId, itemsActualCents, totalChargedCents) {
        await sql`
          update orders
             set items_actual_cents = ${itemsActualCents},
                 total_charged_cents = ${totalChargedCents}
           where id = ${orderId}`;
      },
    },

    pricing: {
      async deliveryFee({ pallets, floor, hasLift, surge, mode }) {
        const [row] = await sql`
          select app.compute_delivery_fee(${pallets}, ${floor}, ${hasLift}, ${surge}, ${mode}) as v`;
        return Number(row!['v']) as Cents;
      },

      async ticketGapDecision(orderId, itemsActualCents): Promise<GapDecisionRow> {
        const [row] = await sql`select * from app.ticket_gap_decision(${orderId}, ${itemsActualCents})`;
        return {
          gapCents: Number(row!['gap_cents']),
          operatorAbsorbsCents: Number(row!['operator_absorbs_cents']),
          extraCaptureCents: Number(row!['extra_capture_cents']),
          refundCents: Number(row!['refund_cents']),
          requiresClientApproval: Boolean(row!['requires_client_approval']),
          explanation: row!['explanation'] as string,
        };
      },
    },

    payments: {
      /**
       * Goes through app.register_payment rather than writing the row: RLS
       * grants no INSERT on `payments`, and the function checks ownership,
       * order state, amount and idempotency.
       */
      async insert(input): Promise<PaymentRow> {
        const [row] = await sql`
          select (app.register_payment(
            ${input.orderId}, ${input.provider}, ${input.providerRef}, ${input.method},
            ${input.amountAuthorizedCents}, ${input.idempotencyKey})).*`;
        return {
          id: row!['id'] as string,
          orderId: row!['order_id'] as string,
          providerRef: row!['provider_ref'] as string,
          status: row!['status'] as string,
          amountAuthorizedCents: Number(row!['amount_authorized_cents']),
          amountCapturedCents: row!['amount_captured_cents'] === null
            ? null : Number(row!['amount_captured_cents']),
        };
      },

      async byProviderRef(providerRef) {
        const [row] = await sql`select * from payments where provider_ref = ${providerRef}`;
        if (!row) return null;
        return {
          id: row['id'] as string,
          orderId: row['order_id'] as string,
          providerRef: row['provider_ref'] as string,
          status: row['status'] as string,
          amountAuthorizedCents: row['amount_authorized_cents'] === null
            ? null : Number(row['amount_authorized_cents']),
          amountCapturedCents: row['amount_captured_cents'] === null
            ? null : Number(row['amount_captured_cents']),
        };
      },

      async byIdempotencyKey(key) {
        const [row] = await sql`select * from payments where idempotency_key = ${key}`;
        if (!row) return null;
        return {
          id: row['id'] as string,
          orderId: row['order_id'] as string,
          providerRef: row['provider_ref'] as string,
          status: row['status'] as string,
          amountAuthorizedCents: row['amount_authorized_cents'] === null
            ? null : Number(row['amount_authorized_cents']),
          amountCapturedCents: row['amount_captured_cents'] === null
            ? null : Number(row['amount_captured_cents']),
        };
      },

      async applyEvent(input) {
        await sql`
          update payments
             set status = ${input.status},
                 sca_completed = ${input.scaCompleted},
                 amount_captured_cents = case when ${input.status} = 'captured'
                                              then ${input.amountCents}
                                              else amount_captured_cents end,
                 authorized_at = case when ${input.status} = 'authorized' and authorized_at is null
                                      then now() else authorized_at end,
                 captured_at = case when ${input.status} = 'captured' and captured_at is null
                                    then now() else captured_at end,
                 failed_reason = ${input.failureReason ?? null}
           where provider_ref = ${input.providerRef}`;
      },

      async refund(input) {
        await sql`
          insert into refunds (payment_id, amount_cents, reason, issued_by, provider_ref, status)
          values (${input.paymentId}, ${input.amountCents}, ${input.reason},
                  ${input.issuedBy}, ${input.providerRef}, 'done')`;
      },
    },

    dispatch: {
      async candidates(orderId): Promise<readonly CandidateRow[]> {
        const rows = await sql`select * from app.dispatch_candidates(${orderId})`;
        return rows.map(r => ({
          courierId: r['courier_id'] as string,
          distanceM: Number(r['distance_m']),
          remainingUnits: Number(r['remaining_units']),
          score: Number(r['score']),
          missionsInShift: Number(r['missions_in_shift']),
        }));
      },
      async createMission({ storeId }) {
        const [row] = await sql`insert into missions (store_id) values (${storeId}) returning id`;
        return { id: row!['id'] as string };
      },
      async attachOrder(missionId, orderId) {
        await sql`insert into mission_orders (mission_id, order_id)
                  values (${missionId}, ${orderId}) on conflict do nothing`;
      },
      async offer(missionId, courierId, score) {
        const [row] = await sql`
          insert into mission_offers (mission_id, courier_id, score)
          values (${missionId}, ${courierId}, ${score}) returning id`;
        return { id: row!['id'] as string };
      },
      async offeredCouriers(missionId) {
        const rows = await sql`
          select courier_id from mission_offers where mission_id = ${missionId}`;
        return rows.map(r => r['courier_id'] as string);
      },
      async missionOrderIds(missionId) {
        const rows = await sql`
          select order_id from mission_orders where mission_id = ${missionId}`;
        return rows.map(r => r['order_id'] as string);
      },
      async respondToOffer(offerId, status, reason) {
        await sql`
          update mission_offers
             set status = ${status}, responded_at = now(), decline_reason = ${reason ?? null}
           where id = ${offerId}`;
      },
      async assign(missionId, courierId, shiftBookingId) {
        await sql`
          update missions
             set courier_id = ${courierId}, shift_booking_id = ${shiftBookingId},
                 status = 'assigned'
           where id = ${missionId}`;
      },
      async activeShiftBooking(courierId) {
        const [row] = await sql`
          select b.id from shift_bookings b
            join shifts s on s.id = b.shift_id
           where b.courier_id = ${courierId} and b.cancelled_at is null
             and now() between s.starts_at and s.ends_at
           limit 1`;
        return row ? (row['id'] as string) : null;
      },
    },

    delivery: {
      async recordAgeCheck(input) {
        const [row] = await sql`
          select app.record_age_check(
            ${input.orderId}, ${input.courierId}, ${input.result},
            ${input.reason ?? null}, ${input.documentChecked}, ${input.sober}) as id`;
        return { id: row!['id'] as string };
      },
      /**
       * Hands the order over.
       *
       * Runs inside its own savepoint, because a refusal here is EXPECTED and
       * the caller continues: a missing age check or a wrong PIN is the
       * system working, not a crash. Without the savepoint the enclosing
       * transaction — the whole HTTP request — would be left aborted, and the
       * commit would fail even though the error was handled. The courier
       * would get a 500 at someone's door instead of "wrong PIN".
       */
      async deliver(orderId, courierId, pin) {
        await atomically(sql, async tx => {
          await tx`select app.deliver_order(${orderId}, ${courierId}, ${pin})`;
        });
      },
      async saveReceipt(input) {
        await sql`
          insert into receipts (order_id, mission_id, photo_path,
                                amount_read_cents, amount_validated_cents, validated_by)
          values (${input.orderId}, ${input.missionId}, ${input.photoPath},
                  ${input.amountReadCents}, ${input.amountValidatedCents}, ${input.validatedBy})`;
      },
    },

    courier: {
      async profile(courierId) {
        const [row] = await sql`
          select * from courier_profiles where user_id = ${courierId}`;
        if (!row) return null;
        return {
          userId: row['user_id'] as string,
          courierModel: row['courier_model'] as string,
          transport: row['transport'] as 'foot_trolley' | 'bike_trailer' | 'cargo_bike',
          capacityUnits: Number(row['capacity_units']),
          trainingPassedAt: row['training_passed_at'] as Date | null,
          contractSigned: Boolean(row['contract_signed']),
          dimonaConfirmed: Boolean(row['dimona_confirmed']),
          status: row['status'] as string,
        };
      },

      /**
       * Applying as a courier.
       *
       * Goes through app.apply_as_courier rather than writing the row: a
       * courier holds no write access to their own profile at all, because
       * those columns are what the mission and booking guards read (see
       * migration 0027). The function forces the capacity from the transport
       * parameter and the employment flags to false.
       */
      async apply(input) {
        // The subject is named explicitly: from the API it equals the caller,
        // and from a system context there is no caller to infer it from
        // (migration 0033).
        await sql`
          select app.apply_as_courier(${input.transport}::transport_mode,
                                      ${input.enrolmentProofRef},
                                      ${input.userId})`;
        void input.capacityUnits;   // decided by the parameter, never by the caller
      },

      async quiz(seed) {
        const rows = await sql`select * from app.training_quiz(${seed})`;
        return rows.map(r => ({
          questionId: r['question_id'] as string,
          topic: r['topic'] as string,
          prompt: r['prompt'] as string,
          choices: r['choices'] as { id: number; label: string }[],
        }));
      },

      async gradeQuiz(courierId, answers) {
        const [row] = await sql`
          select * from app.grade_training(${courierId}, ${sql.json(answers)})`;
        return {
          score: Number(row!['score']),
          total: Number(row!['total']),
          passed: Boolean(row!['passed']),
          wrong: (row!['wrong'] as Array<Record<string, string>>).map(w => ({
            questionId: w['question_id']!, prompt: w['prompt']!, explanation: w['explanation']!,
          })),
        };
      },

      async signContract(courierId) {
        await sql`select app.sign_courier_contract(${courierId})`;
      },

      /**
       * Confirming the Dimona declaration.
       *
       * Admin only and journalled: it records that a declaration was actually
       * made to the ONSS, which is not something a courier may assert about
       * themselves (migration 0027).
       */
      async confirmDimona(courierId, adminId) {
        await sql`select app.confirm_dimona(${courierId})`;
        void adminId;   // the actor comes from the session, not from an argument
      },

      async openShifts(courierId) {
        const rows = await sql`
          select s.id, s.zone_id, z.name as zone_name, s.starts_at, s.ends_at,
                 s.places, s.night_derogation, s.peak_bonus_cents,
                 (select count(*)::int from shift_bookings b
                   where b.shift_id = s.id and b.cancelled_at is null) as taken,
                 exists (select 1 from shift_bookings b
                          where b.shift_id = s.id and b.courier_id = ${courierId}
                            and b.cancelled_at is null) as booked_by_me
            from shifts s
            join zones z on z.id = s.zone_id
           where s.cancelled_at is null
             and s.ends_at > now()
             and z.status = 'open'
           order by s.starts_at`;

        return rows.map(r => ({
          id: r['id'] as string,
          zoneId: r['zone_id'] as string,
          zoneName: r['zone_name'] as string,
          startsAt: r['starts_at'] as Date,
          endsAt: r['ends_at'] as Date,
          places: Number(r['places']),
          taken: Number(r['taken']),
          nightDerogation: Boolean(r['night_derogation']),
          peakBonusCents: Number(r['peak_bonus_cents']),
          bookedByMe: Boolean(r['booked_by_me']),
        }));
      },

      async bookShift(shiftId, courierId) {
        const [row] = await sql`
          insert into shift_bookings (shift_id, courier_id)
          values (${shiftId}, ${courierId})
          on conflict (shift_id, courier_id) do update set cancelled_at = null
          returning id`;
        return { bookingId: row!['id'] as string };
      },

      async cancelBooking(shiftId, courierId) {
        const result = await sql`
          update shift_bookings set cancelled_at = now()
           where shift_id = ${shiftId} and courier_id = ${courierId} and cancelled_at is null`;
        if (result.count === 0) {
          throw new Error('aucune réservation active à annuler pour ce créneau');
        }
      },

      async bookings(courierId) {
        const rows = await sql`
          select b.id, b.shift_id, b.cancelled_at, s.starts_at, s.ends_at, z.name as zone_name
            from shift_bookings b
            join shifts s on s.id = b.shift_id
            join zones z on z.id = s.zone_id
           where b.courier_id = ${courierId}
           order by s.starts_at desc limit 50`;

        return rows.map(r => ({
          id: r['id'] as string,
          shiftId: r['shift_id'] as string,
          startsAt: r['starts_at'] as Date,
          endsAt: r['ends_at'] as Date,
          zoneName: r['zone_name'] as string,
          cancelledAt: r['cancelled_at'] as Date | null,
        }));
      },

      /**
       * Offers addressed to this courier.
       *
       * Goes through app.courier_offers, which returns exactly what spec 7.5
       * says an offer must carry and nothing more: the client's address and
       * identity only appear once the mission is accepted (migration 0028).
       */
      async offers(courierId) {
        const rows = await sql`select * from app.courier_offers(${courierId})`;

        return rows.map(r => ({
          offerId: r['offer_id'] as string,
          missionId: r['mission_id'] as string,
          score: Number(r['score']),
          offeredAt: r['offered_at'] as Date,
          storeName: r['store_name'] as string,
          orderReference: r['order_reference'] as string,
          itemCount: Number(r['item_count']),
          totalWeightKg: Number(r['total_weight_kg']),
          floor: Number(r['floor']),
          hasLift: Boolean(r['has_lift']),
          distanceM: r['distance_m'] === null ? null : Number(r['distance_m']),
          estimatedBonusCents: Number(r['estimated_bonus_cents']),
        }));
      },

      async acceptOffer(offerId) {
        const [row] = await sql`select * from app.accept_mission_offer(${offerId})`;
        return {
          missionId: row!['assigned_mission_id'] as string,
          orderIds: (row!['assigned_order_ids'] as string[]) ?? [],
        };
      },

      async currentMission(courierId) {
        const [mission] = await sql`
          select m.id, m.status, st.name as store_name, st.street, st.number
            from missions m
            join stores st on st.id = m.store_id
           where m.courier_id = ${courierId}
             and m.status in ('assigned','at_store','purchased','en_route')
           order by m.assigned_at desc limit 1`;

        if (!mission) return null;

        const orders = await sql`
          select o.id, o.reference, o.status, o.note_for_courier,
                 a.street, a.number, a.building, a.floor, a.has_lift, a.room, a.instructions,
                 app.order_contains_alcohol(o.id) as contains_alcohol
            from mission_orders mo
            join orders o on o.id = mo.order_id
            join addresses a on a.id = o.address_id
           where mo.mission_id = ${mission['id']}`;

        const detailed = [];
        for (const o of orders) {
          const items = await sql`
            select i.id, p.name, p.format, i.quantity, i.unit_indicative_price_cents,
                   i.contains_alcohol_snapshot, i.substitution_rule, i.fulfilled, i.refunded
              from order_items i join products p on p.id = i.product_id
             where i.order_id = ${o['id']}`;

          detailed.push({
            orderId: o['id'] as string,
            reference: o['reference'] as string,
            status: o['status'] as string,
            street: o['street'] as string,
            number: o['number'] as string,
            building: o['building'] as string | null,
            floor: Number(o['floor']),
            hasLift: Boolean(o['has_lift']),
            room: o['room'] as string | null,
            instructions: o['instructions'] as string | null,
            noteForCourier: o['note_for_courier'] as string | null,
            containsAlcohol: Boolean(o['contains_alcohol']),
            items: items.map(i => ({
              orderItemId: i['id'] as string,
              productName: i['name'] as string,
              format: i['format'] as string,
              quantity: Number(i['quantity']),
              indicativePriceCents: Number(i['unit_indicative_price_cents']),
              containsAlcohol: Boolean(i['contains_alcohol_snapshot']),
              substitutionRule: i['substitution_rule'] as string,
              fulfilled: Boolean(i['fulfilled']),
              refunded: Boolean(i['refunded']),
            })),
          });
        }

        const [ceiling] = await sql`
          select app.setting_int('courier.spend_card_ceiling_cents') as v`;

        return {
          missionId: mission['id'] as string,
          status: mission['status'] as string,
          storeName: mission['store_name'] as string,
          storeStreet: mission['street'] as string,
          storeNumber: mission['number'] as string,
          orders: detailed,
          spendCardCeilingCents: Number(ceiling!['v']),
        };
      },

      /**
       * Goes through app.advance_mission: a courier holds no write access to
       * the missions table, and the function checks both ownership and that
       * the step follows the previous one (migration 0031).
       */
      async setMissionStatus(missionId, status) {
        await sql`select app.advance_mission(${missionId}, ${status})`;
      },

      async requestSubstitution(input) {
        const [row] = await sql`
          insert into substitution_requests (order_item_id, courier_id, reason,
                                             proposed_label, proposed_price_cents, expires_at)
          values (${input.orderItemId}, ${input.courierId}, ${input.reason},
                  ${input.proposedLabel ?? null}, ${input.proposedPriceCents ?? null},
                  now())
          returning *`;
        return toSubstitution(row!);
      },

      async resolveSubstitution(requestId, answer) {
        const [row] = await sql`
          select (app.resolve_substitution(${requestId},
            ${answer}::substitution_outcome)).*`;
        return toSubstitution(row!);
      },

      async pendingSubstitutions(orderId) {
        const rows = await sql`
          select sr.* from substitution_requests sr
            join order_items i on i.id = sr.order_item_id
           where i.order_id = ${orderId} and sr.outcome = 'awaiting_client'`;
        return rows.map(toSubstitution);
      },

      async recordPosition(input) {
        await sql`
          insert into courier_positions (courier_id, shift_booking_id, lat, lon)
          values (${input.courierId}, ${input.bookingId}, ${input.lat}, ${input.lon})`;
      },

      async hours(courierId, from, to) {
        const [row] = await sql`select app.courier_hours(${courierId}, ${from}, ${to}) as v`;
        return Number(row!['v']);
      },

      async quotaStatus(courierId) {
        const [row] = await sql`select * from app.courier_quota_status(${courierId})`;
        return {
          year: Number(row!['year']),
          hoursWithOperator: Number(row!['hours_with_operator']),
          quotaHours: Number(row!['quota_hours']),
          alertThresholdHours: Number(row!['alert_threshold_hours']),
          alerting: Boolean(row!['alerting']),
        };
      },

      async earnings(courierId, from, to) {
        const [row] = await sql`
          select * from app.courier_earnings_estimate(${courierId}, ${from}, ${to})`;
        return {
          hours: Number(row!['hours']),
          hourlyWageCents: Number(row!['hourly_wage_cents']),
          wageCents: Number(row!['wage_cents']),
          deliveries: Number(row!['deliveries']),
          deliveryBonusCents: Number(row!['delivery_bonus_cents']),
          floorBonusCents: Number(row!['floor_bonus_cents']),
          tipsCents: Number(row!['tips_cents']),
          totalCents: Number(row!['total_cents']),
        };
      },

      async recallAction(actionId) {
        const [row] = await sql`
          select kind, result from courier_actions where action_id = ${actionId}`;
        return row ? { kind: row['kind'] as string, result: row['result'] } : null;
      },

      async rememberAction(input) {
        await sql`
          insert into courier_actions (action_id, courier_id, kind, result)
          values (${input.actionId}, ${input.courierId}, ${input.kind},
                  ${sql.json(input.result as object)})
          on conflict (action_id) do nothing`;
      },
    },

    users: {
      async recordVerification(input) {
        await sql`
          update users
             set age_bracket = ${input.bracket}::age_bracket,
                 age_verified = true,
                 verification_method = ${input.method}::verification_method,
                 verified_at = ${input.verifiedAt}
           where id = ${input.userId}`;
      },
      async activate(userId) {
        await sql`update users set status = 'active' where id = ${userId}`;
      },
    },
  };

  return db;
}

function toSubstitution(r: Record<string, unknown>) {
  return {
    id: r['id'] as string,
    orderItemId: r['order_item_id'] as string,
    reason: r['reason'] as string,
    outcome: r['outcome'] as string,
    askedAt: r['asked_at'] as Date,
    expiresAt: r['expires_at'] as Date,
    answeredAt: r['answered_at'] as Date | null,
  };
}

export function connect(connectionString: string): Sql {
  return postgres(connectionString, { onnotice: () => {} });
}

export type { AgeBracket };
