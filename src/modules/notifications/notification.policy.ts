import { z } from 'zod';

export const preferencePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    reminderMinute: z.number().int().min(0).max(59).optional(),
    reminderDays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    quietEnabled: z.boolean().optional(),
    quietStart: z.number().int().min(0).max(1439).optional(),
    quietEnd: z.number().int().min(0).max(1439).optional(),
    streakEmail: z.boolean().optional(),
    streakPush: z.boolean().optional(),
    weeklyEmail: z.boolean().optional(),
    weeklyPush: z.boolean().optional(),
    practiceEmail: z.boolean().optional(),
    practicePush: z.boolean().optional(),
    systemEmail: z.boolean().optional(),
    systemPush: z.boolean().optional(),
    reminderHour: z.number().int().min(0).max(23).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

export type NotificationPreferences = {
  enabled?: boolean;
  reminderMinute?: number;
  reminderDays?: number[];
  quietEnabled?: boolean;
  quietStart?: number;
  quietEnd?: number;
  streakEmail?: boolean;
  streakPush?: boolean;
  weeklyEmail?: boolean;
  weeklyPush?: boolean;
  practiceEmail: boolean;
  practicePush: boolean;
  systemEmail: boolean;
  systemPush: boolean;
  reminderHour: number;
};

export const subscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.port &&
          ([
            'fcm.googleapis.com',
            'updates.push.services.mozilla.com',
            'web.push.apple.com',
          ].includes(url.hostname) ||
            url.hostname.endsWith('.notify.windows.com'))
        );
      }, 'Unsupported push service endpoint'),
    keys: z
      .object({
        p256dh: z.string().min(1).max(512),
        auth: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

export function practiceOccurrence(now: Date, timezone: string, hour: number): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  if (Number(part('hour')) < hour) return null;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function eligibleChannels(
  kind: 'practice' | 'system',
  preferences: NotificationPreferences,
  hasVerifiedEmail: boolean,
  hasPushSubscription: boolean,
): Array<'email' | 'push'> {
  const emailEnabled = kind === 'practice' ? preferences.practiceEmail : preferences.systemEmail;
  const pushEnabled = kind === 'practice' ? preferences.practicePush : preferences.systemPush;
  return [
    ...(emailEnabled && hasVerifiedEmail ? ['email' as const] : []),
    ...(pushEnabled && hasPushSubscription ? ['push' as const] : []),
  ];
}
