/**
 * Simulated age verification.
 *
 * Note what it CANNOT do: there is no way for it to return a date of birth,
 * because VerificationResult has no field for one. That is the point — the
 * constraint is in the port, so no adapter, real or simulated, can leak more
 * than a bracket (HYPOTHESES.md H-04).
 */

import { randomUUID } from 'node:crypto';
import type {
  AgeVerificationProvider, VerificationSession, VerificationResult,
} from '../../ports/age-verification.ts';
import type { AgeBracket } from '@palette/domain';
import type { Clock } from '../../ports/clock.ts';
import { systemClock } from '../../ports/clock.ts';

export class MockAgeVerificationProvider implements AgeVerificationProvider {
  readonly name = 'mock' as const;
  private readonly sessions = new Map<string, { userId: string }>();
  /** Outcome to return per user; defaults to an adult. */
  private readonly outcomes = new Map<string, AgeBracket | 'fail'>();

  private readonly clock: Clock;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  /** Test helper: decide what the provider will answer for this user. */
  willReturn(userId: string, outcome: AgeBracket | 'fail'): void {
    this.outcomes.set(userId, outcome);
  }

  async start(userId: string, redirectUri: string): Promise<VerificationSession> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { userId });
    return {
      sessionId,
      url: `https://mock-itsme.invalid/verify/${sessionId}?redirect=${encodeURIComponent(redirectUri)}`,
    };
  }

  async complete(sessionId: string): Promise<VerificationResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session de vérification inconnue : ${sessionId}`);

    const outcome = this.outcomes.get(session.userId) ?? 'b18_plus';

    if (outcome === 'fail') {
      return {
        sessionId, succeeded: false, bracket: null, method: 'itsme',
        verifiedAt: this.clock.now(),
        failureReason: "la vérification d'identité n'a pas abouti",
      };
    }

    return {
      sessionId, succeeded: true, bracket: outcome, method: 'itsme',
      verifiedAt: this.clock.now(),
    };
  }
}
