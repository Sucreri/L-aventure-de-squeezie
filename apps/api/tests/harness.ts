/**
 * Starts the real HTTP server against the real database for each test file.
 * Nothing is stubbed between the request and Postgres, because the properties
 * worth testing here — Row Level Security, the guards, the refusals — only
 * exist in that combination.
 */

import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import {
  MockPaymentProvider, MockAgeVerificationProvider, MockReceiptReader,
} from '@palette/services';
import { buildRouter } from '../src/server.ts';
import { createRequestListener } from '../src/http.ts';

export const TOKEN_SECRET = 'test-secret';

export interface ApiHarness {
  readonly baseUrl: string;
  readonly sql: postgres.Sql<Record<string, unknown>>;
  readonly payments: MockPaymentProvider;
  readonly ageVerification: MockAgeVerificationProvider;
  readonly receipts: MockReceiptReader;
  request(path: string, init?: RequestInit & { token?: string }): Promise<{
    status: number; body: any;
  }>;
  /** Last unexpected server-side error, so a 500 in a test is debuggable. */
  lastError(): unknown;
  close(): Promise<void>;
}

export async function startApi(): Promise<ApiHarness> {
  const sql = postgres({
    host: process.env['PGHOST'] ?? '/var/run/postgresql',
    port: Number(process.env['PGPORT'] ?? 5433),
    database: process.env['PGDATABASE'] ?? 'uberpalette',
    username: process.env['PGUSER'] ?? 'postgres',
    onnotice: () => {},
  });

  const payments = new MockPaymentProvider('test-webhook-secret');
  const ageVerification = new MockAgeVerificationProvider();
  const receipts = new MockReceiptReader();

  let capturedError: unknown = null;

  const server: Server = createServer(createRequestListener(
    buildRouter({
      sql, payments, ageVerification, receipts,
      tokenSecret: TOKEN_SECRET,
      publicBaseUrl: 'http://test.invalid',
    }),
    error => { capturedError = error; if (process.env["DEBUG_API"]) console.error("[api error]", (error as Error).message); },
  ));

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl, sql, payments, ageVerification, receipts,

    lastError: () => capturedError,

    async request(path, init = {}) {
      const { token, headers, ...rest } = init;
      const response = await fetch(`${baseUrl}${path}`, {
        ...rest,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
        },
      });

      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : undefined,
      };
    },

    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await sql.end({ timeout: 5 });
    },
  };
}

/** Signs a user up and takes them through verification and consents. */
export async function registerVerifiedClient(
  api: ApiHarness,
  options: { bracket?: 'b16_17' | 'b18_plus'; skipConsents?: boolean } = {},
): Promise<{ userId: string; token: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const registered = await api.request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      firstName: 'Test', lastName: 'Client',
      email: `api-${suffix}@example.invalid`,
    }),
  });

  const { userId, token } = registered.body;
  api.ageVerification.willReturn(userId, options.bracket ?? 'b18_plus');

  const started = await api.request('/auth/verify-age/start', { method: 'POST', token });
  await api.request('/auth/verify-age/complete', {
    method: 'POST', token,
    body: JSON.stringify({ sessionId: started.body.sessionId }),
  });

  if (!options.skipConsents) {
    await api.request('/consents', {
      method: 'POST', token,
      body: JSON.stringify({
        consents: [
          { type: 'tos', granted: true },
          { type: 'sales_terms', granted: true },
          { type: 'privacy', granted: true },
          { type: 'marketing', granted: false },
        ],
      }),
    });
  }

  return { userId, token };
}

export const DEMO = {
  storeCentre: '22222222-0000-0000-0000-000000000001',
  zoneBiereau: '11111111-0000-0000-0000-000000000001',
  admin: '44444444-0000-0000-0000-000000000001',
  beer33: '33333333-0000-0000-0000-000000000001',
  water: '33333333-0000-0000-0000-000000000006',
} as const;

/** Biéreau, inside the demo polygon. */
export const BIEREAU_PIN = { lat: 50.6680, lon: 4.6150 };

/**
 * Takes a fresh account all the way to "ready to work": application,
 * training, contract, and the Dimona confirmation the admin owns.
 *
 * The answer key is read straight from the database — something only a test
 * may do, and precisely what a courier cannot (migration 0025).
 */
export async function registerReadyCourier(
  api: ApiHarness,
  transport: 'foot_trolley' | 'bike_trailer' | 'cargo_bike' = 'cargo_bike',
): Promise<{ userId: string; token: string }> {
  const { userId, token } = await registerVerifiedClient(api);

  await api.request('/courier/apply', {
    method: 'POST', token,
    body: JSON.stringify({ transport, enrolmentProofRef: `ATT-${userId.slice(0, 8)}` }),
  });

  const key = await api.sql`select id, correct_index from training_questions where active`;
  const answers = Object.fromEntries(
    key.map(r => [r['id'] as string, Number(r['correct_index'])]));

  await api.request('/courier/training', {
    method: 'POST', token, body: JSON.stringify({ answers }),
  });

  await api.request('/courier/contract/sign', { method: 'POST', token });

  // The Dimona confirmation belongs to the admin; there is no courier route
  // for it, by design.
  await api.sql`
    update courier_profiles
       set dimona_confirmed = true, dimona_confirmed_at = now(), status = 'active'
     where user_id = ${userId}`;

  return { userId, token };
}

/** Publishes a shift covering now, within the working-time rules. */
export async function openShiftNow(api: ApiHarness, hours = 3): Promise<string> {
  const saved = await api.sql`
    select key, value from app_settings
     where key in ('work.service_end_time', 'work.night_work_threshold_time')`;
  await api.sql`
    update app_settings set value = '"23:59"'::jsonb
     where key in ('work.service_end_time', 'work.night_work_threshold_time')`;

  const [shift] = await api.sql`
    insert into shifts (zone_id, starts_at, ends_at, places, published_by,
                        night_derogation, derogation_validated_by, derogation_note)
    values (${DEMO.zoneBiereau}, now() - interval '30 minutes',
            now() + make_interval(hours => ${hours}),
            20, ${DEMO.admin}, true, ${DEMO.admin}, 'Fixture de test')
    returning id`;

  for (const row of saved) {
    await api.sql`update app_settings set value = ${row['value'] as object}
                   where key = ${row['key'] as string}`;
  }

  return shift!['id'] as string;
}
