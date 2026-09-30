import nodemailer from 'nodemailer';
import webPush from 'web-push';
import type { ProfileScope } from '../profile/profile.types.js';
import { NotificationRepository } from './notification.repository.js';
import { RetryableDeliveryError, type NotificationSender } from './notification.service.js';

export type NotificationProviderConfig = {
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPassword?: string;
  emailFrom?: string;
  vapidSubject?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
};

export function createNotificationSender(
  config: NotificationProviderConfig,
  repository: NotificationRepository,
): NotificationSender {
  const sender: NotificationSender = {};
  if (config.smtpHost && config.smtpPort && config.emailFrom) {
    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      ...(config.smtpUser && config.smtpPassword
        ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
        : {}),
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    sender.email = async (recipient, subject, body) => {
      await transport.sendMail({
        from: config.emailFrom,
        to: recipient,
        subject,
        text: body,
      });
    };
  }
  if (config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey) {
    webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    sender.push = async (scope: ProfileScope, subject, body) => {
      const subscriptions = await repository.subscriptions(scope);
      const payload = JSON.stringify({ title: subject, body, url: '/practice' });
      let delivered = false;
      for (const subscription of subscriptions) {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            { TTL: 3600 },
          );
          delivered = true;
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await repository.removeSubscription(scope, subscription.endpoint);
            continue;
          }
          if (statusCode === 429 && !delivered)
            throw new RetryableDeliveryError('Push service rate limit');
          throw error;
        }
      }
    };
  }
  return sender;
}
