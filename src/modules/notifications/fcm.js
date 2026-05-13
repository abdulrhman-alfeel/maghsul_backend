import admin from 'firebase-admin';
import fs from 'fs';

let initialized = false;
let initError = null;

function init() {
  if (initialized || initError) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  if (!json && !path) {
    initError = new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH');
    return;
  }

  try {
    const raw = path ? fs.readFileSync(path, 'utf8') : json;
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
  } catch (e) {
    initError = e;
  }
}

export function isFcmConfigured() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
}

export async function sendSms(phone, message) { 
  logger.info('[SMS STUB] to %s: %s', phone, message); 
  return { success: true }; 
}

export async function sendPushToTokens(tokens, { title, body, data = {} }) {
  if (!tokens || tokens.length === 0) return { ok: true, sent: 0, invalidTokens: [] };
  if (!isFcmConfigured()) return { ok: false, sent: 0, invalidTokens: [], reason: 'FCM not configured' };

  init();
  if (!initialized) {
    logger.error('FCM: Initialization failed', { initError: initError?.message });
    return { ok: false, sent: 0, invalidTokens: [], reason: 'FCM init failed' };
  }

  const cleanTokens = Array.from(new Set(tokens.map((t) => String(t || '').trim()).filter(Boolean)));
  if (cleanTokens.length === 0) return { ok: true, sent: 0, invalidTokens: [] };

  const safeData = {};
  for (const [k, v] of Object.entries(data || {})) safeData[k] = v == null ? '' : String(v);

  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens: cleanTokens,
      notification: { title: String(title ?? ''), body: String(body ?? '') },
      data: safeData,
    });

    const invalidTokens = [];
    res.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (
          code.includes('messaging/registration-token-not-registered') ||
          code.includes('messaging/invalid-registration-token')
        ) {
          invalidTokens.push(cleanTokens[i]);
        }
      }
    });

    logger.info('FCM: Push notifications sent', { successCount: res.successCount, failureCount: res.failureCount });
    return { ok: true, sent: res.successCount, invalidTokens };
  } catch (error) {
    logger.error('FCM: Error sending push notifications', { error: error.message, stack: error.stack });
    return { ok: false, sent: 0, invalidTokens: [], reason: 'FCM send error' };
  }
}
