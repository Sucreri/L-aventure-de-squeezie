/**
 * Corporate expense cards (spec 2).
 *
 * A courier never advances their own money, and a card is capped per mission.
 * The ceiling is also enforced in the database (trg_spend_ceiling); this port
 * asks the provider to apply it at the point of sale as well, so the refusal
 * happens at the till rather than after the fact.
 */

import type { Cents } from '@palette/domain';

export interface MissionAuthorization {
  readonly authorizationId: string;
  readonly ceilingCents: Cents;
  readonly expiresAt: Date;
}

export interface SpendCardProvider {
  readonly name: string;
  authorizeForMission(input: {
    readonly cardRef: string;
    readonly missionId: string;
    readonly ceilingCents: Cents;
    readonly expiresAt: Date;
  }): Promise<MissionAuthorization>;
  revoke(authorizationId: string): Promise<void>;
}
