import logger from '../config/logger.js';

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'FIREBASE_SERVICE_ACCOUNT_PATH',
];

export const validateEnv = () => {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  
  if (missing.length > 0) {
    logger.error('CRITICAL: Missing required environment variables: %s', missing.join(', '));
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }

  const optionalS3 = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'];
  const missingS3 = optionalS3.filter((v) => !process.env[v]);
  if (missingS3.length > 0) {
    logger.warn('S3 Storage: Missing some S3 variables (%s). Falling back to local storage.', missingS3.join(', '));
  }

  logger.info('Environment validation successful.');
};
