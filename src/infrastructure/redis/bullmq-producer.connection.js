import Redis from 'ioredis';

let producerConnection = null;

export function start(redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379') {
  if (producerConnection) {
    return;
  }

  producerConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy(times) {
      // Endless background reconnect but with delay so it doesn't spin
      return Math.min(times * 500, 5000);
    }
  });

  producerConnection.on('error', (err) => {
    // Prevent unhandled error events from crashing the process
    console.error(`BullMQ Producer Redis error: ${err.message}`);
  });
}

export async function stop() {
  if (!producerConnection) {
    return;
  }
  
  try {
    await producerConnection.quit();
  } catch (err) {
    producerConnection.disconnect();
  } finally {
    producerConnection = null;
  }
}

export function getConnection() {
  if (!producerConnection) {
    throw new Error('Producer connection is not started');
  }
  return producerConnection;
}
