/**
 * Client for the API.
 *
 * Note what this file does NOT do: it never decides whether something is
 * allowed. Prices, age rules, cancellation terms and refusals all come from
 * the server. The app displays them.
 *
 * That is not defensive programming, it is the architecture: a rule enforced
 * only here could be bypassed by anyone calling the API directly.
 */

import Constants from 'expo-constants';

const DEFAULT_BASE_URL = 'http://localhost:8787';

export const API_BASE_URL: string =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl
  ?? (typeof process !== 'undefined' ? process.env?.['EXPO_PUBLIC_API_URL'] : undefined)
  ?? DEFAULT_BASE_URL;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Impossible de joindre le service. Vérifie ta connexion.');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? 'unknown',
      payload?.message ?? 'Une erreur est survenue.',
      payload?.details,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------- types

export interface PublicSettings {
  appName: string;
  payButtonLabel: string;
  healthWarning: string;
  minAgeBeerWine: number;
  expressMaxUnits: number;
  operator: {
    legalName: string; vatNumber: string; bceNumber: string;
    address: string; contactEmail: string;
  };
}

export interface ZoneProgress {
  slug: string; name: string; status: 'waitlist' | 'open' | 'closed';
  client_threshold: number; courier_threshold: number;
  clients_waiting: number; couriers_waiting: number;
}

export interface Product {
  product_id: string; sku: string; name: string; format: string;
  contains_alcohol: boolean; alcohol_degree: string | null; age_minimum: number;
  capacity_units: string; pallet_count: number;
  indicative_price_cents: number; available: boolean;
  alcohol_notice: string | null;
}

export interface Store {
  id: string; name: string; street: string; number: string; city: string;
}

export interface Address {
  id: string; label: string | null; street: string; number: string;
  floor: number; has_lift: boolean; zone_slug: string; zone_name: string;
  zone_status: string;
}

export interface OrderAmounts {
  itemsCents: number; deliveryCents: number; serviceCents: number;
  tipCents: number; totalCents: number; authorizedCents: number;
}

export interface CancellationTerms {
  free: boolean; itemsDueCents: number; feesDueCents: number; explanation: string;
}

export interface PlacedOrder {
  orderId: string; reference: string; status: string;
  amounts: OrderAmounts; cancellationTerms: CancellationTerms; checkoutUrl: string;
}

export interface OrderDetail {
  order: {
    id: string; reference: string; status: string; mode: string;
    items_estimated_cents: number; delivery_fee_cents: number;
    service_fee_cents: number; tip_cents: number; total_estimated_cents: number;
    created_at: string;
  };
  items: Array<{
    quantity: number; unit_indicative_price_cents: number;
    name: string; format: string; contains_alcohol: boolean;
  }>;
  timeline: Array<{ status: string; occurred_at: string }>;
  cancellationTerms: CancellationTerms;
}

// ---------------------------------------------------------------- calls

export const api = {
  publicSettings: () => request<PublicSettings>('/public/settings'),
  zones: () => request<{ zones: ZoneProgress[] }>('/public/zones'),
  legal: (key: string) => request<{ title: string; body_md: string; version: string }>(
    `/public/legal/${key}`),

  register: (input: { firstName: string; lastName: string; email?: string; phone?: string }) =>
    request<{ userId: string; token: string; nextStep: string }>(
      '/auth/register', { method: 'POST', body: input }),

  startVerification: (token: string) =>
    request<{ sessionId: string; url: string }>(
      '/auth/verify-age/start', { method: 'POST', token }),

  completeVerification: (token: string, sessionId: string) =>
    request<{ verified: boolean; bracket?: string; reason?: string }>(
      '/auth/verify-age/complete', { method: 'POST', token, body: { sessionId } }),

  recordConsents: (token: string, consents: Array<{ type: string; granted: boolean }>) =>
    request<{ recorded: number }>('/consents', { method: 'POST', token, body: { consents } }),

  me: (token: string) => request<{
    user: { first_name: string; last_name: string; email: string | null;
            age_bracket: string | null; age_verified: boolean; status: string };
    consents: Array<{ consent_type: string; granted: boolean; occurred_at: string }>;
  }>('/me', { token }),

  exportMyData: (token: string) => request<unknown>('/me/export', { token }),
  deleteMyAccount: (token: string) =>
    request<{ status: string; message: string }>('/me', { method: 'DELETE', token }),

  addresses: (token: string) => request<{ addresses: Address[] }>('/addresses', { token }),
  createAddress: (token: string, input: Record<string, unknown>) =>
    request<{ addressId: string; zone: { slug: string; name: string; status: string };
              serviceAvailable: boolean }>('/addresses', { method: 'POST', token, body: input }),

  joinWaitlist: (token: string, zoneSlug: string) =>
    request<{ joined: boolean }>('/waitlist', { method: 'POST', token, body: { zoneSlug } }),

  stores: (token: string) => request<{ stores: Store[] }>('/stores', { token }),
  catalogue: (token: string, storeId: string) =>
    request<{ products: Product[] }>(`/catalogue?storeId=${encodeURIComponent(storeId)}`, { token }),

  placeOrder: (token: string, input: Record<string, unknown>) =>
    request<PlacedOrder>('/orders', { method: 'POST', token, body: input }),

  orders: (token: string) => request<{ orders: Array<{
    id: string; reference: string; status: string; total_estimated_cents: number;
    created_at: string;
  }> }>('/orders', { token }),

  order: (token: string, id: string) => request<OrderDetail>(`/orders/${id}`, { token }),

  cancelOrder: (token: string, id: string, reason: string) =>
    request<{ cancelled: boolean; terms: CancellationTerms }>(
      `/orders/${id}/cancel`, { method: 'POST', token, body: { reason } }),

  /**
   * Stands in for the provider's authentication page, which the simulated
   * provider does not have. Refused by the server unless the environment
   * explicitly allows simulated providers.
   */
  simulatePayment: (token: string, orderId: string) =>
    request<{ simulated: boolean; newStatus?: string }>(
      '/dev/simulate-payment', { method: 'POST', token, body: { orderId } }),

  rateOrder: (token: string, id: string, score: number, labels: string[], comment?: string) =>
    request<{ rated: boolean }>(
      `/orders/${id}/rate`, { method: 'POST', token, body: { score, labels, comment } }),
};
