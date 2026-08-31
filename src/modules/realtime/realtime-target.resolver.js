/**
 * Realtime Target Resolver
 *
 * Fetches the aggregate entity from the DB, validates it,
 * resolves the recipient identityIds, and translates them
 * to Socket.IO room names using SocketRoomFactory.
 *
 * It distinguishes between `client_event` and `internal_command`.
 */
import { SocketRoomFactory } from './socket-room.factory.js';
import { RealtimeEventRegistry } from './realtime-event.registry.js';

export class RealtimeTargetResolver {
  /**
   * Resolves the target rooms and payload for a realtime outbox event.
   * Or executes the internal command if eventKind === 'internal_command'.
   *
   * @param {{ eventType: string, eventVersion: number, eventKind: string, aggregateType: string, aggregateId: string, createdAt: Date }} outboxEvent
   * @param {import('@prisma/client').PrismaClient} prisma
   * @returns {Promise<{ isCommand: boolean, rooms?: string[], payload?: object }>}
   */
  static async resolve(outboxEvent, prisma) {
    const { eventType, eventVersion, eventKind, aggregateType, aggregateId, createdAt } = outboxEvent;

    const definition = RealtimeEventRegistry.getDefinition(eventType, eventVersion, eventKind);
    if (!definition) {
      if (RealtimeEventRegistry.getDefinition(eventType, 1, 'client_event') || RealtimeEventRegistry.getDefinition(eventType, 1, 'internal_command')) {
        // Exists under different version or kind
        throw Object.assign(new Error(`Invalid event kind or version for: ${eventType}`), {
          reasonCode: 'invalid_event_kind'
        });
      }
      throw Object.assign(new Error(`Unsupported event type: ${eventType}`), {
        reasonCode: 'unsupported_event_type'
      });
    }

    // Handle Internal Commands
    if (eventKind === 'internal_command') {
      definition.validateAggregate({ id: aggregateId }); // Pass minimal aggregate for commands
      await definition.executeCommand(aggregateId);
      return { isCommand: true };
    }

    // Handle Client Events
    const aggregate = await RealtimeTargetResolver._fetchAggregate(aggregateType, aggregateId, prisma);
    if (!aggregate) {
      throw Object.assign(new Error(`Aggregate not found: ${aggregateType}:${aggregateId}`), {
        reasonCode: 'aggregate_not_found'
      });
    }

    definition.validateAggregate(aggregate);

    const { identityIds, appIdentities, washerIds, branchIds } = await definition.resolveRecipients(aggregate, prisma);
    const rooms = [];

    // General identity rooms (e.g. for Staff who use the unified Dashboard)
    if (identityIds) {
      identityIds.filter(Boolean).forEach(id => rooms.push(SocketRoomFactory.buildIdentityRoom(id)));
    }

    // Strictly scoped app_identity rooms (e.g. for Customers to prevent cross-app leakage)
    if (appIdentities) {
      appIdentities.filter(Boolean).forEach(appIden => {
        if (appIden.applicationId && appIden.identityId) {
          rooms.push(SocketRoomFactory.buildAppIdentityRoom(appIden.applicationId, appIden.identityId));
        }
      });
    }

    if (washerIds) {
      washerIds.filter(Boolean).forEach(id => rooms.push(SocketRoomFactory.buildWasherRoom(id)));
    }
    if (branchIds) {
      branchIds.filter(Boolean).forEach(id => rooms.push(SocketRoomFactory.buildBranchRoom(id)));
    }

    // Deduplicate rooms safely
    const uniqueRooms = [...new Set(rooms)];

    const payloadData = definition.buildClientPayload(aggregate);

    // Validate: no sensitive fields anywhere recursively
    RealtimeTargetResolver._validatePayloadSafety(payloadData);

    return { isCommand: false, rooms: uniqueRooms, payload: payloadData };
  }

  /**
   * Fetches the aggregate entity from the DB.
   * @private
   */
  static async _fetchAggregate(aggregateType, aggregateId, prisma) {
    switch (aggregateType) {
      case 'StaffInvitation':
        return prisma.staffInvitation.findUnique({
          where: { id: aggregateId }
        });

      case 'StaffMembership':
        return prisma.staffMembership.findUnique({
          where: { id: aggregateId }
        });

      case 'Session': // If needed for other events
        return prisma.session.findUnique({
          where: { id: aggregateId }
        });

      case 'Order':
        return prisma.order.findUnique({
          where: { id: aggregateId }
        });

      case 'Payment':
        return prisma.payment.findUnique({
          where: { id: aggregateId }
        });

      case 'DriverTask':
        return prisma.driverTask.findUnique({
          where: { id: aggregateId }
        });

      default:
        throw Object.assign(new Error(`Unknown aggregateType: ${aggregateType}`), {
          reasonCode: 'unknown_aggregate_type'
        });
    }
  }

  /**
   * Validates that a client payload does NOT contain sensitive fields recursively.
   * Also blocks circular objects, full error objects, or oversized objects.
   * @private
   */
  static _validatePayloadSafety(payload, depth = 0, seen = new WeakSet()) {
    if (depth > 10) {
      throw Object.assign(new Error('Payload depth exceeds maximum allowed limits'), {
        reasonCode: 'unsafe_payload'
      });
    }

    const FORBIDDEN_KEYS = [
      'rawtoken', 'tokenhash', 'sessionid', 'fcmtoken',
      'phone', 'invitedphone', 'password', 'credentials', 
      'accesstoken', 'refreshtoken', 'redisurl', 'authorization', 'cookie'
    ];

    if (payload === null || typeof payload !== 'object') {
      return; // Safe primitive
    }

    if (payload instanceof Error) {
      throw Object.assign(new Error('Payload contains full Error object'), {
        reasonCode: 'unsafe_payload'
      });
    }

    if (seen.has(payload)) {
      throw Object.assign(new Error('Payload contains circular reference'), {
        reasonCode: 'unsafe_payload'
      });
    }
    seen.add(payload);

    for (const key of Object.keys(payload)) {
      const lowerKey = key.toLowerCase();
      
      // Strict exact forbidden key matching or contains check depending on strictness
      for (const forbidden of FORBIDDEN_KEYS) {
        if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
          throw Object.assign(new Error(`Payload contains forbidden field: ${key}`), {
            reasonCode: 'unsafe_payload'
          });
        }
      }

      const value = payload[key];
      if (typeof value === 'object' && value !== null) {
        RealtimeTargetResolver._validatePayloadSafety(value, depth + 1, seen);
      } else if (typeof value === 'function' || typeof value === 'symbol') {
        throw Object.assign(new Error(`Payload contains un-serializable type at: ${key}`), {
          reasonCode: 'unsafe_payload'
        });
      }
    }
  }
}
