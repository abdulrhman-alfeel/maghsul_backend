import { SocketRoomFactory } from './socket-room.factory.js';
import { getSocketServer } from './socket-infrastructure.js';

export class SocketSessionControlService {
  /**
   * Disconnects all sockets attached to a specific session.
   * @param {string} sessionId
   */
  static async disconnectSession(sessionId) {
    const io = getSocketServer();
    if (!io) return;
    
    const room = SocketRoomFactory.buildSessionRoom(sessionId);
    // Disconnect all sockets in this room
    io.in(room).disconnectSockets(true);
  }

  /**
   * Disconnects all sockets attached to a specific identity.
   * @param {string} identityId
   */
  static async disconnectIdentity(identityId) {
    const io = getSocketServer();
    if (!io) return;
    
    const room = SocketRoomFactory.buildIdentityRoom(identityId);
    // Disconnect all sockets in this room
    io.in(room).disconnectSockets(true);
  }
}
