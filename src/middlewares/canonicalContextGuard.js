import prisma from '../config/db.js';
import { CanonicalSessionContextService } from '../modules/auth/services/canonical-session-context.service.js';
import ApiError from '../helpers/apiError.js';

export const CANONICAL_SESSION_SYM = Symbol.for('canonicalSession');

export async function canonicalContextGuard(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      throw new ApiError(401, 'TOKEN_MISSING', 'Authorization header with Bearer token is required');
    }

    const rawToken = header.slice(7);
    const { publicAuthContext, internalState } = await CanonicalSessionContextService.resolveSessionContext(rawToken);

    req.authContext = publicAuthContext;
    req[CANONICAL_SESSION_SYM] = internalState;

    next();
  } catch (err) {
    next(err);
  }
}

export async function requireCanonicalCustomerContext(req, res, next) {
  try {
    const internalState = req[CANONICAL_SESSION_SYM];
    if (!internalState || !req.authContext) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Missing authentication context');
    }

    const { session } = internalState;

    if (session.sessionType !== 'operational') {
      throw new ApiError(403, 'OPERATIONAL_SESSION_REQUIRED', 'This endpoint requires an operational session');
    }
    if (req.authContext.appType !== 'customer') {
      throw new ApiError(403, 'CUSTOMER_APP_REQUIRED', 'This endpoint requires a customer application scope');
    }

    // Exact washerId resolution: MUST come from X-Washer-Id header (via washerContext or direct validation)
    let validatedWasherId = req.washerContext?.washerId;

    if (!validatedWasherId) {
      const rawHeader = req.headers['x-washer-id'];
      if (!rawHeader || typeof rawHeader !== 'string' || !rawHeader.trim()) {
        throw new ApiError(400, 'WASHER_HEADER_REQUIRED', 'X-Washer-Id header is required');
      }
      const washerId = rawHeader.trim();
      const washer = await prisma.washer.findUnique({
        where: { id: washerId },
        select: { id: true, status: true, name: true }
      });
      if (!washer) {
        throw new ApiError(404, 'WASHER_NOT_FOUND', 'Washer not found');
      }
      if (washer.status !== 'active') {
        throw new ApiError(403, 'WASHER_INACTIVE', 'المغسلة غير مفعلة حالياً');
      }
      validatedWasherId = washer.id;
      req.washerContext = Object.freeze({ washerId: washer.id, washerName: washer.name });
    }

    // Build canonical customer context combining session identity + header washer
    req.customerContext = Object.freeze({
      identityId: req.authContext.identityId,
      sessionId: req.authContext.sessionId,
      washerId: validatedWasherId,
      appType: 'customer'
    });

    next();
  } catch (err) {
    next(err);
  }
}
