/**
 * invitation-validity.validator.js
 *
 * Domain rules for determining whether a StaffInvitation is still in a
 * state that warrants sending a notification.
 *
 * Returns a typed result rather than throwing, so callers can decide
 * how to handle each outcome without catching exceptions for control flow.
 */

/** @typedef {'valid' | 'business_state_no_longer_applicable'} ValidityStatus */

/**
 * Check validity for created/resent notification events.
 * The invitation must:
 *  - belong to the washerId recorded in the outbox event
 *  - not be revoked
 *  - not be accepted
 *  - not be expired
 *  - not be superseded
 *  - still be in 'pending' status (the only status allowing resend/notification)
 *
 * @param {object} invitation  - Full StaffInvitation DB record
 * @param {string} washerId    - washerId from the outbox event (re-loaded from DB)
 * @returns {{ valid: boolean, reasonCode?: string }}
 */
export function validateForCreatedOrResent(invitation, washerId) {
  if (!invitation) {
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  if (invitation.washerId !== washerId) {
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  if (invitation.status !== 'pending') {
    // revoked, accepted, expired, superseded all disqualify
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  return { valid: true };
}

/**
 * Check validity for the accepted notification event.
 * The invitation must:
 *  - belong to the washerId recorded in the outbox event
 *  - have status 'accepted'
 *
 * @param {object} invitation - Full StaffInvitation DB record
 * @param {string} washerId   - washerId from the outbox event
 * @returns {{ valid: boolean, reasonCode?: string }}
 */
export function validateForAccepted(invitation, washerId) {
  if (!invitation) {
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  if (invitation.washerId !== washerId) {
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  if (invitation.status !== 'accepted') {
    return { valid: false, reasonCode: 'business_state_no_longer_applicable' };
  }

  return { valid: true };
}
