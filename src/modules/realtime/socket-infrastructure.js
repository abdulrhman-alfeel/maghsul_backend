import { Server } from 'socket.io';
import { SOCKET_CONNECTION_STATE, SOCKET_PATH, SOCKET_NAMESPACE, SOCKET_ERRORS, SOCKET_SETTINGS } from './socket.constants.js';
import { socketAuthMiddleware } from './socket-auth.middleware.js';
import { createSocketContextResolver } from './socket-context.resolver.js';
import { SocketRoomService } from './socket-room.service.js';
import { startSocketRedisAdapter, stopSocketRedisAdapter, getSocketRedisAdapterState } from './socket-redis.adapter.js';
import logger from '../../config/logger.js';

let io = null;
let state = SOCKET_CONNECTION_STATE.STOPPED;

const expiryTimers = new Map(); // socket.id -> timer

export function getSocketInfrastructureState() {
  if (process.env.NODE_ENV === 'test' && process.env.MOCK_SOCKET_STATE) {
    return process.env.MOCK_SOCKET_STATE;
  }
  if (state === SOCKET_CONNECTION_STATE.READY || state === SOCKET_CONNECTION_STATE.DEGRADED) {
    const adapterState = getSocketRedisAdapterState();
    if (adapterState === 'degraded') return SOCKET_CONNECTION_STATE.DEGRADED;
    if (adapterState === 'ready') return SOCKET_CONNECTION_STATE.READY;
  }
  return state;
}

export function getSocketServer() {
  return io;
}

export function createSocketServer(httpServer, options = {}) {
  const defaultOptions = {
    path: SOCKET_PATH,
    serveClient: false,
    connectionStateRecovery: false,
    transports: ['websocket'], // polling is disabled here if we only want websocket
    allowUpgrades: false,
    maxHttpBufferSize: SOCKET_SETTINGS.maxHttpBufferSize,
    connectTimeout: SOCKET_SETTINGS.connectTimeout,
    pingInterval: SOCKET_SETTINGS.pingInterval,
    pingTimeout: SOCKET_SETTINGS.pingTimeout,
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      // Allow if no origin (mobile app / native)
      if (!origin) {
        return callback(null, true);
      }
      const allowedOrigins = options.allowedOrigins || [];
      if (allowedOrigins.length > 0) {
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback('Origin forbidden', false);
      }
      if (process.env.NODE_ENV === 'test' || origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return callback(null, true);
      }
      return callback('Origin forbidden', false);
    }
  };

  return new Server(httpServer, { ...defaultOptions, ...options });
}

export async function startSocketInfrastructure(httpServer, options = {}) {
  if (state === SOCKET_CONNECTION_STATE.STARTING || state === SOCKET_CONNECTION_STATE.READY) {
    logger.warn('Socket infrastructure is already starting or ready.');
    return;
  }

  state = SOCKET_CONNECTION_STATE.STARTING;

  try {
    io = createSocketServer(httpServer, options);

    // Note: Redis adapter is attached separately by the realtime application orchestrator.

    const namespace = io.of(SOCKET_NAMESPACE);

    // Readiness Gate Middleware
    namespace.use((socket, next) => {
      const currentState = getSocketInfrastructureState();
      if (currentState === SOCKET_CONNECTION_STATE.DEGRADED) {
        const err = new Error('Realtime Infrastructure Unavailable');
        err.data = { code: SOCKET_ERRORS.SOCKET_REALTIME_UNAVAILABLE };
        return next(err);
      }
      next();
    });

    // Use pure auth middleware (only structural checks)
    namespace.use(socketAuthMiddleware);

    // Resolve Context and Verify State
    const resolveContext = createSocketContextResolver();

    namespace.use(async (socket, next) => {
      try {
        const rawAccessToken = socket.data.rawAccessToken;
        const context = await resolveContext(rawAccessToken);
        socket.data.context = context;
        next();
      } catch (err) {
        // Map to standard socket error if available
        if (err.data && err.data.code) {
          next(err);
        } else {
          const unknownErr = new Error('Authentication failed');
          unknownErr.data = { code: SOCKET_ERRORS.SOCKET_AUTH_REQUIRED };
          next(unknownErr);
        }
      }
    });

    namespace.on('connection', async (socket) => {
      const context = socket.data.context;

      // Disconnect any existing sockets for this session (Overlap Prevention)
      if (context.sessionId) {
        const sessionRoom = `session:${context.sessionId}`;
        const existingSockets = await namespace.in(sessionRoom).fetchSockets();
        for (const s of existingSockets) {
          if (s.id !== socket.id) {
            s.disconnect(true);
          }
        }
      }

      // Join Rooms
      SocketRoomService.applyJoiningPolicy(socket);

      // Setup Access Token Expiry Timer
      if (context.accessTokenExpiresAt && !isNaN(context.accessTokenExpiresAt.getTime())) {
        const expiresInMs = context.accessTokenExpiresAt.getTime() - Date.now();
        if (expiresInMs <= 0) {
          socket.disconnect(true);
        } else {
          const timer = setTimeout(() => {
            if (socket.connected) {
              socket.disconnect(true);
            }
          }, expiresInMs);
          if (timer.unref) timer.unref();
          expiryTimers.set(socket.id, timer);
        }
      }

      // No custom business event handlers
      // We block any custom events per requirements.
      socket.onAny((eventName, ...args) => {
        const lastArg = args[args.length - 1];
        if (typeof lastArg === 'function') {
          lastArg({ error: SOCKET_ERRORS.SOCKET_CLIENT_EVENTS_DISABLED });
        }
      });

      socket.on('disconnect', (reason) => {
        // Clear Timer
        const timer = expiryTimers.get(socket.id);
        if (timer) {
          clearTimeout(timer);
          expiryTimers.delete(socket.id);
        }
      });
    });

    state = SOCKET_CONNECTION_STATE.READY;
    logger.info(`Socket.IO infrastructure started successfully in ${state} state.`);
  } catch (error) {
    state = SOCKET_CONNECTION_STATE.FAILED;
    logger.error('Failed to start Socket.IO infrastructure', error);
    throw error;
  }
}

export async function stopSocketInfrastructure() {
  if (state === SOCKET_CONNECTION_STATE.STOPPED || state === SOCKET_CONNECTION_STATE.STOPPING) {
    return;
  }

  state = SOCKET_CONNECTION_STATE.STOPPING;

  if (io) {
    try {
      const adapterState = getSocketRedisAdapterState();
      if (adapterState === 'ready') {
        const res = io.disconnectSockets(true);
        if (res && typeof res.catch === 'function') {
          await res.catch((e) => {
            logger.warn('Notice during disconnectSockets shutdown:', { error: e.message });
          });
        }
      } else {
        // Fallback to direct local socket disconnection when Redis is down/degraded
        for (const socket of io.of(SOCKET_NAMESPACE).sockets.values()) {
          socket.disconnect(true);
        }
      }
    } catch (e) {
      logger.warn('Notice during disconnectSockets shutdown:', { error: e.message });
    }
    
    try {
      await new Promise((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 1000);

        if (io.httpServer) {
          io.close(() => {
            if (!resolved) {
              clearTimeout(timeout);
              resolved = true;
              resolve();
            }
          });
        } else {
          // In some test environments, httpServer might not be attached to io.
          if (!resolved) {
            clearTimeout(timeout);
            resolved = true;
            resolve();
          }
        }
      });
    } catch (e) {
      logger.error('Error closing IO', { error: e.message });
    }

    // Note: Redis adapter is stopped separately by the realtime application orchestrator.
    
    io = null;
  }

  state = SOCKET_CONNECTION_STATE.STOPPED;
  logger.info('Socket.IO infrastructure stopped.');

  // Clear all timers
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
}
