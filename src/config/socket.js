import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import redis from './redis.js';

import logger from './logger.js';

let io;

export const initSocket = (httpServer) => {
  const pubClient = redis;
  const subClient = redis.duplicate();

  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || '').split(','),
      methods: ['GET', 'POST'],
    },
  });

  io.adapter(createAdapter(pubClient, subClient));

  io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    const role = socket.handshake.query.role;

    if (userId) {
      const userRoom = `user:${userId}`;
      socket.join(userRoom);
      logger.info('Socket: User joined room', { userId, role, room: userRoom });
    }

    socket.on('disconnect', () => {
      logger.info('Socket: User disconnected', { userId, role });
    });
  });

  logger.info('Socket.IO: Server initialized with Redis adapter.');
  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized!');
  }
  return io;
};

/**
 * Send real-time event to a specific user.
 */
export const emitToUser = (userId, event, data) => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
};

/**
 * Send real-time event to a role-based room (e.g. washers, drivers).
 * Users can join these rooms on connection based on their role.
 */
export const emitToRole = (role, event, data) => {
  if (io) {
    io.to(`role:${role}`).emit(event, data);
  }
};
