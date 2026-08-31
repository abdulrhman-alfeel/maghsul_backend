export const RealtimeEventKeyFactory = {
  _validateId(id) {
    if (!id || typeof id !== 'string' || id.length > 50) {
      throw new Error(`Invalid aggregate ID for Realtime Event Key: ${id}`);
    }
  },

  _validateCount(count) {
    if (typeof count !== 'number' || count < 0) {
      throw new Error(`Invalid count for Realtime Event Key: ${count}`);
    }
  },

  // staff_invitation.created
  staffInvitationCreated(invitationId) {
    this._validateId(invitationId);
    return `realtime-staff-invitation-created-${invitationId}`;
  },

  // staff_invitation.resent
  staffInvitationResent(invitationId, resendCount) {
    this._validateId(invitationId);
    this._validateCount(resendCount);
    return `realtime-staff-invitation-resent-${invitationId}-${resendCount}`;
  },

  // staff_invitation.revoked
  staffInvitationRevoked(invitationId) {
    this._validateId(invitationId);
    return `realtime-staff-invitation-revoked-${invitationId}`;
  },

  // staff_invitation.accepted
  staffInvitationAccepted(invitationId) {
    this._validateId(invitationId);
    return `realtime-staff-invitation-accepted-${invitationId}`;
  },

  // staff_membership.activated
  staffMembershipActivated(membershipId) {
    this._validateId(membershipId);
    return `realtime-staff-membership-activated-${membershipId}`;
  },

  // internal_command: socket.session.disconnect
  socketSessionDisconnect(sessionId) {
    this._validateId(sessionId);
    return `realtime-socket-session-disconnect-${sessionId}`;
  },

  // internal_command: socket.identity.revalidate
  socketIdentityRevalidate(identityId, changeVersion) {
    this._validateId(identityId);
    this._validateCount(changeVersion);
    return `realtime-socket-identity-revalidate-${identityId}-${changeVersion}`;
  }
};
