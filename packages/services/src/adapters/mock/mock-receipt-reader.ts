/**
 * Simulated receipt reader.
 *
 * Returns a low confidence by default, because that is the realistic case: an
 * OCR on a crumpled till receipt photographed in a shop is often unsure, and
 * the courier must be able to correct it (spec 7.6).
 */

import type { ReceiptReader, ReceiptReading } from '../../ports/receipt-reader.ts';

export class MockReceiptReader implements ReceiptReader {
  readonly name = 'mock';
  private readonly readings = new Map<string, ReceiptReading>();

  /** Test helper: decide what the reader returns for a given photo. */
  willRead(photoPath: string, reading: ReceiptReading): void {
    this.readings.set(photoPath, reading);
  }

  async read(photoPath: string): Promise<ReceiptReading> {
    return this.readings.get(photoPath) ?? { amountCents: null, confidence: 0 };
  }
}
