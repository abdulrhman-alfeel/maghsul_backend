/**
 * Realtime Publisher
 *
 * Emits a Socket.IO event to a list of rooms using the active io server.
 * Best-effort: if infrastructure is degraded, it logs and returns explicit results.
 * It DOES NOT update the database.
 *
 * Returns one of:
 * - { outcome: 'emitted', emitted: true, roomCount: N }
 * - { outcome: 'retryable_unavailable', emitted: false, reasonCode: '...' }
 * - { outcome: 'no_recipients', emitted: false, reasonCode: 'no_logical_recipients' }
 * - { outcome: 'permanent_failure', emitted: false, reasonCode: '...' }
 *
 * Architecture note: Uses `.local` to emit directly to sockets on THIS process,
 * bypassing the Redis Adapter's cross-node Pub/Sub routing. In a multi-node cluster,
 * the Dispatcher runs on every node independently (BullMQ workers), so each node
 * delivers the event to its own locally-connected clients. Redis is used for
 * room membership tracking and Dispatcher coordination — NOT for delivery fanout.
 * This design is faster, simpler, and avoids Pub/Sub subscription-timing races.
 */
import { getSocketServer, getSocketInfrastructureState } from './socket-infrastructure.js';
import { SOCKET_NAMESPACE } from './socket.constants.js';
import logger from '../../config/logger.js';

export class RealtimePublisher {
  /**
   * Emits an event to a list of Socket.IO rooms.
   *
   * @param {{ eventId: string, eventType: string, eventVersion: number, occurredAt: string }} meta
   * @param {string[]} rooms
   * @param {object} payload
   * @returns {{ outcome: string, emitted: boolean, roomCount?: number, reasonCode?: string }}
   */
  static emitClientEvent(meta, rooms, payload) {
    const io = getSocketServer();
    const state = getSocketInfrastructureState();

    if (!io || ['degraded', 'stopped', 'stopping', 'starting', 'failed'].includes(state)) {
      logger.warn('RealtimePublisher: infrastructure unavailable, returning retryable_unavailable.', {
        eventId: meta.eventId,
        eventType: meta.eventType,
        state
      });
      return { 
        outcome: 'retryable_unavailable', 
        emitted: false, 
        reasonCode: 'realtime_infrastructure_unavailable' 
      };
    }

    if (!rooms || rooms.length === 0) {
      logger.info('RealtimePublisher: no rooms resolved, returning no_recipients.', {
        eventId: meta.eventId,
        eventType: meta.eventType
      });
      return { 
        outcome: 'no_recipients', 
        emitted: false, 
        reasonCode: 'no_logical_recipients' 
      };
    }

    const envelope = {
      eventId: meta.eventId,
      eventType: meta.eventType,
      eventVersion: meta.eventVersion,
      occurredAt: meta.occurredAt,
      data: payload
    };

    try {
      // Use .local to deliver directly to sockets on THIS node, bypassing Redis Pub/Sub.
      // Architecture: Dispatcher runs on every node (BullMQ workers). Each node delivers to
      // its own locally-connected clients. Redis is used for room membership tracking and
      // Dispatcher coordination — NOT for delivery fanout. This design is faster, simpler,
      // and avoids Pub/Sub async round-trip timing issues in single-process tests.
      const namespace = io.of(SOCKET_NAMESPACE);
      for (const room of rooms) {
        namespace.local.to(room).emit('realtime:event', envelope);
      }

      logger.info('RealtimePublisher: event emitted.', {
        eventId: meta.eventId,
        eventType: meta.eventType,
        roomCount: rooms.length
      });

      return { 
        outcome: 'emitted', 
        emitted: true, 
        roomCount: rooms.length 
      };
    } catch (err) {
      logger.error('RealtimePublisher: permanent failure emitting event.', {
        eventId: meta.eventId,
        eventType: meta.eventType,
        error: err.message
      });
      return { 
        outcome: 'permanent_failure', 
        emitted: false, 
        reasonCode: 'publisher_internal_error' 
      };
    }
  }
}
