import Redis from 'ioredis';
import logger from '../../config/logger.js';

let publisherClient = null;
let subscriberClient = null;
let connectionState = 'stopped';

function getRedisOptions() {
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    autoResubscribe: true,
    autoResendUnfulfilledCommands: false,
    enableReadyCheck: true,
    retryStrategy(attempt) {
      return Math.min(attempt * 250, 5000);
    }
  };
}

function attachHandlers(client, role) {
  // Prevent duplicate handlers if re-initialized
  if (client._handlersAttached) return;
  client._handlersAttached = true;

  client.on('connect', () => {
    logger.info(`Socket Redis ${role} connected`);
  });

  client.on('ready', () => {
    logger.info(`Socket Redis ${role} ready`);
  });

  client.on('error', (err) => {
    logger.error(`Socket Redis ${role} error`, {
      clientRole: role,
      errorCode: err.code || 'UNKNOWN',
      sanitizedMessage: err.message,
      connectionState: client.status
    });
  });

  client.on('close', () => {
    logger.warn(`Socket Redis ${role} connection closed`);
  });

  client.on('reconnecting', (time) => {
    logger.warn(`Socket Redis ${role} reconnecting`, {
      clientRole: role,
      connectionState: client.status,
      retryDelayMs: time
    });
  });

  client.on('end', () => {
    logger.info(`Socket Redis ${role} connection ended`);
  });
}

/**
 * Starts the Redis connections independently for the Socket.IO Adapter.
 * This is safe to call multiple times.
 */
function safePatch(client, methodName) {
  if (typeof client[methodName] === 'function') {
    const original = client[methodName].bind(client);
    client[methodName] = (...args) => {
      const ret = original(...args);
      if (ret && ret.catch) ret.catch(() => {});
      return ret;
    };
  }
}

export async function startSocketRedisConnections() {
  if (connectionState === 'starting' || connectionState === 'ready') return;
  connectionState = 'starting';

  const redisUrl = process.env.NODE_ENV === 'test' 
    ? (process.env.REDIS_URL_TEST || 'redis://127.0.0.1:6380') 
    : (process.env.REDIS_URL || 'redis://localhost:6379');

  if (!publisherClient) {
    publisherClient = new Redis(redisUrl, getRedisOptions());
    attachHandlers(publisherClient, 'publisher');
  }

  if (!subscriberClient) {
    subscriberClient = new Redis(redisUrl, getRedisOptions());
    attachHandlers(subscriberClient, 'subscriber');
  }

  try {
    // Only attempt to connect if they are not already connecting/connected
    const promises = [];
    if (publisherClient.status === 'wait') promises.push(publisherClient.connect());
    if (subscriberClient.status === 'wait') promises.push(subscriberClient.connect());
    
    await Promise.all(promises);
    connectionState = 'ready';
  } catch (error) {
    connectionState = 'degraded';
    logger.error('Failed to start Socket Redis connections', {
      errorCode: error.code || 'UNKNOWN',
      sanitizedMessage: error.message
    });
    // Do not throw; we allow connections to fail and retry in the background
  }
}

export async function stopSocketRedisConnections() {
  connectionState = 'stopping';
  
  const closeClient = async (client) => {
    if (!client) return;
    client.removeAllListeners('connect');
    client.removeAllListeners('ready');
    client.removeAllListeners('error');
    client.removeAllListeners('close');
    client.removeAllListeners('reconnecting');
    client.removeAllListeners('end');

    if (client === subscriberClient) {
      try { await client.unsubscribe(); } catch (e) {}
    }

    try {
      await Promise.race([
        client.quit(),
        new Promise(resolve => setTimeout(resolve, 500))
      ]);
    } catch (e) {}
    client.disconnect();
  };

  await Promise.all([
    closeClient(subscriberClient),
    closeClient(publisherClient)
  ]);

  subscriberClient = null;
  publisherClient = null;
  connectionState = 'stopped';
}

export function getPublisherClient() {
  return publisherClient;
}

export function getSubscriberClient() {
  return subscriberClient;
}

export function getConnectionState() {
  return connectionState;
}
