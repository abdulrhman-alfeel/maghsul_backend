import logger from '../../config/logger.js';
import { startSocketInfrastructure, stopSocketInfrastructure, getSocketInfrastructureState, getSocketServer } from './socket-infrastructure.js';
import { startSocketRedisAdapter, stopSocketRedisAdapter, getSocketRedisAdapterState } from './socket-redis.adapter.js';
import { startRealtimeDispatcher, stopRealtimeDispatcher } from './realtime-dispatcher.js';

export function parseRealtimeFeatureFlag(value) {
  if (value === undefined || value === 'false') {
    return 'disabled';
  }
  if (value === 'true') {
    return 'enabled';
  }
  return 'configuration_invalid';
}

let applicationState = 'stopped';
let startupPromise = null;
let shutdownPromise = null;

export async function startRealtimeApplication({ httpServer }) {
  const flagState = parseRealtimeFeatureFlag(process.env.REALTIME_V2_ENABLED);

  if (flagState === 'disabled') {
    logger.info('Realtime Application: disabled by feature flag.');
    applicationState = 'disabled';
    return;
  }

  if (flagState === 'configuration_invalid') {
    logger.error('Realtime Application: invalid REALTIME_V2_ENABLED flag. Must be "true" or "false".');
    applicationState = 'failed';
    return;
  }

  if (['starting', 'ready', 'degraded'].includes(applicationState)) {
    if (startupPromise) {
      await startupPromise;
    }
    return;
  }

  startupPromise = (async () => {
    try {
      applicationState = 'starting';
      logger.info('Realtime Application: starting...');

      await startSocketInfrastructure(httpServer);
      
      const io = getSocketServer();
      await startSocketRedisAdapter(io);

      const infrastructureState = getSocketInfrastructureState();
      const adapterState = getSocketRedisAdapterState();
      
      if (infrastructureState === 'failed' || adapterState === 'failed') {
        applicationState = 'failed';
        logger.error(`Realtime Application: infrastructure state is ${infrastructureState}, adapter is ${adapterState}`);
      } else if (adapterState === 'degraded' || infrastructureState === 'degraded') {
        applicationState = 'degraded';
        logger.warn('Realtime Application: started in degraded state (Redis unavailable). REST API will continue.');
      } else {
        applicationState = 'ready';
        logger.info('Realtime Application: ready.');
      }

      startRealtimeDispatcher();
    } catch (err) {
      logger.error('Realtime Application: failed during startup', err);
      applicationState = 'failed';
    } finally {
      startupPromise = null;
    }
  })();

  await startupPromise;
}

export async function stopRealtimeApplication() {
  if (['stopped', 'disabled', 'failed'].includes(applicationState)) {
    return;
  }

  if (applicationState === 'stopping') {
    if (shutdownPromise) {
      await shutdownPromise;
    }
    return;
  }

  shutdownPromise = (async () => {
    try {
      applicationState = 'stopping';
      logger.info('Realtime Application: stopping...');

      await stopRealtimeDispatcher();
      await stopSocketInfrastructure();
      await stopSocketRedisAdapter();

      applicationState = 'stopped';
      logger.info('Realtime Application: stopped.');
    } catch (err) {
      logger.error('Realtime Application: failed during shutdown', err);
      applicationState = 'failed';
    } finally {
      shutdownPromise = null;
    }
  })();

  await shutdownPromise;
}

export function getRealtimeApplicationState() {
  const socketState = getSocketInfrastructureState();
  const redisState = getSocketRedisAdapterState();

  if (applicationState === 'ready' && (socketState === 'degraded' || redisState === 'degraded')) {
    applicationState = 'degraded';
  } else if (applicationState === 'degraded' && socketState === 'ready' && redisState === 'ready') {
    applicationState = 'ready';
  }

  const dispatcherState = (applicationState === 'ready' || applicationState === 'degraded') 
    ? (applicationState === 'ready' ? 'running' : 'paused') 
    : 'stopped';

  return {
    enabled: applicationState !== 'disabled',
    state: applicationState,
    socket: socketState,
    redisAdapter: redisState,
    dispatcher: dispatcherState
  };
}
