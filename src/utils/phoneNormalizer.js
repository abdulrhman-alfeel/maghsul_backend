/**
 * Normalizes a phone number to local format (9 digits for KSA).
 * Strips +966 / 00966 / leading 0.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  let phone = String(raw).trim().replace(/\s+/g, '').replace(/-/g, '');
  if (phone.startsWith('+966')) phone = phone.slice(4);
  else if (phone.startsWith('00966')) phone = phone.slice(5);
  if (phone.startsWith('0')) phone = phone.slice(1);
  // Must be digits only, 9 chars for KSA
  if (!/^\d{9}$/.test(phone)) return null;
  return phone;
}
