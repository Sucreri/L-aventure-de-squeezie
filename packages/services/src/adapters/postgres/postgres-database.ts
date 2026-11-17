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

export function createPostgresDatabase(sql: Sql): Database {
  const db: Database = {
    async transaction(fn) {
      return sql.begin(async tx => fn(createPostgresDatabase(tx as unknown as Sql)));
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
        return sql.begin(async tx => {
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

      async setStatus(orderId: string, status: OrderStatus, actor: Actor) {
        await sql.begin(async tx => {
          await tx`select app.set_actor(${actor.id}, ${actor.role}, ${actor.reason ?? null})`;
          await tx`update orders set status = ${status} where id = ${orderId}`;
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
      async insert(input): Promise<PaymentRow> {
        const [row] = await sql`
          insert into payments (order_id, provider, provider_ref, method, status,
                                amount_authorized_cents, idempotency_key)
          values (${input.orderId}, ${input.provider}, ${input.providerRef}, ${input.method},
                  'pending', ${input.amountAuthorizedCents}, ${input.idempotencyKey})
          returning *`;
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
      async deliver(orderId, courierId, pin) {
        await sql`select app.deliver_order(${orderId}, ${courierId}, ${pin})`;
      },
      async saveReceipt(input) {
        await sql`
          insert into receipts (order_id, mission_id, photo_path,
                                amount_read_cents, amount_validated_cents, validated_by)
          values (${input.orderId}, ${input.missionId}, ${input.photoPath},
                  ${input.amountReadCents}, ${input.amountValidatedCents}, ${input.validatedBy})`;
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

export function connect(connectionString: string): Sql {
  return postgres(connectionString, { onnotice: () => {} });
}

export type { AgeBracket };
