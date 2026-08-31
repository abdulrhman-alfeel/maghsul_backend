import { jest } from "@jest/globals";
import { validateEnv } from '../../utils/envValidator.js';

describe('Environment Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { 
      ...originalEnv,
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres',
      REDIS_URL: 'redis',
      ACCESS_TOKEN_SECRET: 'test',
      ACCESS_TOKEN_TTL_MINUTES: '15',
      PROVISIONAL_TOKEN_TTL_MINUTES: '15',
      REFRESH_TOKEN_TTL_DAYS: '30',
      OTP_TTL_MINUTES: '5',
      OTP_MAX_ATTEMPTS: '3',
      OTP_RESEND_COOLDOWN_SECONDS: '60',
      OTP_SEND_LIMIT: '5',
      OTP_SEND_WINDOW_MINUTES: '60',
      REFRESH_CONCURRENCY_WINDOW_SECONDS: '10',
      SESSION_CACHE_TTL_SECONDS: '900',
      SMS_PROVIDER: 'mock',
      ENABLE_LEGACY_AUTH_BRIDGE: 'true'
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should throw error if required env is missing', () => {
    delete process.env.ACCESS_TOKEN_SECRET;
    expect(() => validateEnv()).toThrow(/Missing required environment variables: ACCESS_TOKEN_SECRET/);
  });

  it('should pass if all required env vars are present', () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it('should throw error in production if ACCESS_TOKEN_SECRET is weak', () => {
    process.env.NODE_ENV = 'production';
    process.env.ACCESS_TOKEN_SECRET = 'weak';
    expect(() => validateEnv()).toThrow('Insecure ACCESS_TOKEN_SECRET for production environment.');
  });

  it('should throw error in production if SMS_PROVIDER is mock', () => {
    process.env.NODE_ENV = 'production';
    process.env.ACCESS_TOKEN_SECRET = 'a-very-long-secure-secret-key-that-is-at-least-32-chars';
    process.env.SMS_PROVIDER = 'mock';
    expect(() => validateEnv()).toThrow('Cannot use SMS_PROVIDER=mock in production environment.');
  });
});
