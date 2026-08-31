export const EventKeyFactory = {
  staffInvitationCreated: (invitationId) => `staff-invitation-created-${invitationId}`,
  staffInvitationAccepted: (invitationId) => `staff-invitation-accepted-${invitationId}`,
  staffInvitationResent: (invitationId, resendCount) => `staff-invitation-resent-${invitationId}-${resendCount}`,
};
