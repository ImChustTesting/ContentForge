import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'contentforge-worker' },
  redact: {
    paths: [
      '*.anthropic_key',
      '*.anthropicKey',
      '*.anthropic_api_key',
      '*.password',
      '*.passwordHash',
      '*.password_hash'
    ],
    censor: '[REDACTED]'
  }
});
