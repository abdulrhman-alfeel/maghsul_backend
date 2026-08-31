import { createAdapter } from '@socket.io/redis-adapter';
import { startSocketRedisConnections, stopSocketRedisConnections, getPublisherClient, getSubscriberClient, getConnectionState } from './socket-redis.connection.js';
import logger from '../../config/logger.js';

let adapterState = 'stopped';
let isAdapterAttached = false;

function getChannelPrefix() {
  const env = process.env.NODE_ENV || 'development';
  return `laundry:${env}:socket.io`;
}

/**
 * Ensures Redis connection state is actively monitored to sync adapterState.
 */
function monitorConnectionState() {
  const pubClient = getPublisherClient();
  const subClient = getSubscriberClient();

  if (!pubClient || !subClient) return;

  const handleError = () => {
    if (adapterState === 'degraded' || adapterState === 'stopping') return;
    logger.warn('Socket Redis connection lost. Transitioning to degraded state.');
    adapterState = 'degraded';
  };

  const updateState = () => {
    if (adapterState === 'stopping' || adapterState === 'stopped') return;
    
    if (pubClient.status === 'ready' && subClient.status === 'ready') {
      adapterState = 'ready';
    } else {
      adapterState = 'degraded';
    }
  };

  pubClient.on('error', handleError);
  subClient.on('error', handleError);
  pubClient.on('close', handleError);
  subClient.on('close', handleError);
  pubClient.on('ready', updateState);
  subClient.on('ready', updateState);
}

/**
 * Starts the Redis Adapter and attaches it to the Socket.IO server.
 * Uses a 10-second timeout to transition to 'ready' or 'degraded'.
 */
export async function startSocketRedisAdapter(io) {
  if (adapterState === 'starting' || adapterState === 'ready') {
    logger.warn('Socket Redis Adapter is already starting or ready');
    return;
  }

  adapterState = 'starting';

  try {
    // 1. Start connections
    await startSocketRedisConnections();

    const pubClient = getPublisherClient();
    const subClient = getSubscriberClient();

    if (!pubClient || !subClient) {
      throw new Error('Redis clients failed to initialize structurally');
    }

    // 2. Wait up to 10 seconds for both Redis clients to be ready
    await new Promise((resolve) => {
      let resolved = false;
      
      const cleanup = () => {
        pubClient.removeListener('ready', checkReady);
        subClient.removeListener('ready', checkReady);
      };

      const checkReady = () => {
        if (resolved) return;
        if (pubClient.status === 'ready' && subClient.status === 'ready') {
          resolved = true;
          clearTimeout(timeoutId);
          adapterState = 'ready';
          cleanup();
          resolve();
        }
      };

      if (pubClient.status === 'ready' && subClient.status === 'ready') {
        adapterState = 'ready';
        return resolve();
      }

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn('Socket Redis Adapter startup timeout reached. Transitioning to degraded.');
          adapterState = 'degraded';
          cleanup();
          resolve();
        }
      }, 10000);

      pubClient.on('ready', checkReady);
      subClient.on('ready', checkReady);
    });

    // 3. Attach adapter only after clients are ready
    if (!isAdapterAttached && adapterState === 'ready') {
      io.adapter(createAdapter(pubClient, subClient, {
        key: getChannelPrefix(),
        publishOnSpecificResponseChannel: true,
        requestsTimeout: 5000, // 5s timeout for specific response channels
      }));
      isAdapterAttached = true;
      monitorConnectionState();
    }

  } catch (err) {
    adapterState = 'failed';
    logger.error('Socket Redis Adapter failed to start structurally', { error: err.message });
  }
}

export async function stopSocketRedisAdapter() {
  adapterState = 'stopping';
  await stopSocketRedisConnections();
  adapterState = 'stopped';
  isAdapterAttached = false;
}

export function getSocketRedisAdapterState() {
  return adapterState;
}

export function isSocketRedisReady() {
  return adapterState === 'ready';
}
