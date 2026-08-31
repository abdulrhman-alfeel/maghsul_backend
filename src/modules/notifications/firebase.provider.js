/**
 * firebase.provider.js
 *
 * Firebase Cloud Messaging Provider with explicit lifecycle.
 *
 * Rules:
 *  - No Firebase initialisation on import.
 *  - start() is idempotent; only one App instance per provider.
 *  - stop() deletes the App created by this provider.
 *  - Credentials: Application Default Credentials (ADC).
 *    - In GCP: automatically resolved from the service account attached to the runtime.
 *    - Locally: set GOOGLE_APPLICATION_CREDENTIALS to the path of a service account JSON
 *      stored OUTSIDE the repository.
 *  - fcmToken values are NEVER returned to callers.
 *  - sendBatch accepts 1–500 targets. Splitting into batches is the caller's responsibility.
 *
 * Error classes:
 *  - invalid_device  : token is invalid or unregistered → caller should deactivate device
 *  - permanent       : message/config error → no retry, no device deactivation
 *  - transient       : server/rate error → BullMQ retry applies
 */

import { initializeApp, applicationDefault, getApp, deleteApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import logger from '../../config/logger.js';

const INVALID_DEVICE_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

const PERMANENT_CODES = new Set([
  'messaging/invalid-payload',
  'messaging/invalid-argument',
  'messaging/invalid-recipient',
  'messaging/mismatched-credential',
  'messaging/authentication-error',
  'messaging/invalid-apns-credentials',
  'messaging/sender-id-mismatch',
]);

const TRANSIENT_CODES = new Set([
  'messaging/server-unavailable',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
  'messaging/topics-message-rate-exceeded',
  'messaging/internal-error',
  'messaging/unknown-error',
]);

const MAX_BATCH_SIZE = 500;
const PROVIDER_APP_NAME = 'notification-provider-v2';

// ─── Retry-After extraction ──────────────────────────────────────────────────

/**
 * Safely extract retryAfterMs from a Firebase error's HTTP response headers.
 * Accepts "Retry-After: <seconds>" or "Retry-After: <HTTP-date>".
 * Clamps to [0, 24 hours].
 * @param {Error} err
 * @returns {number|undefined}
 */
function extractRetryAfterMs(err) {
  try {
    const headers = err?.httpResponse?.headers ?? err?.response?.headers;
    if (!headers) return undefined;

    const raw = headers['retry-after'] || headers['Retry-After'];
    if (!raw) return undefined;

    // Try seconds first (numeric string)
    const asSeconds = Number(raw);
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
      const ms = Math.floor(asSeconds) * 1000;
      return Math.min(ms, 86_400_000); // cap at 24h
    }

    // Try HTTP-date
    const asDate = new Date(raw).getTime();
    if (!Number.isNaN(asDate)) {
      const diff = asDate - Date.now();
      if (diff >= 0) return Math.min(diff, 86_400_000);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a Firebase error code into an errorClass.
 * @param {string} code
 * @returns {'invalid_device'|'permanent'|'transient'}
 */
function classifyError(code) {
  if (INVALID_DEVICE_CODES.has(code)) return 'invalid_device';
  if (PERMANENT_CODES.has(code)) return 'permanent';
  return 'transient'; // conservative default
}

// ─── Provider ────────────────────────────────────────────────────────────────

let _app = null; // Firebase App instance owned by this provider
let _messaging = null;

/**
 * Initialise the Firebase App. Idempotent.
 * Must be called before sendBatch.
 */
export async function start() {
  if (_app) return; // already initialised

  // Check if an app with this name already exists (unlikely, but guard)
  try {
    _app = getApp(PROVIDER_APP_NAME);
    logger.warn('firebase.provider: App already existed; reusing', { service: 'laundry-api' });
  } catch {
    // getApp throws if the named app does not exist — expected path
    _app = initializeApp(
      {
        credential: applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
      },
      PROVIDER_APP_NAME,
    );
    logger.info('firebase.provider: Firebase App initialised', { service: 'laundry-api' });
  }

  _messaging = getMessaging(_app);
}

/**
 * Shut down the Firebase App created by this provider.
 * Idempotent.
 */
export async function stop() {
  if (_app) {
    await _app.delete();
    _app = null;
    _messaging = null;
    logger.info('firebase.provider: Firebase App deleted', { service: 'laundry-api' });
  }
}

/**
 * Send a notification to a batch of 1–500 device targets.
 *
 * Callers MUST split large lists before calling this function.
 * Token values are consumed internally; they are NEVER included in the returned results.
 *
 * @param {Array<{deviceId: string, fcmToken: string}>} targets
 * @param {{ title: string, body: string, data?: Record<string,string> }} message
 * @returns {Promise<Array<{
 *   deviceId: string,
 *   success: boolean,
 *   providerMessageId?: string,
 *   errorCode?: string,
 *   errorClass?: 'invalid_device'|'permanent'|'transient',
 *   retryAfterMs?: number,
 * }>>}
 */
export async function sendBatch(targets, message) {
  if (!_messaging) {
    throw new Error('firebase.provider: not started — call start() before sendBatch()');
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('firebase.provider: targets must be a non-empty array');
  }

  if (targets.length > MAX_BATCH_SIZE) {
    throw new Error(
      `firebase.provider: sendBatch received ${targets.length} targets — maximum is ${MAX_BATCH_SIZE}. Split before calling.`,
    );
  }

  // Build one FCM message per target (preserving order for result mapping)
  const messages = targets.map(({ fcmToken }) => ({
    token: fcmToken,
    notification: {
      title: message.title,
      body: message.body,
    },
    data: message.data ?? {},
    android: { priority: 'high' },
    apns: { headers: { 'apns-priority': '10' } },
  }));

  const batchResponse = await _messaging.sendEach(messages);

  return batchResponse.responses.map((resp, idx) => {
    const { deviceId } = targets[idx];
    // fcmToken is NOT included in the result

    if (resp.success) {
      return {
        deviceId,
        success: true,
        providerMessageId: resp.messageId,
      };
    }

    const rawCode = resp.error?.code ?? 'messaging/unknown-error';
    const retryAfterMs = extractRetryAfterMs(resp.error);

    return {
      deviceId,
      success: false,
      errorCode: rawCode,
      errorClass: classifyError(rawCode),
      retryAfterMs,
    };
  });
}

let fakeProviderFactory = null;

export function setFakeProviderFactory(factoryFn) {
  fakeProviderFactory = factoryFn;
}

export function getFirebaseProvider() {
  if (fakeProviderFactory) {
    return fakeProviderFactory();
  }
  return {
    start,
    stop,
    sendBatch,
  };
}
