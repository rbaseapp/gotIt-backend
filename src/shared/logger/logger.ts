import pino, { type DestinationStream, type Logger } from 'pino';

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
    },
    destination,
  );
}
