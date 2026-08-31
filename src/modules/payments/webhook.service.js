import crypto from 'crypto';
import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';

export function verifyMoyasarWebhookSecret(receivedToken) {
  const expectedSecret = process.env.MOYASAR_WEBHOOK_SECRET;
  if (!receivedToken || !expectedSecret) return false;
  const receivedBuf = Buffer.from(String(receivedToken), 'utf8');
  const expectedBuf = Buffer.from(String(expectedSecret), 'utf8');
  if (receivedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(receivedBuf, expectedBuf);
}

export function sanitizeWebhookPayload(rawBody) {
  if (!rawBody || typeof rawBody !== 'object') return {};
  const copy = JSON.parse(JSON.stringify(rawBody));
  delete copy.secret_token;
  delete copy.authorization;
  delete copy.token;
  return copy;
}

export function computePayloadHash(payload) {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(str).digest('hex');
}

const WebhookService = {
  /**
   * Fast Phase A: Receive, Authenticate, Sanitize & Persist Webhook Event
   */
  async receiveMoyasarWebhook(body) {
    const receivedToken = body?.secret_token;
    if (!verifyMoyasarWebhookSecret(receivedToken)) {
      throw new ApiError(401, 'unauthorized', 'Invalid or missing Moyasar webhook secret token');
    }

    const externalEventId = body?.id;
    if (!externalEventId || typeof externalEventId !== 'string') {
      throw new ApiError(400, 'invalid_payload', 'Missing external event ID');
    }

    const eventType = body?.type || 'unknown';
    const paymentExternalId = body?.data?.id || null;

    const sanitizedPayload = sanitizeWebhookPayload(body);
    const payloadHash = computePayloadHash(sanitizedPayload);

    try {
      const webhookEvent = await prisma.webhookEvent.create({
        data: {
          provider: 'moyasar',
          externalEventId,
          eventType,
          payloadHash,
          paymentExternalId,
          processingStatus: 'pending',
          rawPayload: sanitizedPayload
        }
      });

      return { received: true, duplicate: false, id: webhookEvent.id, externalEventId };
    } catch (err) {
      if (err.code === 'P2002') {
        // Unique constraint violation (duplicate webhook event)
        const existing = await prisma.webhookEvent.findUnique({
          where: { provider_externalEventId: { provider: 'moyasar', externalEventId } }
        });
        return { received: true, duplicate: true, id: existing?.id || null, externalEventId };
      }
      throw err;
    }
  }
};

export default WebhookService;
