import { validateApplicationFormat } from '../../config/application.registry.js';

export class SocketRoomFactory {
  /**
   * Validates a general room segment (e.g. session, identity) to prevent injection.
   * @param {string} id - The identifier to validate.
   */
  static validateIdentityId(id) {
    if (!id || typeof id !== 'string') {
      throw new Error('Room identifier must be a non-empty string.');
    }
    if (id.length > 64) {
      throw new Error('Room identifier too long.');
    }
    // Strict alphanumeric with basic separators
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
      throw new Error('Room identifier contains invalid characters.');
    }
    // Prevent looking like a phone number (starts with + or contains many digits)
    if (/^\+?\d{8,}$/.test(id)) {
      throw new Error('Room identifier must not be a phone number.');
    }
  }

  static buildSessionRoom(sessionId) {
    this.validateIdentityId(sessionId);
    return `session:${sessionId}`;
  }

  static buildIdentityRoom(identityId) {
    this.validateIdentityId(identityId);
    return `identity:${identityId}`;
  }

  static buildApplicationRoom(applicationId) {
    validateApplicationFormat(applicationId);
    return `application:${applicationId}`;
  }

  static buildWasherRoom(washerId) {
    this.validateIdentityId(washerId);
    return `washer:${washerId}`;
  }

  static buildBranchRoom(branchId) {
    this.validateIdentityId(branchId);
    return `branch:${branchId}`;
  }

  static buildAppIdentityRoom(applicationId, identityId) {
    validateApplicationFormat(applicationId);
    this.validateIdentityId(identityId);
    return `app_identity:${applicationId}:${identityId}`;
  }
}
