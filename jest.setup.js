import dotenv from 'dotenv';

// Load development/local configuration first so we can compare safely.
dotenv.config({ path: '.env' });

const originalDatabaseUrl = process.env.DATABASE_URL;

// Load test-specific variables.
dotenv.config({ path: '.env.test', override: true });

if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is required for testing');
}

if (
  originalDatabaseUrl &&
  process.env.DATABASE_URL_TEST === originalDatabaseUrl
) {
  throw new Error(
    'CRITICAL: Test database URL must not be identical to development/production DATABASE_URL'
  );
}

if (
  !process.env.DATABASE_URL_TEST.includes('test')
) {
  throw new Error(
    'CRITICAL: DATABASE_URL_TEST must clearly point to a test database'
  );
}

// Keep the original URL only for safety validation.
process.env.ORIGINAL_DATABASE_URL = originalDatabaseUrl || '';

// IMPORTANT:
// PrismaClient will now be created using the test database from the beginning.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;   