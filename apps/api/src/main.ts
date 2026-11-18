/**
 * Entry point for local development.
 *
 * In production these handlers become Supabase Edge Functions and this file is
 * not deployed. The provider wiring below is the only place that decides
 * whether the system talks to a real payment provider or a simulated one —
 * and the database refuses simulated providers unless the environment
 * explicitly allows them (migration 0017).
 */

import { createServer } from 'node:http';
import postgres from 'postgres';
import { MockPaymentProvider, MockAgeVerificationProvider } from '@palette/services';
import { buildRouter } from './server.ts';
import { createRequestListener } from './http.ts';

const port = Number(process.env['PORT'] ?? 8787);
const publicBaseUrl = process.env['PUBLIC_BASE_URL'] ?? `http://localhost:${port}`;

const tokenSecret = process.env['SESSION_TOKEN_SECRET'];
if (!tokenSecret && process.env['NODE_ENV'] === 'production') {
  throw new Error('SESSION_TOKEN_SECRET est obligatoire en production.');
}

const sql = process.env['DATABASE_URL']
  ? postgres(process.env['DATABASE_URL']!, { onnotice: () => {} })
  : postgres({
      host: process.env['PGHOST'] ?? '/var/run/postgresql',
      port: Number(process.env['PGPORT'] ?? 5433),
      database: process.env['PGDATABASE'] ?? 'uberpalette',
      username: process.env['PGUSER'] ?? 'postgres',
      onnotice: () => {},
    });

const router = buildRouter({
  sql,
  payments: new MockPaymentProvider(process.env['PAYMENT_WEBHOOK_SECRET'] ?? 'dev-secret'),
  ageVerification: new MockAgeVerificationProvider(),
  tokenSecret: tokenSecret ?? 'dev-only-secret-not-for-production',
  publicBaseUrl,
});

const allowedOrigins = (process.env['ALLOWED_ORIGINS'] ?? '')
  .split(',').map(o => o.trim()).filter(Boolean);

const server = createServer(createRequestListener(router, {
  allowedOrigins,
  // Spec 4.7: no personal data in logs.
  onError: error => console.error('[api] erreur interne :', (error as Error).message),
}));

server.listen(port, () => {
  console.log(`[api] à l'écoute sur http://localhost:${port}`);
});
