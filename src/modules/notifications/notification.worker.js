import { Worker, UnrecoverableError } from 'bullmq';
import logger from '../../config/logger.js';
import { getBullMQWorkerConnection } from '../../config/bullmq-worker.connection.js';
import { processEvent } from './notification-delivery.service.js';
import { getFirebaseProvider } from './firebase.provider.js';

let worker = null;

const DISALLOWED_PAYLOAD_KEYS = [
  'fcmToken',
  'tokenHash',
  'rawToken',
  'invitedPhone',
  'accessToken',
  'refreshToken',
];

function backoffStrategy(attemptsMade, type, error, job) {
  const exponentialDelay = Math.min(
    60_000 * (2 ** Math.max(attemptsMade - 1, 0)),
    60 * 60 * 1000 // 1 hour max
  );
  
  // Add jitter (down to 50% of the calculated exponential delay)
  const jitterFactor = 0.5 + Math.random() * 0.5;
  let finalDelay = Math.floor(exponentialDelay * jitterFactor);

  if (error && error.retryAfterMs) {
    // If rate limit or similar error explicitly tells us to wait
    finalDelay = Math.max(finalDelay, error.retryAfterMs, 60_000); // at least 1 min
  }

  return Math.min(finalDelay, 60 * 60 * 1000); // Cap at 1 hour always
}

async function startNotificationWorker(concurrency = 5) {
  if (worker) {
    logger.warn('notification-worker: start called but worker is already running');
    return;
  }

  const connection = getBullMQWorkerConnection();
  
  worker = new Worker(
    'push-notifications-v2',
    async (job) => {
      // 1. Validate Job Core
      if (job.name !== 'notification.dispatch') {
        logger.error('notification-worker: unsupported job name', { 
          jobId: job.id, 
          jobName: job.name 
        });
        throw new UnrecoverableError('job_payload_mismatch: unsupported_job_name');
      }

      if (!job.data || !job.data.eventId || !job.data.payloadVersion) {
        logger.error('notification-worker: missing required payload fields', { 
          jobId: job.id 
        });
        throw new UnrecoverableError('job_payload_mismatch: missing_required_fields');
      }

      // 2. Validate No Sensitive Information
      const hasSensitiveKeys = DISALLOWED_PAYLOAD_KEYS.some((key) => key in job.data);
      if (hasSensitiveKeys) {
        logger.error('notification-worker: sensitive fields found in payload', { 
          jobId: job.id 
        });
        throw new UnrecoverableError('job_payload_mismatch: sensitive_data_rejected');
      }

      const expectedJobId = `notification-${job.data.eventId}`;
      if (job.id !== expectedJobId) {
        logger.error('notification-worker: jobId mismatch', { 
          jobId: job.id,
          expectedId: expectedJobId 
        });
        throw new UnrecoverableError('job_payload_mismatch: invalid_job_id');
      }

      // 3. Build Attempt Context
      const maximumAttempts = job.opts.attempts ?? 1;
      const currentAttempt = job.attemptsMade + 1;
      const isFinalAttempt = currentAttempt >= maximumAttempts;

      const attemptContext = {
        attemptsMade: job.attemptsMade,
        maximumAttempts,
        currentAttempt,
        isFinalAttempt,
      };

      const startTime = Date.now();

      // 4. Delegate to Delivery Service
      try {
        await processEvent(job.data.eventId, attemptContext, {
          workerId: worker.id,
          firebaseProvider: getFirebaseProvider(),
        });

        logger.info('notification-worker: job completed successfully', {
          eventId: job.data.eventId,
          jobId: job.id,
          workerId: worker.id,
          attemptNumber: currentAttempt,
          durationMs: Date.now() - startTime,
        });

      } catch (error) {
        const durationMs = Date.now() - startTime;
        
        logger.error('notification-worker: job execution error', {
          eventId: job.data.eventId,
          jobId: job.id,
          workerId: worker.id,
          attemptNumber: currentAttempt,
          errorClass: error.constructor.name,
          errorCode: error.message,
          durationMs,
        });

        // 5. Error Translation
        if (
          error.constructor.name === 'PermanentNotificationError' ||
          error.message === 'job_payload_mismatch' ||
          error.message === 'unsupported_event_type' ||
          error.message === 'business_configuration_error'
        ) {
          // Tell BullMQ to never retry this job
          throw new UnrecoverableError(error.message);
        }

        // Lease collisions or lost leases are retryable
        if (
          error.message === 'processing_lease_owned_by_another_worker' || 
          error.message.includes('processing_lease_lost') ||
          error.constructor.name === 'RetryableNotificationError'
        ) {
          // Standard error so BullMQ will retry it
          const standardError = new Error(error.message);
          if (error.retryAfterMs) standardError.retryAfterMs = error.retryAfterMs;
          throw standardError;
        }

        // Fallback for unknown errors (treat as retryable)
        throw error;
      }
    },
    {
      connection,
      concurrency,
      settings: {
        backoffStrategy,
      },
    }
  );

  worker.on('error', (err) => {
    logger.error('notification-worker: internal error', { errorCode: err.message });
  });

  logger.info('notification-worker: started', { concurrency });
}

async function stopNotificationWorker() {
  if (worker) {
    logger.info('notification-worker: stopping...');
    await worker.close();
    worker = null;
    logger.info('notification-worker: stopped');
  }
}

function getWorker() {
  return worker;
}

function isRunning() {
  return worker !== null;
}

export {
  startNotificationWorker,
  stopNotificationWorker,
  getWorker,
  isRunning,
  backoffStrategy, // exported for testing
};
