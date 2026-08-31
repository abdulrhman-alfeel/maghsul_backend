import 'dotenv/config';
import http from 'http';
import { app } from './app.js';
import logger from './config/logger.js';
import { startRealtimeApplication, stopRealtimeApplication } from './modules/realtime/realtime-application.js';

// BullMQ Workers
import { startAccountDeletionWorker, stopAccountDeletionWorker } from './workers/accountDeletion.worker.js';

let isRunning = false;
let httpServer = null;

export async function startInfrastructure() {
  if (isRunning) {
    logger.warn('Infrastructure is already running');
    return;
  }

  const port = Number(process.env.PORT || 8080);
  
  httpServer = http.createServer(app);

  await new Promise((resolve) => {
    httpServer.listen(port, () => {
      logger.info(`Server running on http://localhost:${port}`);
      logger.info(`Swagger docs on http://localhost:${port}/docs`);
      resolve();
    });
  });

  await startAccountDeletionWorker();
  
  // Start Realtime V2 Orchestrator
  await startRealtimeApplication({ httpServer });
  
  isRunning = true;
}

let shutdownPromise = null;

export async function stopInfrastructure(signal) {
  if (!isRunning) {
    logger.warn('Infrastructure is not running or already stopped');
    return;
  }

  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    logger.info(`Shutting down infrastructure... ${signal ? `(Signal: ${signal})` : ''}`);
    
    // 1. Prevent new work by stopping Realtime Application (Dispatcher -> Socket -> Redis)
    await stopRealtimeApplication();

    // 2. Stop BullMQ Workers
    await stopAccountDeletionWorker();

    // 3. Close HTTP Server
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            logger.warn('HTTP Server close error', err);
            return resolve(); // Resolve anyway
          }
          logger.info('HTTP Server closed');
          resolve();
        });
      });
    }

    // 4. Disconnect Prisma
    const prisma = (await import('./config/db.js')).default;
    await prisma.$disconnect();
    logger.info('Database connections closed');

    isRunning = false;
    logger.info('Infrastructure fully stopped');
  })();

  return shutdownPromise;
}

function handleSignal(signal) {
  logger.info(`Received ${signal}`);
  stopInfrastructure(signal).then(() => {
    process.exitCode = 0;
  }).catch((err) => {
    logger.error('Error during shutdown:', err);
    process.exitCode = 1;
  });
}

export function registerSignalHandlers() {
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

export function unregisterSignalHandlers() {
  // We keep references so we can remove them if needed, 
  // but process.once handles self-removal upon execution.
  // We will not use process.removeAllListeners() to avoid interfering with other libs.
}

// Automatically start if this script is executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  registerSignalHandlers();
  startInfrastructure().catch((err) => {
    logger.error('Failed to start infrastructure:', err);
    process.exitCode = 1;
  });
}
