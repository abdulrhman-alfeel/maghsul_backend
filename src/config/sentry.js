import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

import logger from './logger.js';

export const initSentry = (app) => {
  const dsn = process.env.SENTRY_DSN;
  
  if (!dsn) {
    logger.warn('Sentry: SENTRY_DSN not found. Error tracking is disabled.');
    return;
  }

  Sentry.init({
    dsn,
    integrations: [
      nodeProfilingIntegration(),
    ],
    // Performance Monitoring
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });

  logger.info('Sentry: Initialization complete.');
};

export const sentryErrorHandler = (app) => {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  // Modern Sentry v8/v10 error handler for Express
  Sentry.setupExpressErrorHandler(app);
};
