import { jest } from "@jest/globals";
import { setupTestDb } from '../integration/test-utils.js';

describe('Test Database Guards', () => {
  let originalEnvVars;

  beforeEach(() => {
    jest.resetModules();
    originalEnvVars = {
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_TEST: process.env.DATABASE_URL_TEST,
      ORIGINAL_DATABASE_URL: process.env.ORIGINAL_DATABASE_URL,
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnvVars.NODE_ENV;
    process.env.DATABASE_URL = originalEnvVars.DATABASE_URL;
    process.env.DATABASE_URL_TEST = originalEnvVars.DATABASE_URL_TEST;
    process.env.ORIGINAL_DATABASE_URL = originalEnvVars.ORIGINAL_DATABASE_URL;
  });

  it('should reject execution in production environment', async () => {
    process.env.NODE_ENV = 'production';
    await expect(setupTestDb()).rejects.toThrow('CRITICAL: Cannot run tests in production environment');
  });

  it('should reject execution if DATABASE_URL_TEST is not provided', async () => {
    delete process.env.DATABASE_URL_TEST;
    await expect(setupTestDb()).rejects.toThrow('DATABASE_URL_TEST is required for testing');
  });

  it('should reject execution if DATABASE_URL_TEST matches ORIGINAL_DATABASE_URL', async () => {
    process.env.ORIGINAL_DATABASE_URL = 'postgres://localhost/prod_db';
    process.env.DATABASE_URL_TEST = 'postgres://localhost/prod_db';
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
    await expect(setupTestDb()).rejects.toThrow('CRITICAL: Test database URL must not be identical to development/production DATABASE_URL');
  });

  it('should reject execution if DATABASE_URL_TEST does not indicate a test database', async () => {
    process.env.ORIGINAL_DATABASE_URL = 'postgres://localhost/real_production_db';
    process.env.DATABASE_URL_TEST = 'postgres://localhost/laundry_db_production'; // No 'test' in it
    process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
    await expect(setupTestDb()).rejects.toThrow('CRITICAL: Test database URL must clearly point to a test database');
  });
});
