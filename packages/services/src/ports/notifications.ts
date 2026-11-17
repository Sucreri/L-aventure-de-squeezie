/**
 * Notifications (spec 8.8, 4.2).
 *
 * Consent and audience filtering are NOT this port's job: the database decides
 * who may receive what (app.marketing_audience). This port only delivers.
 */

export type NotificationChannel = 'push' | 'sms' | 'email';

export interface NotificationRequest {
  readonly channel: NotificationChannel;
  readonly to: string;
  readonly template: string;
  readonly data: Readonly<Record<string, string | number>>;
  /**
   * Spec 4.2: set when the message features an alcoholic product. The sender
   * refuses to deliver such a message without the health warning.
   */
  readonly mentionsAlcohol?: boolean;
  readonly healthWarning?: string;
}

export class MissingHealthWarningError extends Error {
  constructor() {
    super("Une communication mettant en avant un produit alcoolisé doit porter l'avertissement sanitaire.");
    this.name = 'MissingHealthWarningError';
  }
}

export interface NotificationSender {
  readonly name: string;
  send(request: NotificationRequest): Promise<{ readonly deliveryId: string }>;
}
