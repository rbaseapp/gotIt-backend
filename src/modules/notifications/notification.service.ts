import type { ProfileScope, ProfileServiceContract } from '../profile/profile.types.js';
import { NotificationRepository, type Delivery } from './notification.repository.js';
import type { NotificationPreferences } from './notification.policy.js';

export type NotificationSender = {
  email?: (recipient: string, subject: string, body: string, key: string) => Promise<void>;
  push?: (scope: ProfileScope, subject: string, body: string, key: string) => Promise<void>;
};

/** Use only when the provider explicitly rejected the request before delivery. */
export class RetryableDeliveryError extends Error {}

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly profiles: ProfileServiceContract,
    private readonly sender: NotificationSender = {},
    private readonly vapidPublicKey?: string,
  ) {}

  config() {
    return {
      emailAvailable: Boolean(this.sender.email),
      pushAvailable: Boolean(this.sender.push),
      vapidPublicKey: this.sender.push ? this.vapidPublicKey : undefined,
    };
  }

  async preferences(scope: ProfileScope) {
    const profile = await this.profiles.getProfile(scope);
    return { ...(await this.repository.getPreferences(scope)), timezone: profile.timezone };
  }

  async patchPreferences(
    scope: ProfileScope,
    patch: Partial<NotificationPreferences>,
    verifiedEmail?: string,
  ) {
    await this.profiles.getProfile(scope);
    return this.repository.patchPreferences(scope, patch, verifiedEmail);
  }

  async addSubscription(
    scope: ProfileScope,
    input: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    await this.profiles.getProfile(scope);
    await this.repository.addSubscription(scope, input);
  }

  async removeSubscription(scope: ProfileScope, endpoint: string) {
    await this.repository.removeSubscription(scope, endpoint);
  }

  async queueSystem(scope: ProfileScope, eventKey: string, subject: string, body: string) {
    if (
      !/^[a-zA-Z0-9:._-]{1,128}$/u.test(eventKey) ||
      !subject ||
      subject.length > 200 ||
      !body ||
      body.length > 2000
    )
      throw new Error('Invalid system notification');
    return this.repository.queueSystem(scope, eventKey, subject, body);
  }

  async run(now = new Date(), limit = 100) {
    await this.repository.expireLeases(now);
    await this.repository.suppressStale(now);
    const queued = await this.repository.queuePractice(now);
    const available = [
      ...(this.sender.email ? ['email' as const] : []),
      ...(this.sender.push ? ['push' as const] : []),
    ];
    let processed = 0;
    for (; processed < limit; processed += 1) {
      const delivery = await this.repository.claim(now, available);
      if (!delivery) break;
      await this.send(delivery, now);
    }
    return { queued, processed };
  }

  private async send(delivery: Delivery, now: Date) {
    const enabled = await this.repository.allowed(delivery);
    if (!enabled) {
      await this.repository.finish(delivery.id, 'suppressed', 'PREFERENCE_DISABLED');
      return;
    }
    const key = `${delivery.application_id}:${delivery.application_user_id}:${delivery.kind}:${delivery.channel}:${delivery.occurrence_key}`;
    try {
      if (delivery.channel === 'email') {
        if (!delivery.verified_email || !this.sender.email) throw new UnavailableError();
        await this.sender.email(delivery.verified_email, delivery.subject, delivery.body, key);
      } else {
        if (!this.sender.push) throw new UnavailableError();
        await this.sender.push(
          {
            applicationId: delivery.application_id,
            applicationUserId: delivery.application_user_id,
          },
          delivery.subject,
          delivery.body,
          key,
        );
      }
      await this.repository.finish(delivery.id, 'sent');
    } catch (error) {
      // A network/SMTP/Web Push failure after transmission is ambiguous. Never retry it automatically.
      if (error instanceof UnavailableError || error instanceof RetryableDeliveryError) {
        await this.repository.finish(
          delivery.id,
          'failed',
          error instanceof UnavailableError ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED',
          new Date(now.getTime() + Math.min(60, 2 ** delivery.attempts) * 60000),
        );
      } else {
        await this.repository.finish(delivery.id, 'uncertain', 'DELIVERY_UNCERTAIN');
      }
    }
  }
}

class UnavailableError extends Error {}
