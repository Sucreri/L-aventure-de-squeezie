/**
 * The courier's offline action queue (spec 18).
 *
 * A courier works in a shop basement, in a lift, on a bike. The network comes
 * and goes, and the app has to keep working: ticking off items, photographing
 * a receipt, recording an age check, handing over.
 *
 * How it works. Every mutating courier action carries an `actionId` generated
 * HERE, before the request leaves. If the request fails for a network reason,
 * the action is queued and retried later. The server recognises an id it has
 * already handled and returns the original outcome instead of acting twice
 * (migration 0024), so a replay is safe by construction.
 *
 * What is deliberately NOT queued: anything whose refusal the courier must
 * see immediately. Handing over without a network connection would mean
 * telling someone the delivery succeeded before the server has checked the
 * age gate and the PIN — exactly the check spec 13 exists to enforce. Those
 * actions fail loudly instead.
 */

import { ApiError } from './api';

export interface QueuedAction {
  readonly actionId: string;
  readonly label: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly queuedAt: number;
  attempts: number;
  lastError?: string;
}

type Listener = (queue: readonly QueuedAction[]) => void;

/** Actions that must never be optimistically accepted while offline. */
const NEVER_QUEUED = ['/deliver', '/age-check'];

export function newActionId(): string {
  // crypto.randomUUID exists in Hermes and in every browser we target.
  const maybeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (maybeCrypto?.randomUUID) return maybeCrypto.randomUUID();

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

export class OfflineQueue {
  private queue: QueuedAction[] = [];
  private readonly listeners = new Set<Listener>();
  private syncing = false;

  constructor(
    private readonly send: (path: string, body: Record<string, unknown>) => Promise<unknown>,
  ) {}

  get pending(): readonly QueuedAction[] {
    return this.queue;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.queue);
    return () => this.listeners.delete(listener);
  }

  /**
   * Performs an action, queueing it if the network is unavailable.
   *
   * Returns the server's answer when it reached the server, or `queued` when
   * it did not. A rule refusal (4xx) is NEVER queued: the server has spoken,
   * and retrying would not change its mind.
   */
  async perform<T>(input: {
    label: string;
    path: string;
    body?: Record<string, unknown>;
    /** Set for actions that must not be optimistically accepted. */
    requiresNetwork?: boolean;
  }): Promise<{ status: 'done'; result: T } | { status: 'queued'; actionId: string }> {
    const actionId = newActionId();
    const body = { ...(input.body ?? {}), actionId };

    try {
      const result = await this.send(input.path, body) as T;
      return { status: 'done', result };
    } catch (error) {
      const offline = error instanceof ApiError && error.status === 0;
      const mustReachServer = input.requiresNetwork
        || NEVER_QUEUED.some(fragment => input.path.includes(fragment));

      if (!offline || mustReachServer) {
        throw error;
      }

      this.queue.push({
        actionId, label: input.label, path: input.path, body,
        queuedAt: Date.now(), attempts: 1,
      });
      this.notify();

      return { status: 'queued', actionId };
    }
  }

  /**
   * Replays the queue, oldest first.
   *
   * Stops at the first action that is still offline, so order is preserved:
   * "I'm at the shop" must not arrive after "I've left".
   */
  async sync(): Promise<{ sent: number; remaining: number }> {
    if (this.syncing) return { sent: 0, remaining: this.queue.length };
    this.syncing = true;
    let sent = 0;

    try {
      while (this.queue.length > 0) {
        const action = this.queue[0]!;

        try {
          await this.send(action.path, action.body);
          this.queue.shift();
          sent += 1;
          this.notify();
        } catch (error) {
          action.attempts += 1;
          action.lastError = error instanceof Error ? error.message : String(error);

          if (error instanceof ApiError && error.status === 0) {
            break;   // still offline: keep the order, try again later
          }

          // The server answered and refused. Retrying will not help, so the
          // action is dropped from the queue and surfaced to the courier.
          this.queue.shift();
          this.notify();
        }
      }
    } finally {
      this.syncing = false;
    }

    return { sent, remaining: this.queue.length };
  }

  clear(): void {
    this.queue = [];
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener([...this.queue]);
  }
}
