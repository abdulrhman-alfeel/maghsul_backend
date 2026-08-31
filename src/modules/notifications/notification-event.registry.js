/**
 * notification-event.registry.js
 *
 * Central registry of notification event types.
 * Each entry defines:
 *  - eventType: string identifier (matches NotificationOutboxEvent.eventType)
 *  - payloadVersion: supported version(s) for this entry
 *  - templateKey: key used to look up message templates
 *  - channels: which delivery channels are required
 *  - resolveRecipients: async fn returning [{ identityId }]
 *  - buildMessage: fn(invitation, outboxEvent) → { title, body }
 *  - buildNavigationData: fn(invitation, outboxEvent) → safe data payload
 *
 * Data payload rules (strictly enforced in buildNavigationData):
 *  - Allowed: eventId, invitationId, eventType, washerId
 *  - NEVER include: rawToken, tokenHash, invitedPhone, fcmToken, sessionId,
 *                   accessToken, refreshToken, or any PII
 */

import prisma from '../../config/db.js';
import { normalizePhone } from '../../utils/phoneNormalizer.js';

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the Identity for the invited phone on created/resent events.
 * Returns [] if the phone is not registered (no Identity created).
 * @param {object} invitation - StaffInvitation DB record
 * @returns {Promise<Array<{identityId: string}>>}
 */
async function resolveInvitedPhoneRecipient(invitation) {
  const normalized = normalizePhone(invitation.phone);
  if (!normalized) return [];

  const identity = await prisma.identity.findUnique({
    where: { phone: normalized },
    select: { id: true },
  });

  return identity ? [{ identityId: identity.id }] : [];
}

/**
 * Resolve recipients for the accepted event:
 * 1. Use invitedByIdentityId (still an active washer member).
 * 2. Fall back to active managers/admins of the washer.
 * Deduplicates results.
 * @param {object} invitation - StaffInvitation DB record
 * @returns {Promise<Array<{identityId: string}>>}
 */
async function resolveAcceptedEventRecipients(invitation) {
  const candidates = new Map();

  // 1. Primary: invitedByIdentityId, only if still active member of the washer
  if (invitation.invitedByIdentityId) {
    const membership = await prisma.staffMembership.findFirst({
      where: {
        identityId: invitation.invitedByIdentityId,
        washerId: invitation.washerId,
        status: 'active',
      },
      select: { identityId: true },
    });
    if (membership) {
      candidates.set(membership.identityId, { identityId: membership.identityId });
    }
  }

  // 2. Fallback: active managers/admins if invitedBy is no longer valid
  if (candidates.size === 0) {
    const managers = await prisma.staffMembership.findMany({
      where: {
        washerId: invitation.washerId,
        status: 'active',
        role: { in: ['admin', 'manager'] },
      },
      select: { identityId: true },
    });
    for (const m of managers) {
      candidates.set(m.identityId, { identityId: m.identityId });
    }
  }

  return Array.from(candidates.values());
}

// ─── Message Builders ────────────────────────────────────────────────────────

function buildCreatedMessage(invitation) {
  return {
    title: 'دعوة للانضمام',
    body: `لديك دعوة للانضمام إلى فريق العمل.`,
  };
}

function buildResentMessage(invitation) {
  return {
    title: 'تذكير بالدعوة',
    body: `تذكير: لديك دعوة لم تستجب لها بعد.`,
  };
}

function buildAcceptedMessage(invitation) {
  return {
    title: 'قُبلت الدعوة',
    body: `تمت الموافقة على الانضمام إلى الفريق.`,
  };
}

// ─── Navigation Data Builders ────────────────────────────────────────────────

function buildStaffInvitationNavData(invitation, outboxEvent) {
  // STRICTLY NO: rawToken, tokenHash, invitedPhone, fcmToken, sessionId, accessToken, refreshToken
  return {
    eventId: outboxEvent.eventId,
    invitationId: invitation.id,
    eventType: outboxEvent.eventType,
    washerId: outboxEvent.washerId,
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new Map();

const STAFF_INVITATION_CREATED = {
  eventType: 'staff_invitation.created',
  payloadVersion: 1,
  templateKey: 'STAFF_INVITATION_CREATED',
  channels: { inbox: true, push: true },
  resolveRecipients: resolveInvitedPhoneRecipient,
  buildMessage: buildCreatedMessage,
  buildNavigationData: buildStaffInvitationNavData,
};

const STAFF_INVITATION_RESENT = {
  eventType: 'staff_invitation.resent',
  payloadVersion: 1,
  templateKey: 'STAFF_INVITATION_RESENT',
  channels: { inbox: true, push: true },
  resolveRecipients: resolveInvitedPhoneRecipient,
  buildMessage: buildResentMessage,
  buildNavigationData: buildStaffInvitationNavData,
};

const STAFF_INVITATION_ACCEPTED = {
  eventType: 'staff_invitation.accepted',
  payloadVersion: 1,
  templateKey: 'STAFF_INVITATION_ACCEPTED',
  channels: { inbox: true, push: true },
  resolveRecipients: resolveAcceptedEventRecipients,
  buildMessage: buildAcceptedMessage,
  buildNavigationData: buildStaffInvitationNavData,
};

registry.set(STAFF_INVITATION_CREATED.eventType, STAFF_INVITATION_CREATED);
registry.set(STAFF_INVITATION_RESENT.eventType, STAFF_INVITATION_RESENT);
registry.set(STAFF_INVITATION_ACCEPTED.eventType, STAFF_INVITATION_ACCEPTED);

/**
 * Look up an event registry entry.
 * @param {string} eventType
 * @returns {object|null}
 */
export function getEventRegistryEntry(eventType) {
  return registry.get(eventType) ?? null;
}

export const EVENT_TYPES = {
  STAFF_INVITATION_CREATED: 'staff_invitation.created',
  STAFF_INVITATION_RESENT: 'staff_invitation.resent',
  STAFF_INVITATION_ACCEPTED: 'staff_invitation.accepted',
};
