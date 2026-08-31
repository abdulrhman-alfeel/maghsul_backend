import { TokenService } from './token.service.js';
import { SessionService } from './session.service.js';
import prisma from '../../../config/db.js';
import ApiError from '../../../helpers/apiError.js';
import { ApplicationRegistry, validateApplicationScope } from '../../../config/application.registry.js';

export const CanonicalSessionContextService = {
  async resolveSessionContext(rawToken) {
    if (!rawToken) {
      throw new ApiError(401, 'TOKEN_MISSING', 'Authorization header with Bearer token is required');
    }

    const claims = TokenService.verifyAccessToken(rawToken);

    const session = await prisma.session.findUnique({
      where: { id: claims.sessionId },
      include: { device: true }
    });

    if (!session) {
      throw new ApiError(401, 'SESSION_NOT_FOUND', 'Session does not exist');
    }

    if (!session.device) {
      throw new ApiError(401, 'DEVICE_NOT_FOUND', 'Session device not found');
    }

    const state = await SessionService.getSessionState(session.id);
    if (state === 'revoked' || session.isRevoked) {
      throw new ApiError(401, 'SESSION_REVOKED', 'الجلسة ملغاة');
    }

    if (session.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'الجلسة منتهية الصلاحية');
    }

    if (claims.identityId !== session.identityId) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token identity does not match session');
    }
    if (claims.sessionType !== session.sessionType) {
      throw new ApiError(401, 'TOKEN_SESSION_MISMATCH', 'Token session type does not match session');
    }

    // ApplicationRegistry revalidation
    const appScope = await validateApplicationScope(session.device.applicationId, session.device.appType);

    const identity = await prisma.identity.findUnique({ where: { id: session.identityId } });
    if (!identity || identity.status !== 'active') {
      throw new ApiError(401, 'IDENTITY_INACTIVE', 'Identity is inactive or does not exist');
    }

    const publicAuthContext = Object.freeze({
      identityId: session.identityId,
      sessionId: session.id,
      applicationId: session.device.applicationId,
      appType: session.device.appType
    });

    const internalState = Object.freeze({
      session: session,
      device: session.device,
      identity: identity,
      washerId: appScope.washerId
    });

    return { publicAuthContext, internalState };
  }
};
