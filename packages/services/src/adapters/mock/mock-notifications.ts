/**
 * Simulated notification sender.
 *
 * It enforces one rule of its own, deliberately: a message flagged as
 * featuring an alcoholic product is REFUSED without the health warning
 * (spec 4.2). Putting that check in the sender means no caller can forget it,
 * whatever the channel.
 */

import { randomUUID } from 'node:crypto';
import type { NotificationSender, NotificationRequest } from '../../ports/notifications.ts';
import { MissingHealthWarningError } from '../../ports/notifications.ts';

export interface SentNotification extends NotificationRequest {
  readonly deliveryId: string;
  readonly sentAt: Date;
}

export class MockNotificationSender implements NotificationSender {
  readonly name = 'mock';
  readonly sent: SentNotification[] = [];

  async send(request: NotificationRequest): Promise<{ deliveryId: string }> {
    if (request.mentionsAlcohol && !request.healthWarning) {
      throw new MissingHealthWarningError();
    }

    const deliveryId = randomUUID();
    this.sent.push({ ...request, deliveryId, sentAt: new Date() });
    return { deliveryId };
  }

  sentTo(recipient: string): SentNotification[] {
    return this.sent.filter(n => n.to === recipient);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
