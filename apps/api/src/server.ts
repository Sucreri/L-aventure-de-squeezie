/**
 * HTTP surface over the use cases.
 *
 * SECURITY BOUNDARY — read this before adding a route.
 *
 * Two execution modes, and the difference matters:
 *
 *   withUser(...)    runs the request inside a transaction that sets the
 *                    `authenticated` role and app.current_user_id. Row Level
 *                    Security therefore applies: the request can only see and
 *                    touch what the policies allow. This is the default, and
 *                    every route a signed-in person calls must use it.
 *
 *   withServiceRole  keeps the owner's privileges and bypasses RLS. It exists
 *                    only for the three things that cannot be done as a user:
 *                    creating an account before one exists, writing back the
 *                    result of an age verification, and handling a provider
 *                    webhook that belongs to nobody's session.
 *
 * A new route defaults to withUser. Reaching for withServiceRole should feel
 * like an exception, because it is one.
 */

import postgres from 'postgres';
import {
  createPostgresDatabase, placeOrder, handlePaymentWebhook,
  type Database, type AgeVerificationProvider, type PaymentProvider,
  type Clock, systemClock, RuleRefusedError,
} from '@palette/services';
import { Router, badRequest, unauthorized, notFound, forbidden, type RequestContext } from './http.ts';
import { issueToken, verifyToken, InvalidTokenError } from './auth.ts';

type Sql = postgres.Sql<Record<string, unknown>>;

export interface ServerDeps {
  readonly sql: Sql;
  readonly payments: PaymentProvider;
  readonly ageVerification: AgeVerificationProvider;
  readonly clock?: Clock;
  readonly tokenSecret: string;
  readonly publicBaseUrl: string;
}

export function buildRouter(deps: ServerDeps): Router {
  const clock = deps.clock ?? systemClock;
  const router = new Router();

  /** Runs the request as the signed-in user, with RLS enforced. */
  async function withUser<T>(
    ctx: RequestContext,
    fn: (db: Database, userId: string, tx: Sql) => Promise<T>,
  ): Promise<T> {
    const userId = requireUser(ctx);
    return deps.sql.begin(async tx => {
      await tx`select set_config('app.current_user_id', ${userId}, true)`;
      await tx`set local role authenticated`;
      return fn(createPostgresDatabase(tx as unknown as Sql), userId, tx as unknown as Sql);
    });
  }

  /** Bypasses RLS. Only for registration, verification callbacks and webhooks. */
  async function withServiceRole<T>(fn: (db: Database, tx: Sql) => Promise<T>): Promise<T> {
    return deps.sql.begin(async tx =>
      fn(createPostgresDatabase(tx as unknown as Sql), tx as unknown as Sql));
  }

  function requireUser(ctx: RequestContext): string {
    if (!ctx.bearer) throw unauthorized();
    try {
      return verifyToken(deps.tokenSecret, ctx.bearer).userId;
    } catch (error) {
      if (error instanceof InvalidTokenError) throw unauthorized(error.message);
      throw error;
    }
  }

  function field(body: unknown, name: string): string {
    const value = (body as Record<string, unknown> | undefined)?.[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw badRequest(`Le champ « ${name} » est obligatoire.`);
    }
    return value.trim();
  }

  function optional(body: unknown, name: string): string | undefined {
    const value = (body as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }

  // ---------------------------------------------------------------- public

  router.get('/health', async () => ({ status: 200, body: { ok: true } }));

  /**
   * Values the app needs before anyone signs in: the pay-button label, the
   * health warning, the legal ages. All parameters, never hard-coded in the
   * client (spec rule 0.3).
   */
  router.get('/public/settings', async () => {
    const body = await withServiceRole(async db => ({
      appName: await db.settings.text('app.display_name'),
      payButtonLabel: await db.settings.text('checkout.pay_button_label'),
      healthWarning: await db.settings.text('alcohol.health_warning_fr'),
      minAgeBeerWine: await db.settings.int('alcohol.min_age_beer_wine'),
      expressMaxUnits: await db.settings.int('orders.express_max_units'),
      operator: {
        legalName: await db.settings.text('operator.legal_name'),
        vatNumber: await db.settings.text('operator.vat_number'),
        bceNumber: await db.settings.text('operator.bce_number'),
        address: await db.settings.text('operator.address'),
        contactEmail: await db.settings.text('operator.contact_email'),
      },
    }));
    return { status: 200, body };
  });

  /** The public gauge: "Biéreau : 78/150 — invite tes voisins" (spec 8.1). */
  router.get('/public/zones', async () => {
    const rows = await withServiceRole(async (_db, tx) => tx`
      select slug, name, status, client_threshold, courier_threshold,
             clients_waiting, couriers_waiting
        from zone_progress order by name`);
    return { status: 200, body: { zones: rows } };
  });

  router.get('/public/legal/:docKey', async ctx => {
    const rows = await withServiceRole(async (_db, tx) => tx`
      select doc_key, version, title, body_md, published_at
        from legal_documents
       where doc_key = ${ctx.params['docKey']!} and published_at is not null
       order by published_at desc limit 1`);
    if (rows.length === 0) throw notFound('Document indisponible.');
    return { status: 200, body: rows[0] };
  });

  // ---------------------------------------------------------------- account

  /**
   * Registration. Runs with the service role because the account does not
   * exist yet, so there is no identity for RLS to apply.
   *
   * The account is created INACTIVE: it becomes active only once age
   * verification has succeeded (spec 6.1). A session token is issued so the
   * app can carry the user through verification and consents, but an inactive
   * account cannot order — the database refuses.
   */
  router.post('/auth/register', async ctx => {
    const firstName = field(ctx.body, 'firstName');
    const lastName = field(ctx.body, 'lastName');
    const email = optional(ctx.body, 'email');
    const phone = optional(ctx.body, 'phone');

    if (!email && !phone) {
      throw badRequest('Un e-mail ou un numéro de téléphone est nécessaire.');
    }

    const user = await withServiceRole(async (_db, tx) => {
      const existing = await tx`
        select id from users
         where (${email ?? null}::citext is not null and email = ${email ?? null})
            or (${phone ?? null}::text is not null and phone = ${phone ?? null})
         limit 1`;

      if (existing.length > 0) {
        // Signing in again rather than creating a duplicate account.
        return { id: existing[0]!['id'] as string, created: false };
      }

      const [row] = await tx`
        insert into users (roles, first_name, last_name, email, phone, status)
        values (array['client']::user_role[], ${firstName}, ${lastName},
                ${email ?? null}, ${phone ?? null}, 'pending')
        returning id`;
      return { id: row!['id'] as string, created: true };
    });

    return {
      status: user.created ? 201 : 200,
      body: {
        userId: user.id,
        token: issueToken(deps.tokenSecret, user.id),
        nextStep: 'verify_age',
      },
    };
  });

  /** Starts age verification with the provider (spec 6.1). */
  router.post('/auth/verify-age/start', async ctx => {
    const userId = requireUser(ctx);
    const session = await deps.ageVerification.start(
      userId, `${deps.publicBaseUrl}/auth/verify-age/complete`);
    return { status: 200, body: { sessionId: session.sessionId, url: session.url } };
  });

  /**
   * Writes back the verification outcome. Service role: the provider's result
   * is not something a client may assert about itself.
   *
   * Only a BRACKET is ever stored — the port makes anything else impossible.
   */
  router.post('/auth/verify-age/complete', async ctx => {
    const userId = requireUser(ctx);
    const sessionId = field(ctx.body, 'sessionId');

    const result = await deps.ageVerification.complete(sessionId);

    if (!result.succeeded || result.bracket === null) {
      return {
        status: 200,
        body: { verified: false, reason: result.failureReason ?? 'vérification non aboutie' },
      };
    }

    if (result.bracket === 'under_16') {
      // Spec 6.1: under 16, registration is refused.
      return {
        status: 403,
        body: {
          verified: false,
          reason: "L'inscription est réservée aux personnes de 16 ans et plus.",
        },
      };
    }

    await withServiceRole(async db => {
      await db.users.recordVerification({
        userId, bracket: result.bracket!, method: result.method, verifiedAt: result.verifiedAt,
      });
      await db.users.activate(userId);
    });

    return { status: 200, body: { verified: true, bracket: result.bracket } };
  });

  /** Records consents, separately and timestamped (spec 6.2). */
  router.post('/consents', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const entries = (ctx.body as { consents?: unknown } | undefined)?.consents;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw badRequest('Aucun consentement fourni.');
      }

      for (const entry of entries) {
        const type = String((entry as Record<string, unknown>)['type'] ?? '');
        const granted = Boolean((entry as Record<string, unknown>)['granted']);

        const needsDocument = ['tos', 'sales_terms', 'privacy'].includes(type);
        const documentId = needsDocument
          ? (await tx`select id from legal_documents
                       where doc_key = ${type} and published_at is not null
                       order by published_at desc limit 1`)[0]?.['id'] ?? null
          : null;

        if (needsDocument && !documentId) {
          throw badRequest(`Aucune version publiée pour « ${type} ».`);
        }

        await tx`
          insert into consents (user_id, consent_type, granted, legal_document_id, source)
          values (${userId}, ${type}::consent_type, ${granted}, ${documentId}, 'app')`;
      }

      return { status: 201, body: { recorded: entries.length } };
    }));

  router.get('/me', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const [user] = await tx`
        select id, first_name, last_name, email, phone, age_bracket, age_verified,
               status, locale, created_at
          from users where id = ${userId}`;
      if (!user) throw notFound('Compte introuvable.');

      const consents = await tx`
        select distinct on (consent_type) consent_type, granted, occurred_at
          from consents where user_id = ${userId}
         order by consent_type, occurred_at desc`;

      return { status: 200, body: { user, consents } };
    }));

  /** Self-service export (spec 6.13). */
  router.get('/me/export', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const [row] = await tx`select app.export_user_data(${userId}) as payload`;
      return {
        status: 200,
        body: row!['payload'],
        headers: { 'content-disposition': 'attachment; filename="mes-donnees.json"' },
      };
    }));

  /** Self-service deletion, as simple as signing up (spec 4.6, 6.13). */
  router.delete('/me', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      // Expanded with (...).* : a composite would come back as an opaque
      // string, and the status is what the app branches on.
      const [row] = await tx`select (app.request_account_deletion(${userId})).*`;
      const status = row!['status'] as string;
      const reason = row!['refusal_reason'] as string | null;

      return {
        status: 200,
        body: {
          status,
          message: status === 'deferred'
            ? reason ?? 'Suppression différée : une commande est en cours.'
            : 'Compte supprimé.',
        },
      };
    }));

  // ---------------------------------------------------------------- addresses

  router.get('/addresses', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const rows = await tx`
        select a.id, a.label, a.street, a.number, a.building, a.floor, a.room,
               a.has_lift, a.lat, a.lon, a.instructions, a.is_default,
               z.slug as zone_slug, z.name as zone_name, z.status as zone_status
          from addresses a join zones z on z.id = a.zone_id
         where a.user_id = ${userId} and a.deleted_at is null
         order by a.is_default desc, a.created_at`;
      return { status: 200, body: { addresses: rows } };
    }));

  /**
   * Creating an address. An address outside every zone is refused by a
   * trigger; one inside a zone that is not yet open is accepted, and the
   * response says so, so the app can offer the waiting list (spec 6.3, 8.1).
   */
  router.post('/addresses', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const body = ctx.body as Record<string, unknown> | undefined;
      const lat = Number(body?.['lat']);
      const lon = Number(body?.['lon']);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw badRequest("L'épingle sur la carte est obligatoire : le GPS est imprécis sur la dalle.");
      }

      try {
        const [row] = await tx`
          insert into addresses (user_id, label, street, number, building, floor, room,
                                 has_lift, lat, lon, instructions, is_default)
          values (${userId}, ${optional(ctx.body, 'label') ?? null},
                  ${field(ctx.body, 'street')}, ${field(ctx.body, 'number')},
                  ${optional(ctx.body, 'building') ?? null},
                  ${Number(body?.['floor'] ?? 0)},
                  ${optional(ctx.body, 'room') ?? null},
                  ${Boolean(body?.['hasLift'])}, ${lat}, ${lon},
                  ${optional(ctx.body, 'instructions') ?? null},
                  ${Boolean(body?.['isDefault'])})
          returning id, zone_id`;

        const [zone] = await tx`
          select slug, name, status from zones where id = ${row!['zone_id']}`;

        return {
          status: 201,
          body: {
            addressId: row!['id'],
            zone,
            serviceAvailable: zone!['status'] === 'open',
          },
        };
      } catch (error) {
        if (String((error as Error).message).includes('outside the service area')) {
          throw badRequest(
            "Cette adresse est en dehors de la zone de service. Nous livrons uniquement à Louvain-la-Neuve.");
        }
        throw error;
      }
    }));

  router.post('/waitlist', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const zoneSlug = field(ctx.body, 'zoneSlug');
      await tx`
        insert into waitlist_entries (user_id, zone_id, role)
        select ${userId}, z.id, 'client' from zones z where z.slug = ${zoneSlug}
        on conflict (user_id, zone_id, role) do nothing`;
      return { status: 201, body: { joined: true } };
    }));

  // ---------------------------------------------------------------- catalogue

  router.get('/stores', async ctx =>
    withUser(ctx, async (_db, _userId, tx) => {
      const rows = await tx`
        select id, name, street, number, postal_code, city, lat, lon, opening_hours
          from stores where active order by name`;
      return { status: 200, body: { stores: rows } };
    }));

  /**
   * The catalogue, filtered by the viewer's verified age. A product above
   * their bracket is not merely greyed out: it is absent from the response
   * (spec 5), and the server would refuse it anyway.
   */
  router.get('/catalogue', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const storeId = ctx.query.get('storeId');
      if (!storeId) throw badRequest('Le paramètre « storeId » est obligatoire.');

      const rows = await tx`select * from app.catalogue_for_user(${userId}, ${storeId})`;
      return { status: 200, body: { products: rows } };
    }));

  // ---------------------------------------------------------------- orders

  router.post('/orders', async ctx =>
    withUser(ctx, async (db, userId) => {
      const body = ctx.body as Record<string, unknown> | undefined;
      const lines = body?.['lines'];

      if (!Array.isArray(lines) || lines.length === 0) {
        throw badRequest('Le panier est vide.');
      }

      try {
        const placed = await placeOrder({ db, payments: deps.payments, clock }, {
          clientId: userId,
          addressId: field(ctx.body, 'addressId'),
          storeId: field(ctx.body, 'storeId'),
          mode: (optional(ctx.body, 'mode') ?? 'express') as 'express' | 'scheduled' | 'grouped_round',
          lines: lines.map(line => ({
            productId: String((line as Record<string, unknown>)['productId']),
            quantity: Number((line as Record<string, unknown>)['quantity'] ?? 1),
            substitutionRule: (line as Record<string, unknown>)['substitutionRule'] as
              'other_format' | 'equivalent_ask_me' | 'refund' | undefined,
          })),
          tipCents: Number(body?.['tipCents'] ?? 0),
          ...(optional(ctx.body, 'noteForCourier')
            ? { noteForCourier: optional(ctx.body, 'noteForCourier')! } : {}),
          method: (optional(ctx.body, 'method') ?? 'bancontact') as 'bancontact' | 'card',
          returnUrl: `${deps.publicBaseUrl}/checkout/return`,
          webhookUrl: `${deps.publicBaseUrl}/webhooks/payment`,
        });

        return {
          status: 201,
          body: {
            orderId: placed.order.id,
            reference: placed.order.reference,
            status: placed.order.status,
            amounts: {
              itemsCents: placed.order.itemsEstimatedCents,
              deliveryCents: placed.order.deliveryFeeCents,
              serviceCents: placed.order.serviceFeeCents,
              tipCents: placed.order.tipCents,
              totalCents: placed.order.totalEstimatedCents,
              authorizedCents: placed.authorizedCents,
            },
            cancellationTerms: placed.cancellationTerms,
            checkoutUrl: placed.checkoutUrl,
          },
        };
      } catch (error) {
        if (error instanceof RuleRefusedError) {
          throw error.kind === 'zone_not_open'
            ? forbidden(error.userMessage)
            : badRequest(error.userMessage, { kind: error.kind });
        }
        if (String((error as Error).message).includes('ne sont pas disponibles')) {
          throw badRequest((error as Error).message);
        }
        throw error;
      }
    }));

  router.get('/orders', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const rows = await tx`
        select id, reference, status, mode, total_estimated_cents, total_charged_cents,
               created_at, delivered_at
          from orders where client_id = ${userId}
         order by created_at desc limit 50`;
      return { status: 200, body: { orders: rows } };
    }));

  router.get('/orders/:id', async ctx =>
    withUser(ctx, async (db, _userId, tx) => {
      const orderId = ctx.params['id']!;

      // RLS decides visibility: another client's order simply is not there.
      const [order] = await tx`select * from orders where id = ${orderId}`;
      if (!order) throw notFound('Commande introuvable.');

      const items = await tx`
        select i.quantity, i.unit_indicative_price_cents, i.unit_actual_price_cents,
               i.substitution_rule, p.name, p.format, p.contains_alcohol
          from order_items i join products p on p.id = i.product_id
         where i.order_id = ${orderId}`;

      // Status and timestamp only. The audit journal carries actor identities
      // and internal reasons, and stays closed to clients (migration 0023).
      const timeline = await tx`select * from app.order_timeline(${orderId})`;

      return {
        status: 200,
        body: { order, items, timeline, cancellationTerms: await db.orders.cancellationTerms(orderId) },
      };
    }));

  router.post('/orders/:id/cancel', async ctx =>
    withUser(ctx, async (db, userId) => {
      const orderId = ctx.params['id']!;

      let terms;
      try {
        terms = await db.orders.cancellationTerms(orderId);
      } catch {
        // Not visible under RLS, or does not exist. The two are deliberately
        // indistinguishable from the outside.
        throw notFound('Commande introuvable.');
      }

      try {
        await db.orders.setStatus(orderId, 'CANCELLED_BY_CLIENT', {
          id: userId, role: 'client', reason: optional(ctx.body, 'reason') ?? 'annulation client',
        });
      } catch (error) {
        if ((error as Error).name === 'OrderNotVisibleError') {
          throw notFound('Commande introuvable.');
        }
        if (error instanceof RuleRefusedError) throw badRequest(error.userMessage);
        throw error;
      }

      return { status: 200, body: { cancelled: true, terms } };
    }));

  /** Only a delivered order can be rated, and a rating is never edited (spec 16). */
  router.post('/orders/:id/rate', async ctx =>
    withUser(ctx, async (_db, userId, tx) => {
      const orderId = ctx.params['id']!;
      const score = Number((ctx.body as Record<string, unknown> | undefined)?.['score']);

      if (!Number.isInteger(score) || score < 1 || score > 5) {
        throw badRequest('La note doit être un entier entre 1 et 5.');
      }

      try {
        const [courier] = await tx`
          select m.courier_id from missions m
            join mission_orders mo on mo.mission_id = m.id
           where mo.order_id = ${orderId} limit 1`;

        await tx`
          insert into ratings (order_id, client_id, courier_id, score, labels, comment)
          values (${orderId}, ${userId}, ${courier?.['courier_id'] ?? null}, ${score},
                  ${(ctx.body as Record<string, unknown>)['labels'] as string[] ?? []},
                  ${optional(ctx.body, 'comment') ?? null})`;
      } catch (error) {
        const message = String((error as Error).message);
        if (message.includes('only a delivered order')) {
          throw badRequest('Seule une commande livrée peut être notée.');
        }
        if (message.includes('duplicate key')) {
          throw badRequest('Cette commande a déjà été notée.');
        }
        throw error;
      }

      return { status: 201, body: { rated: true } };
    }));

  // ---------------------------------------------------------------- webhooks

  /**
   * Payment webhook. No session: authenticity comes from the signature, and
   * the service role is required because the event belongs to no user.
   */
  router.post('/webhooks/payment', async ctx => {
    const signature = (ctx.body as Record<string, unknown> | undefined)?.['signature'];
    const payload = (ctx.body as Record<string, unknown> | undefined)?.['payload'];

    if (typeof signature !== 'string' || typeof payload !== 'string') {
      throw badRequest('Webhook malformé.');
    }

    try {
      const outcome = await withServiceRole(db =>
        handlePaymentWebhook({ db, payments: deps.payments }, payload, signature));
      return { status: 200, body: outcome };
    } catch (error) {
      if ((error as Error).name === 'WebhookSignatureError') {
        throw badRequest('Signature de webhook invalide.');
      }
      throw error;
    }
  });

  return router;
}
