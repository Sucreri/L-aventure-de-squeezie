/**
 * Minimal HTTP plumbing: routing, JSON, and error translation.
 *
 * No framework. The surface is small, and the handlers are meant to move to
 * Supabase Edge Functions unchanged, so a framework would only be something to
 * unpick later.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly bearer: string | null;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult>;

export interface HandlerResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Authentification requise.') => new HttpError(401, 'unauthorized', m);
export const forbidden = (m = 'Accès refusé.') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'Introuvable.') => new HttpError(404, 'not_found', m);
export const conflict = (m: string) => new HttpError(409, 'conflict', m);

interface Route {
  readonly method: string;
  readonly pattern: readonly string[];
  readonly handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, pattern: path.split('/').filter(Boolean), handler });
    return this;
  }

  get(path: string, handler: Handler): this { return this.add('GET', path, handler); }
  post(path: string, handler: Handler): this { return this.add('POST', path, handler); }
  patch(path: string, handler: Handler): this { return this.add('PATCH', path, handler); }
  delete(path: string, handler: Handler): this { return this.add('DELETE', path, handler); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segments = path.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.pattern.length !== segments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (const [index, part] of route.pattern.entries()) {
        const actual = segments[index]!;
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(actual);
        } else if (part !== actual) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }

    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A delivery app has no reason to accept a megabyte of JSON.
    if (size > 256 * 1024) throw badRequest('Corps de requête trop volumineux.');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Corps de requête JSON invalide.');
  }
}

export function createRequestListener(router: Router, onError?: (e: unknown) => void) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(payload);
    };

    try {
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (!matched) {
        send(404, { error: 'not_found', message: 'Route inconnue.' });
        return;
      }

      const authorization = req.headers['authorization'];
      const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : null;

      const result = await matched.handler({
        method: req.method ?? 'GET',
        path: url.pathname,
        params: matched.params,
        query: url.searchParams,
        body: await readBody(req),
        bearer,
      });

      send(result.status, result.body, result.headers ?? {});
    } catch (error) {
      if (error instanceof HttpError) {
        send(error.status, {
          error: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
        return;
      }

      onError?.(error);
      send(500, { error: 'internal', message: 'Erreur interne.' });
    }
  };
}
