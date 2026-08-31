import logger from '../../config/logger.js';
import { getFirebaseProvider } from './firebase.provider.js';
import { getBullMQWorkerConnection, closeBullMQWorkerConnection } from '../../config/bullmq-worker.connection.js';
import { startNotificationWorker, stopNotificationWorker, getWorker } from './notification.worker.js';
import { startQueueEvents, stopQueueEvents } from './notification.queue-events.js';
import { start as startDispatcher, stop as stopDispatcher } from './notification-outbox.dispatcher.js';

let isInfrastructureRunning = false;

async function startNotificationInfrastructure() {
  if (isInfrastructureRunning) {
    logger.warn('notification-infrastructure: already running');
    return;
  }

  logger.info('notification-infrastructure: starting components...');
  try {
    // 1. Check Firebase config and start Provider
    if (!process.env.FIREBASE_PROJECT_ID) {
      logger.warn('notification-infrastructure: FIREBASE_PROJECT_ID missing, some firebase functionality might fail');
    }
    const firebaseProvider = getFirebaseProvider();
    firebaseProvider.start();

    // 2. Start Worker
    await startNotificationWorker();
    const worker = getWorker();
    
    // 3. Wait for Worker Readiness
    if (worker && typeof worker.waitUntilReady === 'function') {
      try {
        // waitUntilReady returns a Promise
        await Promise.race([
          worker.waitUntilReady(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Worker readiness timeout (15s)')), 15000))
        ]);
      } catch (err) {
        logger.error('notification-infrastructure: worker readiness failed', { errorCode: err.message });
        throw err;
      }
    } else if (worker) {
      // Fallback if waitUntilReady is not available
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // 4. Start QueueEvents
    startQueueEvents();

    // 5. Start Dispatcher
    await startDispatcher();

    isInfrastructureRunning = true;
    logger.info('notification-infrastructure: successfully started all components');
  } catch (error) {
    logger.error('notification-infrastructure: startup failed, rolling back...', { errorCode: error.message });
    // Rollback any started components
    await stopNotificationInfrastructure(true); // pass true to indicate it's a rollback
    throw error;
  }
}

async function stopNotificationInfrastructure(isRollback = false) {
  if (!isInfrastructureRunning && !isRollback) {
    logger.info('notification-infrastructure: not running, nothing to stop');
    return;
  }

  logger.info('notification-infrastructure: stopping components...');

  // 1. Stop Dispatcher (stops polling)
  try {
    await stopDispatcher();
  } catch (e) {
    logger.error('notification-infrastructure: failed to stop dispatcher', { errorCode: e.message });
  }

  // 2. Stop Worker (waits for active jobs)
  try {
    await stopNotificationWorker();
  } catch (e) {
    logger.error('notification-infrastructure: failed to stop worker', { errorCode: e.message });
  }

  // 3. Stop QueueEvents
  try {
    await stopQueueEvents();
  } catch (e) {
    logger.error('notification-infrastructure: failed to stop queue-events', { errorCode: e.message });
  }

  // 4. Close Redis connection for Worker
  try {
    await closeBullMQWorkerConnection();
  } catch (e) {
    logger.error('notification-infrastructure: failed to close worker redis', { errorCode: e.message });
  }

  // 5. Stop Firebase Provider
  try {
    const firebaseProvider = getFirebaseProvider();
    firebaseProvider.stop();
  } catch (e) {
    logger.error('notification-infrastructure: failed to stop firebase provider', { errorCode: e.message });
  }

  isInfrastructureRunning = false;
  logger.info('notification-infrastructure: stopped');
}

function getNotificationInfrastructureState() {
  return isInfrastructureRunning;
}

export {
  startNotificationInfrastructure,
  stopNotificationInfrastructure,
  getNotificationInfrastructureState,
};
