/**
 * Simulated expense card provider.
 *
 * Reproduces the per-mission ceiling, so a test can observe the refusal at the
 * till rather than only in the database afterwards.
 */

import { randomUUID } from 'node:crypto';
import type { SpendCardProvider, MissionAuthorization } from '../../ports/spend-card.ts';

export class MockSpendCardProvider implements SpendCardProvider {
  readonly name = 'mock';
  private readonly authorizations = new Map<string, MissionAuthorization & { spent: number }>();

  async authorizeForMission(input: {
    cardRef: string; missionId: string; ceilingCents: number; expiresAt: Date;
  }): Promise<MissionAuthorization> {
    const authorization: MissionAuthorization = {
      authorizationId: randomUUID(),
      ceilingCents: input.ceilingCents,
      expiresAt: input.expiresAt,
    };
    this.authorizations.set(authorization.authorizationId, { ...authorization, spent: 0 });
    return authorization;
  }

  /** Simulates paying at the till. Refuses above the ceiling. */
  charge(authorizationId: string, amountCents: number): void {
    const a = this.authorizations.get(authorizationId);
    if (!a) throw new Error(`autorisation inconnue : ${authorizationId}`);
    if (a.spent + amountCents > a.ceilingCents) {
      throw new Error(
        `carte refusée en caisse : ${a.spent + amountCents} dépasse le plafond ${a.ceilingCents}`);
    }
    a.spent += amountCents;
  }

  async revoke(authorizationId: string): Promise<void> {
    this.authorizations.delete(authorizationId);
  }
}
