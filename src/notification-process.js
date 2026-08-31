import logger from ../config/logger.js';
import { startNotificationInfrastructure, stopNotificationInfrastructure } from './modules/notifications/notification-infrastructure.js';

async function main() {
  try {
    logger.info('notification-process: initializing standalone notification worker process');
    
    // Explicitly handle signals for graceful shutdown
    const shutdown = async (signal) => {
      logger.info(`notification-process: received ${signal}, initiating graceful shutdown`);
      try {
        await stopNotificationInfrastructure();
        logger.info('notification-process: shutdown complete');
      } catch (error) {
        logger.error('notification-process: error during shutdown', { errorCode: error.message });
        process.exitCode = 1;
      }
    };

    // Ensure we only register handlers once
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    // Start the infrastructure
    await startNotificationInfrastructure();
    
    logger.info('notification-process: standalone process is running successfully');

  } catch (error) {
    logger.error('notification-process: fatal startup error', { errorCode: error.message });
    process.exitCode = 1;
  }
}

// Start only if this file is executed directly (not required/imported)
if (require.main === module) {
  main();
}

export {
  main // exported for testing if needed
};
