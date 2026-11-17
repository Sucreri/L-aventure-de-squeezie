/**
 * Till receipt reading (spec 7.6).
 *
 * The amount is read automatically but MUST remain correctable by hand: an OCR
 * mistake would otherwise charge the client the wrong amount. The use case
 * therefore treats the read value as a suggestion, never as the truth.
 */

import type { Cents } from '@palette/domain';

export interface ReceiptReading {
  readonly amountCents: Cents | null;
  /** 0 to 1. Below the configured threshold the courier must confirm by hand. */
  readonly confidence: number;
}

export interface ReceiptReader {
  readonly name: string;
  read(photoPath: string): Promise<ReceiptReading>;
}
