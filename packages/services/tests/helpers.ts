/**
 * Test harness for the service layer.
 *
 * These are INTEGRATION tests: they run against a real Postgres carrying the
 * real constraints and triggers. That is deliberate. A fake database would
 * have to re-implement the rules, and the tests would then prove only that the
 * fake agrees with itself.
 */

import postgres from 'postgres';
import { createPostgresDatabase } from '../src/adapters/postgres/postgres-database.ts';
import { MockPaymentProvider } from '../src/adapters/mock/mock-payment.ts';
import { MockAgeVerificationProvider } from '../src/adapters/mock/mock-age-verification.ts';
import { MockNotificationSender } from '../src/adapters/mock/mock-notifications.ts';
import { MockReceiptReader } from '../src/adapters/mock/mock-receipt-reader.ts';
import { MockSpendCardProvider } from '../src/adapters/mock/mock-spend-card.ts';
import { FakeClock } from '../src/ports/clock.ts';

/**
 * Connection. DATABASE_URL wins when set (CI, Supabase); otherwise the local
 * test cluster, reached over its Unix socket.
 */
export const CONNECTION: postgres.Options<Record<string, postgres.PostgresType>> | string =
  process.env['DATABASE_URL'] ?? {
    host: process.env['PGHOST'] ?? '/var/run/postgresql',
    port: Number(process.env['PGPORT'] ?? 5433),
    database: process.env['PGDATABASE'] ?? 'uberpalette',
    username: process.env['PGUSER'] ?? 'postgres',
  };

export const DEMO = {
  storeCentre: '22222222-0000-0000-0000-000000000001',
  zoneBiereau: '11111111-0000-0000-0000-000000000001',
  zoneHocaille: '11111111-0000-0000-0000-000000000002',
  admin: '44444444-0000-0000-0000-000000000001',
  beer33: '33333333-0000-0000-0000-000000000001',
  water: '33333333-0000-0000-0000-000000000006',
  chips: '33333333-0000-0000-0000-000000000008',
} as const;

export function makeContext() {
  const sql = typeof CONNECTION === 'string'
    ? postgres(CONNECTION, { onnotice: () => {} })
    : postgres({ ...CONNECTION, onnotice: () => {} });
  const db = createPostgresDatabase(sql);
  const clock = new FakeClock();

  return {
    sql,
    db,
    clock,
    payments: new MockPaymentProvider('test-secret', clock),
    ageVerification: new MockAgeVerificationProvider(clock),
    notifications: new MockNotificationSender(),
    receipts: new MockReceiptReader(),
    spendCards: new MockSpendCardProvider(),
    async close() { await sql.end({ timeout: 5 }); },
  };
}

export type TestContext = ReturnType<typeof makeContext>;

/** Opens Biéreau so orders can actually be placed. Idempotent. */
export async function openBiereau(ctx: TestContext): Promise<void> {
  const [zone] = await ctx.sql`select status from zones where id = ${DEMO.zoneBiereau}`;
  if (zone?.['status'] === 'open') return;

  await ctx.sql`
    update zones set client_threshold = 1, courier_threshold = 1
     where id = ${DEMO.zoneBiereau}`;
  await ctx.sql`select app.open_zone(${DEMO.zoneBiereau}, ${DEMO.admin})`;
}

let counter = 0;

/** Creates a verified client with consents and an address inside Biéreau. */
export async function createClient(
  ctx: TestContext,
  options: { bracket?: 'b16_17' | 'b18_plus'; verified?: boolean; floor?: number; hasLift?: boolean } = {},
): Promise<{ userId: string; addressId: string }> {
  const bracket = options.bracket ?? 'b18_plus';
  const verified = options.verified ?? true;
  const suffix = `${Date.now()}-${counter++}`;

  const [user] = await ctx.sql`
    insert into users (roles, first_name, last_name, email, age_bracket, age_verified,
                       verification_method, verified_at, status)
    values (array['client']::user_role[], 'Test', ${'Client' + suffix},
            ${`test-${suffix}@example.invalid`},
            ${verified ? bracket : null}::age_bracket, ${verified},
            ${verified ? 'itsme' : null}::verification_method,
            ${verified ? new Date() : null}, 'active')
    returning id`;

  const userId = user!['id'] as string;

  const [tos] = await ctx.sql`select id from legal_documents where doc_key = 'tos' limit 1`;
  const [cgv] = await ctx.sql`select id from legal_documents where doc_key = 'sales_terms' limit 1`;

  await ctx.sql`
    insert into consents (user_id, consent_type, granted, legal_document_id) values
      (${userId}, 'tos', true, ${tos!['id']}),
      (${userId}, 'sales_terms', true, ${cgv!['id']})`;

  const [address] = await ctx.sql`
    insert into addresses (user_id, street, number, floor, has_lift, lat, lon, is_default)
    values (${userId}, 'Rue des Blancs Chevaux', ${String(100 + counter)},
            ${options.floor ?? 3}, ${options.hasLift ?? false}, 50.6680, 4.6150, true)
    returning id`;

  return { userId, addressId: address!['id'] as string };
}

/** Returns an active courier from the demo data. */
export async function anyCourier(ctx: TestContext): Promise<string> {
  const [row] = await ctx.sql`
    select user_id from courier_profiles where status = 'active' limit 1`;
  return row!['user_id'] as string;
}
