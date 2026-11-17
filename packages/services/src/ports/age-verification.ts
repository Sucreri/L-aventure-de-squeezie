/**
 * Age verification (spec 6.1, 4.7).
 *
 * CRITICAL: the result type carries a BRACKET and nothing else. There is
 * deliberately no field for a date of birth, a document number or an image,
 * so an adapter cannot hand one to the rest of the system even by accident.
 * This mirrors HYPOTHESES.md H-04 at the type level.
 */

import type { AgeBracket } from '@palette/domain';

export interface VerificationSession {
  readonly sessionId: string;
  /** Where the user completes the verification with the provider. */
  readonly url: string;
}

export interface VerificationResult {
  readonly sessionId: string;
  readonly succeeded: boolean;
  /** The ONLY age information this system ever receives. */
  readonly bracket: AgeBracket | null;
  readonly method: 'itsme' | 'psp_identity';
  readonly verifiedAt: Date;
  readonly failureReason?: string;
}

export interface AgeVerificationProvider {
  readonly name: 'itsme' | 'psp_identity' | 'mock';
  start(userId: string, redirectUri: string): Promise<VerificationSession>;
  complete(sessionId: string): Promise<VerificationResult>;
}
