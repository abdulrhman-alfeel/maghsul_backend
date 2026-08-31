/**
 * inbox-key.factory.js
 *
 * Central factory for building the Inbox deduplication key.
 * Format: inbox-<eventId>-<recipientIdentityId>
 *
 * Contract:
 *  - eventId and recipientIdentityId must be non-empty strings.
 *  - Must never contain phone numbers, tokens, or session IDs.
 *  - Deterministic: same inputs → same output always.
 *  - Opaque prefix ("inbox-") distinguishes from other deduplication key namespaces.
 */

const FORBIDDEN_PATTERNS = [
  /^\+?9665\d{8}$/, // KSA phone
  /^\d{9,15}$/,     // any digit-only string (likely phone/token)
];

/**
 * @param {string} eventId   - Non-empty outbox eventId (cuid)
 * @param {string} recipientIdentityId - Non-empty identity id (cuid)
 * @returns {string}
 * @throws {Error} if either argument is invalid
 */
export function buildInboxDedupeKey(eventId, recipientIdentityId) {
  if (!eventId || typeof eventId !== 'string' || !eventId.trim()) {
    throw new Error('buildInboxDedupeKey: eventId must be a non-empty string');
  }
  if (!recipientIdentityId || typeof recipientIdentityId !== 'string' || !recipientIdentityId.trim()) {
    throw new Error('buildInboxDedupeKey: recipientIdentityId must be a non-empty string');
  }

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(eventId)) {
      throw new Error(`buildInboxDedupeKey: eventId looks like a phone number or sensitive value`);
    }
    if (pattern.test(recipientIdentityId)) {
      throw new Error(`buildInboxDedupeKey: recipientIdentityId looks like a phone number or sensitive value`);
    }
  }

  return `inbox-${eventId}-${recipientIdentityId}`;
}
