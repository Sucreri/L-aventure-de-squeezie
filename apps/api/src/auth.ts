/**
 * Session tokens.
 *
 * In production this is Supabase Auth: it issues the JWT and Postgres reads
 * the subject through auth.uid(). Until a Supabase project exists, the API
 * issues its own HMAC-signed token carrying the same thing — a user id and an
 * expiry — so the rest of the system is written against the final shape.
 *
 * Deliberately minimal: no roles, no claims, no permissions in the token.
 * What a user may see is decided by Row Level Security in the database, not by
 * something the client holds.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

export interface SessionToken {
  readonly userId: string;
  readonly expiresAt: Date;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTokenError';
  }
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function issueToken(secret: string, userId: string, ttlSeconds = 60 * 60 * 24 * 30): string {
  const payload = JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: randomUUID(),
  });
  const body = base64url(payload);
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(secret: string, token: string): SessionToken {
  const parts = token.split('.');
  if (parts.length !== 2) throw new InvalidTokenError('jeton malformé');

  const [body, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidTokenError('signature invalide');
  }

  let parsed: { sub?: string; exp?: number };
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidTokenError('charge utile illisible');
  }

  if (!parsed.sub || !parsed.exp) throw new InvalidTokenError('jeton incomplet');
  if (parsed.exp * 1000 < Date.now()) throw new InvalidTokenError('jeton expiré');

  return { userId: parsed.sub, expiresAt: new Date(parsed.exp * 1000) };
}
