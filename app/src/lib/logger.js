import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'contentforge-app' },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      '*.anthropic_key',
      '*.anthropicKey',
      '*.password',
      '*.passwordHash',
      '*.password_hash'
    ],
    censor: '[REDACTED]'
  }
});
