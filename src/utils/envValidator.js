export function validateEnv() {
  const required = [
    'NODE_ENV',
    'DATABASE_URL',
    'REDIS_URL',
    'ACCESS_TOKEN_SECRET',
    'ACCESS_TOKEN_TTL_MINUTES',
    'PROVISIONAL_TOKEN_TTL_MINUTES',
    'REFRESH_TOKEN_TTL_DAYS',
    'OTP_TTL_MINUTES',
    'OTP_MAX_ATTEMPTS',
    'OTP_RESEND_COOLDOWN_SECONDS',
    'OTP_SEND_LIMIT',
    'OTP_SEND_WINDOW_MINUTES',
    'REFRESH_CONCURRENCY_WINDOW_SECONDS',
    'SESSION_CACHE_TTL_SECONDS',
    'SMS_PROVIDER',
    'ENABLE_LEGACY_AUTH_BRIDGE'
  ];

  const missing = [];
  for (const req of required) {
    if (!process.env[req]) {
      missing.push(req);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Security Check: Production must not use weak secrets or mock providers
  if (process.env.NODE_ENV === 'production') {
    if (process.env.ACCESS_TOKEN_SECRET.length < 32 || process.env.ACCESS_TOKEN_SECRET === 'super-strong-jwt-secret-key-change-in-prod') {
      throw new Error('Insecure ACCESS_TOKEN_SECRET for production environment.');
    }
    if (process.env.SMS_PROVIDER === 'mock') {
      throw new Error('Cannot use SMS_PROVIDER=mock in production environment.');
    }
    if (!process.env.MOYASAR_SECRET_KEY || process.env.MOYASAR_SECRET_KEY.includes('sk_test_xxxxxxxxx')) {
      throw new Error('Invalid or missing MOYASAR_SECRET_KEY for production environment.');
    }
    if (!process.env.MOYASAR_WEBHOOK_SECRET) {
      throw new Error('Missing MOYASAR_WEBHOOK_SECRET for production environment.');
    }
  }
}
