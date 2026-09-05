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

    // Build the specific customer context
    req.customerContext = Object.freeze({
      identityId: req.authContext.identityId,
      sessionId: req.authContext.sessionId,
      applicationId: req.authContext.applicationId,
      appType: 'customer',
      washerId: internalState.washerId || session.washerId || req.authContext?.washerId || null
    });

    next();
  } catch (err) {
    next(err);
  }
}
