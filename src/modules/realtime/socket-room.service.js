import { SocketRoomFactory } from './socket-room.factory.js';

export class SocketRoomService {
  /**
   * Applies the core room joining policy to a socket after successful authentication.
   * @param {import('socket.io').Socket} socket
   */
  static applyJoiningPolicy(socket) {
    const context = socket.data.context;
    if (!context) return;

    if (context.appType === 'customer') {
      // Customer specific room policy (Model B)
      if (context.sessionId) {
        socket.join(SocketRoomFactory.buildSessionRoom(context.sessionId));
      }
      const tenantRoomKey = context.washerId || context.applicationId;
      if (context.hasMembership && tenantRoomKey && context.identityId) {
        socket.join(SocketRoomFactory.buildAppIdentityRoom(tenantRoomKey, context.identityId));
      }
      return;
    }

    // Unconditional joins based on context existence (Staff Policy)
    if (context.sessionId) {
      socket.join(SocketRoomFactory.buildSessionRoom(context.sessionId));
    }
    
    if (context.identityId) {
      socket.join(SocketRoomFactory.buildIdentityRoom(context.identityId));
    }
    
    if (context.applicationId) {
      socket.join(SocketRoomFactory.buildApplicationRoom(context.applicationId));
    }

    // Conditional joins (Staff Policy)
    if (context.washerId) {
      socket.join(SocketRoomFactory.buildWasherRoom(context.washerId));
    }

    if (context.branchId) {
      socket.join(SocketRoomFactory.buildBranchRoom(context.branchId));
    }
  }
}
