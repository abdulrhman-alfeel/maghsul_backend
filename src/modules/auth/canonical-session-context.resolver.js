import { TokenService } from './services/token.service.js';
import { SessionService } from './services/session.service.js';
import { validateApplicationScope } from '../../config/application.registry.js';
import prisma from '../../config/db.js';
import ApiError from '../../helpers/apiError.js';

export const CanonicalSessionContextResolver = {
  /**
   * Resolves and strict-validates a canonical context for Customer operations.
   * Ensures the session is operational, belongs to the token identity, is not revoked,
   * matches device application scope, and is an active registered customer application.
   * 
   * @param {Object} reqUser - The verified JWT claims (typically req.user or req.authContext)
   * @returns {Promise<Readonly<{identityId: string, sessionId: string, applicationId: string, appType: string}>>}
   */
  async resolveCustomerContext(reqUser) {
    if (!reqUser || !reqUser.sessionId || !reqUser.identityId) {
      throw new ApiError(401, 'MISSING_TOKEN_CLAIMS', 'Invalid or missing token claims');
    }

    // Must be 'operational' session in token claims
    if (reqUser.sessionType !== 'operational') {
      throw new ApiError(403, 'OPERATIONAL_SESSION_REQUIRED', 'Session type forbidden for this operation');
    }

    // Verify Session via DB
    const session = await prisma.session.findUnique({
      where: { id: reqUser.sessionId },
      include: {
        identity: true,
        device: true
      }
    });

    if (!session) {
      throw new ApiError(401, 'SESSION_NOT_FOUND', 'Session not found');
    }

    // Verify session belongs to token identity
    if (session.identityId !== reqUser.identityId) {
      throw new ApiError(403, 'IDENTITY_MISMATCH', 'Token identity does not match session');
    }

    // Verify session type in DB is operational
    if (session.sessionType !== 'operational') {
      throw new ApiError(403, 'OPERATIONAL_SESSION_REQUIRED', 'Session type forbidden');
    }

    // Check revocation (DB level)
    if (session.isRevoked) {
      throw new ApiError(401, 'SESSION_REVOKED', 'Session is revoked');
    }
    if (session.replacedBySessionId) {
      throw new ApiError(401, 'SESSION_REPLACED', 'Session has been replaced');
    }

    // Check expiry
    if (session.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired');
    }

    // Check Redis revocation state
    const state = await SessionService.getSessionState(session.id);
    if (state === 'revoked') {
      throw new ApiError(401, 'SESSION_REVOKED', 'Session is revoked');
    }

    // Verify Identity is active
    if (session.identity.status !== 'active') {
      throw new ApiError(403, 'IDENTITY_INACTIVE', 'Identity inactive');
    }

    // Device check
    if (!session.device) {
      throw new ApiError(403, 'DEVICE_REQUIRED', 'Session device not found');
    }

    // JWT/Device application scope matching
    if (reqUser.applicationId && (reqUser.applicationId !== session.device.applicationId)) {
      throw new ApiError(403, 'SCOPE_MISMATCH', 'Token application does not match session device');
    }
    if (reqUser.appType && (reqUser.appType !== session.device.appType)) {
      throw new ApiError(403, 'SCOPE_MISMATCH', 'Token appType does not match session device');
    }

    // Application Registry Revalidation
    let canonicalApplicationId;
    try {
      canonicalApplicationId = validateApplicationScope(session.device.applicationId, 'customer');
    } catch (error) {
      // Mapping registry errors to standard ApiErrors
      if (error.message.includes('Session application scope mismatch')) {
         throw new ApiError(403, 'FORBIDDEN_APPLICATION_TYPE', 'Staff application rejected for customer operation');
      } else if (error.message.includes('Disabled application')) {
         throw new ApiError(403, 'APPLICATION_DISABLED', 'Disabled application identifier');
      } else if (error.message.includes('Unknown bundle identifier')) {
         throw new ApiError(403, 'APPLICATION_UNKNOWN', 'Unknown application identifier');
      } else {
         throw new ApiError(403, 'APPLICATION_INVALID', error.message);
      }
    }

    if (session.device.appType !== 'customer') {
      throw new ApiError(403, 'FORBIDDEN_APPLICATION_TYPE', 'Only customer apps can perform this operation');
    }

    return Object.freeze({
      identityId: session.identityId,
      sessionId: session.id,
      applicationId: canonicalApplicationId,
      appType: 'customer',
    });
  }
};
};
